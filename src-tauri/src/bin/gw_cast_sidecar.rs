//! gw_cast_sidecar — DLNA / UPnP "cast to TV" backend for the GhostWire Cast extension.
//!
//! A native sidecar (gw protocol: GW_EXT_TOKEN, binds 127.0.0.1:0, prints GW_SIDECAR_PORT, x-gw-token
//! on every non-/health request). It discovers DLNA MediaRenderers on the LAN via SSDP and pushes a
//! media URL to one via UPnP AVTransport SOAP (SetAVTransportURI + Play).
//!
//! Routes:
//!   GET  /health   → "ok"
//!   POST /discover → {} → { devices: [{ name, controlUrl }] }
//!   POST /cast     → { controlUrl, url, title? } → SetAVTransportURI + Play
//!   POST /stop     → { controlUrl } → Stop

use std::io::Write;
use std::net::UdpSocket;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone)]
struct AppState {
    token: Arc<String>,
}

#[tokio::main]
async fn main() {
    let token = std::env::var("GW_EXT_TOKEN").unwrap_or_default();
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/discover", post(discover))
        .route("/cast", post(cast))
        .route("/stop", post(stop))
        .with_state(AppState { token: Arc::new(token) });

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    println!("GW_SIDECAR_PORT={port}");
    let _ = std::io::stdout().flush();
    axum::serve(listener, app).await.expect("serve");
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    if state.token.is_empty() {
        return true;
    }
    headers.get("x-gw-token").and_then(|v| v.to_str().ok()).map(|t| t == state.token.as_str()).unwrap_or(false)
}

struct Renderer {
    name: String,
    control_url: String,
}

/// SSDP M-SEARCH for AVTransport renderers, then fetch each device description for its friendly name
/// + AVTransport control URL. Runs off the async runtime (blocking UDP + a short collection window).
async fn discover(State(st): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, (StatusCode, String)> {
    if !authorized(&st, &headers) {
        return Err((StatusCode::UNAUTHORIZED, "bad token".into()));
    }
    let locations = tokio::task::spawn_blocking(ssdp_search)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut devices = Vec::new();
    for loc in locations {
        if let Some(r) = describe(&client, &loc).await {
            devices.push(json!({ "name": r.name, "controlUrl": r.control_url }));
        }
    }
    Ok(Json(json!({ "devices": devices })))
}

fn ssdp_search() -> Result<Vec<String>, String> {
    use socket2::{Domain, Protocol, Socket, Type};

    // Query a few targets, not just AVTransport: many renderers answer `ssdp:all` or advertise the
    // MediaRenderer *device* type but not the AVTransport *service* in an M-SEARCH reply.
    const STS: [&str; 3] = [
        "ssdp:all",
        "urn:schemas-upnp-org:device:MediaRenderer:1",
        "urn:schemas-upnp-org:service:AVTransport:1",
    ];
    let group = std::net::Ipv4Addr::new(239, 255, 255, 250);
    let target = std::net::SocketAddr::from((group, 1900));

    // Send from EVERY non-loopback IPv4 interface (with its multicast egress pinned), so a VPN
    // tunnel or a secondary NIC can't swallow the multicast and hide the LAN's TVs.
    let mut socks: Vec<UdpSocket> = Vec::new();
    for ip in local_ipv4_ifaces() {
        let Ok(sock) = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)) else {
            continue;
        };
        let _ = sock.set_reuse_address(true);
        let bind_addr = std::net::SocketAddr::from((ip, 0));
        if sock.bind(&bind_addr.into()).is_err() {
            continue;
        }
        if !ip.is_unspecified() {
            let _ = sock.set_multicast_if_v4(&ip);
        }
        let _ = sock.set_multicast_ttl_v4(4);
        let _ = sock.set_read_timeout(Some(Duration::from_millis(150)));
        let udp: UdpSocket = sock.into();
        for st in STS {
            let msg = format!(
                "M-SEARCH * HTTP/1.1\r\n\
                 HOST: 239.255.255.250:1900\r\n\
                 MAN: \"ssdp:discover\"\r\n\
                 MX: 2\r\n\
                 ST: {st}\r\n\r\n"
            );
            // UDP is lossy — send each probe a couple of times.
            for _ in 0..2 {
                let _ = udp.send_to(msg.as_bytes(), target);
            }
        }
        socks.push(udp);
    }
    if socks.is_empty() {
        return Err("no usable network interface for discovery".into());
    }

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_millis(4000);
    let mut buf = [0u8; 2048];
    while std::time::Instant::now() < deadline {
        for udp in &socks {
            if let Ok((n, _)) = udp.recv_from(&mut buf) {
                let text = String::from_utf8_lossy(&buf[..n]);
                if let Some(loc) = header_value(&text, "location") {
                    if seen.insert(loc.clone()) {
                        out.push(loc);
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Every non-loopback IPv4 address on the host (one per usable NIC). Falls back to the unspecified
/// address (default interface) when enumeration fails or finds nothing.
fn local_ipv4_ifaces() -> Vec<std::net::Ipv4Addr> {
    let mut out: Vec<std::net::Ipv4Addr> = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(v4) = iface.ip() {
                if !out.contains(&v4) {
                    out.push(v4);
                }
            }
        }
    }
    if out.is_empty() {
        out.push(std::net::Ipv4Addr::UNSPECIFIED);
    }
    out
}

fn header_value(resp: &str, name: &str) -> Option<String> {
    for line in resp.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case(name) {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Fetch + parse a device description for its friendly name and AVTransport control URL.
async fn describe(client: &reqwest::Client, location: &str) -> Option<Renderer> {
    let xml = client.get(location).send().await.ok()?.text().await.ok()?;
    let doc = roxmltree::Document::parse(&xml).ok()?;
    let name = doc
        .descendants()
        .find(|n| n.tag_name().name() == "friendlyName")
        .and_then(|n| n.text())
        .unwrap_or("DLNA device")
        .to_string();
    // Find the AVTransport service node, then its controlURL.
    let service = doc.descendants().find(|n| {
        n.tag_name().name() == "service"
            && n.children().any(|c| c.tag_name().name() == "serviceType" && c.text().map_or(false, |t| t.contains("AVTransport")))
    })?;
    let control = service
        .children()
        .find(|c| c.tag_name().name() == "controlURL")
        .and_then(|c| c.text())?
        .to_string();
    let control_url = resolve_url(location, &control)?;
    Some(Renderer { name, control_url })
}

/// Resolve a (possibly relative) controlURL against the device-description base URL.
fn resolve_url(base: &str, rel: &str) -> Option<String> {
    if rel.starts_with("http://") || rel.starts_with("https://") {
        return Some(rel.to_string());
    }
    let b = reqwest::Url::parse(base).ok()?;
    b.join(rel).ok().map(|u| u.to_string())
}

#[derive(Deserialize)]
struct CastReq {
    #[serde(rename = "controlUrl")]
    control_url: String,
    url: String,
    title: Option<String>,
}

async fn cast(State(st): State<AppState>, headers: HeaderMap, Json(req): Json<CastReq>) -> Result<Json<Value>, (StatusCode, String)> {
    if !authorized(&st, &headers) {
        return Err((StatusCode::UNAUTHORIZED, "bad token".into()));
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let title = req.title.unwrap_or_else(|| "GhostWire".into());
    let meta = didl(&req.url, &title);
    let set_body = format!(
        "<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData></u:SetAVTransportURI>",
        xml_escape(&req.url), xml_escape(&meta)
    );
    soap(&client, &req.control_url, "SetAVTransportURI", &set_body).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    let play_body = "<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>";
    soap(&client, &req.control_url, "Play", play_body).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct StopReq {
    #[serde(rename = "controlUrl")]
    control_url: String,
}

async fn stop(State(st): State<AppState>, headers: HeaderMap, Json(req): Json<StopReq>) -> Result<Json<Value>, (StatusCode, String)> {
    if !authorized(&st, &headers) {
        return Err((StatusCode::UNAUTHORIZED, "bad token".into()));
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(6)).build().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let body = "<u:Stop xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID></u:Stop>";
    soap(&client, &req.control_url, "Stop", body).await.map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(json!({ "ok": true })))
}

async fn soap(client: &reqwest::Client, control_url: &str, action: &str, inner: &str) -> Result<(), String> {
    let envelope = format!(
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>{inner}</s:Body></s:Envelope>"
    );
    let resp = client
        .post(control_url)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPAction", format!("\"urn:schemas-upnp-org:service:AVTransport:1#{action}\""))
        .body(envelope)
        .send()
        .await
        .map_err(|e| format!("{action} request failed: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("{action} → {}", resp.status()))
    }
}

/// Minimal DIDL-Lite metadata so renderers that require it accept the URI.
fn didl(url: &str, title: &str) -> String {
    format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"-1\" restricted=\"1\"><dc:title>{}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo=\"http-get:*:video/mp4:*\">{}</res></item></DIDL-Lite>",
        xml_escape(title), xml_escape(url)
    )
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}
