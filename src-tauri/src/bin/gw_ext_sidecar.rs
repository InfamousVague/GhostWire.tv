//! gw-ext-sidecar — a reference GhostWire native-sidecar extension backend.
//!
//! This proves the second extension backend model: a standalone subprocess the app spawns, talks to
//! over loopback HTTP, and proxies via `ext_invoke`. It is NOT linked into the Tauri app — it's a
//! separate binary the sidecar manager launches.
//!
//! Protocol (the contract every GhostWire sidecar follows):
//!   • On start it reads `GW_EXT_TOKEN` from the environment, binds 127.0.0.1:0 (an OS-assigned free
//!     port), and prints `GW_SIDECAR_PORT=<port>` on stdout so the manager learns where to reach it.
//!   • Every request except `/health` must carry `x-gw-token: <GW_EXT_TOKEN>`.
//!   • `GET  /health` → "ok"
//!   • `POST /poll`   → fetch + parse the given RSS/Atom feeds, return new items not in `seen`.
//!
//! It does real work (fetching + parsing torrent feeds) so the path is exercised, not mocked.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

#[derive(Clone)]
struct AppState {
    token: Arc<String>,
}

#[derive(Deserialize)]
struct FeedSpec {
    url: String,
    #[serde(default)]
    filter: Option<String>,
}

#[derive(Deserialize)]
struct PollReq {
    #[serde(default)]
    feeds: Vec<FeedSpec>,
    #[serde(default)]
    seen: Vec<String>,
}

#[derive(Serialize)]
struct PollItem {
    title: String,
    magnet: String,
    guid: String,
    feed: String,
}

#[derive(Serialize)]
struct PollResp {
    items: Vec<PollItem>,
    checked: usize,
}

#[tokio::main]
async fn main() {
    let token = std::env::var("GW_EXT_TOKEN").unwrap_or_default();
    let state = AppState { token: Arc::new(token) };

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/poll", post(poll))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback");
    let port = listener.local_addr().expect("local addr").port();
    // The handshake line the manager waits for. Flush so it's delivered immediately.
    println!("GW_SIDECAR_PORT={port}");
    use std::io::Write;
    let _ = std::io::stdout().flush();

    axum::serve(listener, app).await.expect("serve");
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    if state.token.is_empty() {
        return true; // no token configured → open (manager always sets one in practice)
    }
    headers
        .get("x-gw-token")
        .and_then(|v| v.to_str().ok())
        .map(|t| t == state.token.as_str())
        .unwrap_or(false)
}

async fn poll(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PollReq>,
) -> Result<Json<PollResp>, StatusCode> {
    if !authorized(&state, &headers) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let seen: HashSet<String> = req.seen.into_iter().collect();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("GhostWire-Sidecar/1.0")
        .build()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut items = Vec::new();
    let mut checked = 0usize;
    for feed in &req.feeds {
        checked += 1;
        let feed_label = host_of(&feed.url);
        let xml = match client.get(&feed.url).send().await {
            Ok(r) => match r.text().await {
                Ok(t) => t,
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        let filter = feed
            .filter
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .and_then(|s| regex::RegexBuilder::new(s).case_insensitive(true).build().ok());
        parse_feed(&xml, &seen, filter.as_ref(), &feed_label, &mut items);
    }
    Ok(Json(PollResp { items, checked }))
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| url.to_string())
}

/// Pull new magnet-bearing items out of an RSS/Atom document.
fn parse_feed(
    xml: &str,
    seen: &HashSet<String>,
    filter: Option<&regex::Regex>,
    feed_label: &str,
    out: &mut Vec<PollItem>,
) {
    let Ok(doc) = roxmltree::Document::parse(xml) else { return };
    for item in doc
        .descendants()
        .filter(|n| matches!(n.tag_name().name(), "item" | "entry"))
    {
        let title = child_text(item, "title").unwrap_or_else(|| "Untitled".into());
        let Some(magnet) = magnet_of(item) else { continue };
        let guid = child_text(item, "guid")
            .or_else(|| child_text(item, "link"))
            .unwrap_or_else(|| magnet.clone());
        if seen.contains(&guid) {
            continue;
        }
        if let Some(re) = filter {
            if !re.is_match(&title) {
                continue;
            }
        }
        out.push(PollItem { title, magnet, guid, feed: feed_label.to_string() });
    }
}

fn child_text(node: roxmltree::Node, name: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.tag_name().name() == name)
        .and_then(|c| c.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn magnet_of(item: roxmltree::Node) -> Option<String> {
    let is_magnet = |s: &str| s.trim().to_ascii_lowercase().starts_with("magnet:");
    for node in item.descendants() {
        if !node.is_element() {
            continue;
        }
        let name = node.tag_name().name();
        // <enclosure url="magnet:…">
        if name == "enclosure" {
            if let Some(u) = node.attribute("url") {
                if is_magnet(u) {
                    return Some(u.to_string());
                }
            }
        }
        // <link>magnet:…</link> or <link href="magnet:…"/>
        if name == "link" {
            if let Some(h) = node.attribute("href") {
                if is_magnet(h) {
                    return Some(h.to_string());
                }
            }
            if let Some(t) = node.text() {
                if is_magnet(t) {
                    return Some(t.trim().to_string());
                }
            }
        }
        // namespaced <torrent:magnetURI>, Torznab <torznab:attr name="magneturl" value="magnet:…"/>
        if name.eq_ignore_ascii_case("magnetURI") || name.eq_ignore_ascii_case("magneturl") {
            if let Some(t) = node.text() {
                if is_magnet(t) {
                    return Some(t.trim().to_string());
                }
            }
        }
        if name == "attr" && node.attribute("name") == Some("magneturl") {
            if let Some(v) = node.attribute("value") {
                if is_magnet(v) {
                    return Some(v.to_string());
                }
            }
        }
        // any element whose text is a magnet (guid isPermaLink, etc.)
        if let Some(t) = node.text() {
            if is_magnet(t) {
                return Some(t.trim().to_string());
            }
        }
    }
    None
}
