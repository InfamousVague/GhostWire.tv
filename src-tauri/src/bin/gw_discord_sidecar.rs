//! gw_discord_sidecar — Discord Rich Presence backend for the GhostWire "Discord Presence" extension.
//!
//! A native sidecar (same protocol as gw_ext_sidecar: reads GW_EXT_TOKEN, binds 127.0.0.1:0, prints
//! `GW_SIDECAR_PORT=<port>`, every non-/health request carries `x-gw-token`). It connects to the
//! local Discord IPC socket and pushes "Rich Presence" activity (what you're watching).
//!
//! Routes:
//!   GET  /health → "ok"
//!   POST /set    → { clientId, details?, state?, largeImage?, largeText? } sets the activity
//!   POST /clear  → clears the activity
//!
//! Unix-socket IPC (macOS/Linux). Windows (named pipe) is a follow-up; the bundled binary here is
//! built per-OS by the release pipeline.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[derive(Clone)]
struct AppState {
    token: Arc<String>,
    #[cfg(unix)]
    conn: Arc<Mutex<Option<UnixStream>>>,
    client_id: Arc<Mutex<String>>,
}

#[tokio::main]
async fn main() {
    let token = std::env::var("GW_EXT_TOKEN").unwrap_or_default();
    let state = AppState {
        token: Arc::new(token),
        #[cfg(unix)]
        conn: Arc::new(Mutex::new(None)),
        client_id: Arc::new(Mutex::new(String::new())),
    };

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/set", post(set_activity))
        .route("/clear", post(clear_activity))
        .with_state(state);

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
    headers
        .get("x-gw-token")
        .and_then(|v| v.to_str().ok())
        .map(|t| t == state.token.as_str())
        .unwrap_or(false)
}

#[derive(Deserialize)]
struct SetReq {
    #[serde(rename = "clientId")]
    client_id: String,
    details: Option<String>,
    state: Option<String>,
    #[serde(rename = "largeImage")]
    large_image: Option<String>,
    #[serde(rename = "largeText")]
    large_text: Option<String>,
}

/// Trim + drop empty optional strings — Discord rejects an activity that carries null/empty fields.
fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

async fn set_activity(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SetReq>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if !authorized(&st, &headers) {
        return Err((StatusCode::UNAUTHORIZED, "bad token".into()));
    }
    if non_empty(Some(req.client_id.clone())).is_none() {
        return Err((StatusCode::BAD_REQUEST, "missing Application (Client) ID".into()));
    }
    // Build the activity by including ONLY the fields we actually have. Discord's SET_ACTIVITY
    // silently drops the whole presence if it carries null fields — and an `assets` object with a
    // null `large_image` but a non-null `large_text` (what the old code always sent) is exactly such
    // a malformed payload. Rich-presence art also requires assets UPLOADED to the app in the Dev
    // Portal and referenced by key, which this extension doesn't use, so we omit `assets` entirely
    // unless a real `large_image` key is supplied. The minimal valid presence is "Playing <AppName>"
    // (the app's name from the Dev Portal) with our details/state lines beneath it.
    let mut activity = serde_json::Map::new();
    if let Some(d) = non_empty(req.details) {
        activity.insert("details".into(), json!(d));
    }
    if let Some(s) = non_empty(req.state) {
        activity.insert("state".into(), json!(s));
    }
    if let Some(img) = non_empty(req.large_image) {
        let mut assets = serde_json::Map::new();
        assets.insert("large_image".into(), json!(img));
        if let Some(t) = non_empty(req.large_text) {
            assets.insert("large_text".into(), json!(t));
        }
        activity.insert("assets".into(), Value::Object(assets));
    }
    activity.insert("timestamps".into(), json!({ "start": now_secs() }));
    apply(st, req.client_id, Some(Value::Object(activity))).await
}

async fn clear_activity(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    if !authorized(&st, &headers) {
        return Err((StatusCode::UNAUTHORIZED, "bad token".into()));
    }
    let cid = st.client_id.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if cid.is_empty() {
        return Ok(Json(json!({ "ok": true })));
    }
    apply(st, cid, None).await
}

#[cfg(unix)]
async fn apply(st: AppState, client_id: String, activity: Option<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let res = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut conn = st.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut cid = st.client_id.lock().unwrap_or_else(|e| e.into_inner());
        if conn.is_none() || *cid != client_id {
            *conn = Some(connect(&client_id).map_err(|e| e.to_string())?);
            *cid = client_id.clone();
        }
        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "nonce": format!("{}", now_nanos()),
            "args": { "pid": std::process::id(), "activity": activity },
        });
        let s = conn.as_mut().unwrap();
        if write_frame(s, 1, &payload).is_err() {
            // stale pipe → reconnect once
            *conn = Some(connect(&client_id).map_err(|e| e.to_string())?);
            write_frame(conn.as_mut().unwrap(), 1, &payload).map_err(|e| e.to_string())?;
        }
        // Read Discord's reply and SURFACE an error instead of always reporting success. Discord
        // answers SET_ACTIVITY with a frame whose `evt` is "ERROR" (with data.message) when the
        // activity is malformed or the Application ID is unknown — previously this was discarded, so
        // a rejected presence looked like a success and the user saw nothing with no explanation.
        if let Ok((_op, reply)) = read_frame(conn.as_mut().unwrap()) {
            if reply.get("evt").and_then(|v| v.as_str()) == Some("ERROR") {
                let msg = reply
                    .get("data")
                    .and_then(|d| d.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Discord rejected the activity");
                return Err(msg.to_string());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    res.map(|_| Json(json!({ "ok": true })))
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}

#[cfg(not(unix))]
async fn apply(_st: AppState, _client_id: String, _activity: Option<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    Err((StatusCode::NOT_IMPLEMENTED, "Discord IPC is unix-only in this build".into()))
}

#[cfg(unix)]
fn connect(client_id: &str) -> std::io::Result<UnixStream> {
    let path = ipc_path().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "Discord IPC socket not found (is Discord running?)")
    })?;
    let mut s = UnixStream::connect(path)?;
    // Don't let a missing reply hang the blocking worker forever.
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    write_frame(&mut s, 0, &json!({ "v": 1, "client_id": client_id }))?; // HANDSHAKE
    // Discord answers the handshake with DISPATCH/READY on success, or an ERROR frame for an unknown
    // Application ID. Surface that so a wrong/empty ID gives a clear message instead of silent nothing.
    let (_op, reply) = read_frame(&mut s)?;
    if reply.get("evt").and_then(|v| v.as_str()) == Some("ERROR") {
        let msg = reply
            .get("data")
            .and_then(|d| d.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("Discord rejected the connection — check the Application ID");
        return Err(std::io::Error::new(std::io::ErrorKind::Other, msg.to_string()));
    }
    Ok(s)
}

#[cfg(unix)]
fn ipc_path() -> Option<String> {
    let mut roots: Vec<String> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .collect();
    roots.push("/tmp".into());
    for root in roots {
        let root = root.trim_end_matches('/');
        for i in 0..10 {
            // Flatpak/snap nest the socket under app subdirs; check both layouts.
            for cand in [format!("{root}/discord-ipc-{i}"), format!("{root}/app/com.discordapp.Discord/discord-ipc-{i}")] {
                if std::path::Path::new(&cand).exists() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

#[cfg(unix)]
fn write_frame(s: &mut UnixStream, op: u32, payload: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(payload)?;
    let mut buf = Vec::with_capacity(8 + body.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(body.len() as u32).to_le_bytes());
    buf.extend_from_slice(&body);
    s.write_all(&buf)?;
    s.flush()
}

#[cfg(unix)]
fn read_frame(s: &mut UnixStream) -> std::io::Result<(u32, Value)> {
    let mut header = [0u8; 8];
    s.read_exact(&mut header)?;
    let op = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    let mut body = vec![0u8; len.min(1 << 20)];
    s.read_exact(&mut body)?;
    let val: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    Ok((op, val))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
fn now_nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}
