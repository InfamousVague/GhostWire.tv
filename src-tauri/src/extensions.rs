//! Extension backend host.
//!
//! JS extensions don't run a separate process — their logic runs in the webview and reaches the
//! network through `ext_fetch`, a permissioned host-fetch: the request is made server-side via the
//! app's HTTP client (no CORS, the app's IP/VPN), but ONLY to hosts the extension's manifest
//! declared. The frontend registers each enabled extension's declared network allowlist on
//! activation (`ext_set_perms`); `ext_fetch` enforces it.
//!
//! Native sidecar extensions are the other backend model: the app spawns a declared binary, learns
//! the loopback port it bound from a stdout handshake, health-checks it, and proxies calls to it via
//! `ext_invoke`. Every request carries a per-process shared token so nothing else on the box can talk
//! to it. The reference sidecar is the `gw_ext_sidecar` binary (a real RSS poller). Production
//! bundling of an extension's sidecar binary (Tauri `externalBin`, per-OS triples) lands with the
//! marketplace installer (Phase 4); `ext_sidecar_selftest` exercises the whole path today.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::catalog::Catalog;
use crate::AppInfo;

// ============================================================================================
// Extension store — the backend is the source of truth for which extensions exist + their source.
// Builtins are embedded at compile time; installed extensions live under data_dir/extensions/<id>/.
// ============================================================================================

/// A compile-time-embedded builtin extension: id + manifest JSON text + source JS text.
struct BuiltinExt {
    id: &'static str,
    manifest: &'static str,
    source: &'static str,
}

macro_rules! builtin {
    ($id:literal) => {
        BuiltinExt {
            id: $id,
            // Paths are relative to THIS file (src-tauri/src/extensions.rs); a wrong path fails the build.
            manifest: include_str!(concat!("../../extensions/", $id, "/extension.json")),
            source: include_str!(concat!("../../extensions/", $id, "/index.js")),
        }
    };
}

static BUILTINS: &[BuiltinExt] = &[
    builtin!("prowlarr-bridge"),
    builtin!("rss-auto"),
    builtin!("subtitle-fetcher"),
    builtin!("trakt-sync"),
    builtin!("pip"),
    builtin!("sleep-timer"),
    builtin!("subtitle-translator"),
    builtin!("anilist-sync"),
    builtin!("discord-presence"),
    builtin!("spotiflac"),
    builtin!("spotimirror"),
    builtin!("seance"),
    // Watch Later, Continue Watching, Theme & Accent, and Cast to TV are now baked into the app
    // natively (no longer extensions); the gw_cast_sidecar binary stays bundled for native casting.
];

const EXT_BUNDLE_MAX: u64 = 2 * 1024 * 1024; // 2 MiB cap on a downloaded extension bundle

/// One extension the frontend should load: id, parsed manifest, source, where it came from, enabled.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtEntry {
    pub id: String,
    pub manifest: serde_json::Value,
    pub source: String,
    pub origin: &'static str, // "builtin" | "installed"
    pub enabled: bool,
}

/// A downloadable extension bundle: the manifest + the single-file source.
#[derive(Deserialize)]
struct ExtBundle {
    manifest: serde_json::Value,
    source: String,
}

/// An extension id must be a safe single path segment: lowercase ascii / digits / - / _, no
/// separators or dots, so a crafted id can never escape data_dir/extensions/.
fn safe_ext_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn disabled_ids(catalog: &Catalog) -> Vec<String> {
    catalog
        .get_setting("ext:disabled")
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

/// The unified extension list: embedded builtins (listed first, win on id clash) + any installed
/// extensions under data_dir/extensions/<id>/. `enabled` comes from the shared `ext:disabled` setting.
#[tauri::command]
pub fn ext_list(catalog: tauri::State<'_, Catalog>, info: tauri::State<'_, AppInfo>) -> Vec<ExtEntry> {
    let disabled = disabled_ids(&catalog);
    let is_enabled = |id: &str| !disabled.iter().any(|d| d == id);

    let mut out: Vec<ExtEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for b in BUILTINS {
        if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(b.manifest) {
            seen.insert(b.id.to_string());
            out.push(ExtEntry {
                id: b.id.to_string(),
                manifest,
                source: b.source.to_string(),
                origin: "builtin",
                enabled: is_enabled(b.id),
            });
        }
    }

    let root = std::path::Path::new(&info.data_dir).join("extensions");
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let id = e.file_name().to_string_lossy().to_string();
            if id.is_empty() || seen.contains(&id) {
                continue; // a builtin always wins; an installed dir can't shadow it
            }
            let dir = e.path();
            let (Ok(mtxt), Ok(src)) = (
                std::fs::read_to_string(dir.join("extension.json")),
                std::fs::read_to_string(dir.join("index.js")),
            ) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&mtxt) else { continue };
            out.push(ExtEntry { id: id.clone(), manifest, source: src, origin: "installed", enabled: is_enabled(&id) });
        }
    }
    out
}

/// Install an extension from a URL pointing at a `{ "manifest": {...}, "source": "..." }` JSON bundle.
/// Validates size + manifest shape + a safe id, refuses to overwrite a builtin, and writes
/// data_dir/extensions/<id>/. (Trust is integrity, not authenticity — signing lands in Phase 4.)
#[tauri::command]
pub async fn ext_install_from_url(info: tauri::State<'_, AppInfo>, url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("bad url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) URLs are allowed".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("GhostWire-Extension/1.0")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(parsed).send().await.map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len > EXT_BUNDLE_MAX {
            return Err("extension bundle is too large".into());
        }
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
    if bytes.len() as u64 > EXT_BUNDLE_MAX {
        return Err("extension bundle is too large".into());
    }
    let bundle: ExtBundle = serde_json::from_slice(&bytes).map_err(|e| format!("invalid bundle: {e}"))?;

    let id = bundle
        .manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("manifest is missing an id")?
        .to_string();
    if !safe_ext_id(&id) {
        return Err("manifest id has illegal characters".into());
    }
    for k in ["name", "version"] {
        if !bundle.manifest.get(k).map(|v| v.is_string()).unwrap_or(false) {
            return Err(format!("manifest is missing a string '{k}'"));
        }
    }
    if BUILTINS.iter().any(|b| b.id == id) {
        return Err("cannot overwrite a built-in extension".into());
    }
    if bundle.source.trim().is_empty() {
        return Err("bundle has an empty source".into());
    }

    let root = std::path::Path::new(&info.data_dir).join("extensions");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let dir = root.join(&id);
    if !dir.starts_with(&root) {
        return Err("path traversal rejected".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let manifest_txt = serde_json::to_string_pretty(&bundle.manifest).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("extension.json"), manifest_txt).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("index.js"), bundle.source).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Remove an installed extension's directory. Builtins can't be removed (only disabled).
#[tauri::command]
pub fn ext_remove(info: tauri::State<'_, AppInfo>, id: String) -> Result<(), String> {
    if BUILTINS.iter().any(|b| b.id == id) {
        return Err("built-in extensions can't be removed — disable it instead".into());
    }
    if !safe_ext_id(&id) {
        return Err("illegal id".into());
    }
    let root = std::path::Path::new(&info.data_dir).join("extensions");
    let dir = root.join(&id);
    if !dir.starts_with(&root) {
        return Err("path traversal rejected".into());
    }
    if !dir.is_dir() {
        return Err("not installed".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(())
}

/// Per-extension network allowlist (host suffixes, or "*" for any). Registered by the frontend from
/// each extension's manifest as it activates; cleared/replaced on toggle. For installed (Phase 4)
/// extensions the manifest is signature-verified before its perms are trusted.
fn perms() -> &'static Mutex<HashMap<String, Vec<String>>> {
    static P: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn ext_set_perms(id: String, hosts: Vec<String>) {
    perms()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, hosts);
}

/// Is `url`'s host permitted for extension `id`? "*" allows any; otherwise the host must equal or be
/// a subdomain of a declared entry.
fn host_allowed(id: &str, url: &reqwest::Url) -> bool {
    let host = match url.host_str() {
        Some(h) => h.to_ascii_lowercase(),
        None => return false,
    };
    let guard = perms().lock().unwrap_or_else(|e| e.into_inner());
    let Some(list) = guard.get(id) else { return false };
    list.iter().any(|h| {
        let h = h.trim().to_ascii_lowercase();
        h == "*" || host == h || host.ends_with(&format!(".{h}"))
    })
}

/// Did extension `id` declare this EXACT host (not via "*")? Used to gate loopback: a self-hosted
/// indexer on localhost is reachable only when the manifest names it literally, so a blanket "*"
/// permission can never reach the user's loopback services by accident.
fn host_explicitly_allowed(id: &str, host: &str) -> bool {
    let guard = perms().lock().unwrap_or_else(|e| e.into_inner());
    let Some(list) = guard.get(id) else { return false };
    list.iter().any(|h| h.trim().to_ascii_lowercase() == host)
}

#[derive(Deserialize)]
pub struct ExtFetchReq {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
    /// When true the response body is returned base64-encoded (for binary payloads — gzipped
    /// subtitles, images, etc.). The frontend's gw.fetch decodes it via `.bytes()`.
    #[serde(default)]
    pub binary: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtFetchResp {
    pub status: u16,
    pub ok: bool,
    pub body: String,
    /// True when `body` is base64-encoded raw bytes (binary request).
    pub base64: bool,
    pub content_type: Option<String>,
}

/// Permissioned host-fetch for a JS extension. Only http(s) URLs whose host is in the extension's
/// declared allowlist are permitted; localhost/loopback is always refused (extensions can't reach
/// the app's own private services this way). Returns the response body as text.
#[tauri::command]
pub async fn ext_fetch(id: String, req: ExtFetchReq) -> Result<ExtFetchResp, String> {
    let url = reqwest::Url::parse(&req.url).map_err(|e| format!("bad url: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http(s) URLs are allowed".into());
    }
    // Link-local / metadata (169.254.*, 0.0.0.0) is NEVER reachable — those are cloud-metadata and
    // wildcard-bind addresses an extension has no business hitting. Loopback (localhost/127.*/::1) is
    // refused too UNLESS the extension declared that exact host (self-hosted Prowlarr/Jackett); a
    // blanket "*" permission does not unlock loopback.
    if let Some(host) = url.host_str() {
        let h = host.to_ascii_lowercase();
        if h.starts_with("169.254.") || h == "0.0.0.0" {
            return Err("requests to link-local / metadata addresses are not allowed".into());
        }
        let is_loopback = h == "localhost" || h.starts_with("127.") || h == "::1";
        if is_loopback && !host_explicitly_allowed(&id, &h) {
            return Err("requests to localhost require the extension to declare that host explicitly".into());
        }
    }
    if !host_allowed(&id, &url) {
        return Err(format!("extension '{id}' is not permitted to reach {}", url.host_str().unwrap_or("?")));
    }

    let method = req.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("GhostWire-Extension/1.0")
        .build()
        .map_err(|e| e.to_string())?;
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = client.request(m, url);
    if let Some(hs) = req.headers {
        for (k, v) in hs {
            rb = rb.header(k, v);
        }
    }
    if let Some(b) = req.body {
        rb = rb.body(b);
    }
    let resp = rb.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let want_binary = req.binary.unwrap_or(false);
    if want_binary {
        use base64::Engine as _;
        let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
        let body = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(ExtFetchResp { status: status.as_u16(), ok: status.is_success(), body, base64: true, content_type })
    } else {
        let body = resp.text().await.map_err(|e| format!("read body: {e}"))?;
        Ok(ExtFetchResp { status: status.as_u16(), ok: status.is_success(), body, base64: false, content_type })
    }
}

// ============================================================================================
// Native sidecar manager
// ============================================================================================

/// A running sidecar subprocess: the child handle, the loopback port it bound, and the per-process
/// shared token every request must present.
struct SidecarProc {
    child: Child,
    port: u16,
    token: String,
}

fn sidecars() -> &'static Mutex<HashMap<String, SidecarProc>> {
    static S: OnceLock<Mutex<HashMap<String, SidecarProc>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A loopback-only shared secret for one sidecar process. Derived from the id + a high-resolution
/// timestamp — it never leaves the machine, so it only needs to be unguessable to other local procs.
fn gen_token(id: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{id}-{nanos:x}")
}

/// Find a bundled sidecar binary next to the app executable (Tauri `externalBin` lands it in the same
/// dir), falling back to the dev build sitting alongside the app's own binary in `target/<profile>/`.
fn resolve_sidecar_bin(name: &str) -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidates = if cfg!(windows) {
        vec![dir.join(format!("{name}.exe"))]
    } else {
        vec![dir.join(name)]
    };
    candidates.into_iter().find(|p| p.exists())
}

/// Spawn a sidecar binary, wait for its `GW_SIDECAR_PORT=` handshake, and health-check it. Idempotent
/// per id (a second call returns the already-running port).
#[tauri::command]
pub async fn ext_start_sidecar(id: String, bin: String, args: Vec<String>) -> Result<u16, String> {
    {
        let guard = sidecars().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = guard.get(&id) {
            return Ok(p.port);
        }
    }
    let token = gen_token(&id);
    let token_for_spawn = token.clone();
    // Spawn + the blocking stdout handshake read run off the async runtime.
    let (child, port) = tokio::task::spawn_blocking(move || -> Result<(Child, u16), String> {
        let mut child = Command::new(&bin)
            .args(&args)
            .env("GW_EXT_TOKEN", &token_for_spawn)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn {bin}: {e}"))?;
        let stdout = child.stdout.take().ok_or("sidecar produced no stdout")?;
        let (tx, rx) = std::sync::mpsc::channel::<u16>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("GW_SIDECAR_PORT=") {
                    if let Ok(p) = rest.trim().parse::<u16>() {
                        let _ = tx.send(p);
                    }
                    break;
                }
            }
        });
        match rx.recv_timeout(Duration::from_secs(8)) {
            Ok(p) => Ok((child, p)),
            Err(_) => {
                let _ = child.kill();
                Err("sidecar did not report a port within 8s".into())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    if !wait_health(port, &token).await {
        let mut c = child;
        let _ = c.kill();
        return Err("sidecar failed its health check".into());
    }
    sidecars()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, SidecarProc { child, port, token });
    Ok(port)
}

async fn wait_health(port: u16, token: &str) -> bool {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(2)).build() {
        Ok(c) => c,
        Err(_) => return false,
    };
    for _ in 0..25 {
        if let Ok(r) = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .header("x-gw-token", token)
            .send()
            .await
        {
            if r.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Proxy a call to a running sidecar: `POST http://127.0.0.1:<port>/<route>` with the JSON payload and
/// the process token. Returns the sidecar's JSON response. This is what `gw.invoke(route, payload)`
/// reaches in an extension.
#[tauri::command]
pub async fn ext_invoke(
    id: String,
    route: String,
    payload: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let (port, token) = {
        let guard = sidecars().lock().unwrap_or_else(|e| e.into_inner());
        let p = guard
            .get(&id)
            .ok_or_else(|| format!("sidecar '{id}' is not running"))?;
        (p.port, p.token.clone())
    };
    let route = route.trim_start_matches('/');
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("http://127.0.0.1:{port}/{route}"))
        .header("x-gw-token", token)
        .json(&payload.unwrap_or(serde_json::Value::Null))
        .send()
        .await
        .map_err(|e| format!("sidecar request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("sidecar returned {status}: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("sidecar returned invalid JSON: {e}"))
}

/// Stop a running sidecar (on extension disable / app teardown).
#[tauri::command]
pub fn ext_stop_sidecar(id: String) {
    if let Some(mut p) = sidecars()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id)
    {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
}

/// Start a sidecar extension's bundled binary (resolved next to the app by name). Called by the
/// frontend when activating an extension whose manifest declares `backend.type === "sidecar"`.
#[tauri::command]
pub async fn ext_start_bundled_sidecar(id: String, name: String) -> Result<u16, String> {
    let bin = resolve_sidecar_bin(&name)
        .ok_or_else(|| format!("sidecar binary '{name}' not found next to the app"))?;
    ext_start_sidecar(id, bin.to_string_lossy().to_string(), vec![]).await
}

/// End-to-end proof of the native-sidecar path: spawn the bundled `gw_ext_sidecar`, poll an optional
/// feed through it, and tear it down — exercising spawn → handshake → health → token-auth'd proxy.
#[tauri::command]
pub async fn ext_sidecar_selftest(feed: Option<String>) -> Result<serde_json::Value, String> {
    let bin = resolve_sidecar_bin("gw_ext_sidecar")
        .ok_or("gw_ext_sidecar binary not found next to the app")?;
    let id = "__sidecar_selftest__".to_string();
    ext_stop_sidecar(id.clone());
    let port = ext_start_sidecar(id.clone(), bin.to_string_lossy().to_string(), vec![]).await?;
    let feeds = feed
        .map(|u| vec![serde_json::json!({ "url": u })])
        .unwrap_or_default();
    let result = ext_invoke(
        id.clone(),
        "poll".into(),
        Some(serde_json::json!({ "feeds": feeds, "seen": [] })),
    )
    .await;
    ext_stop_sidecar(id);
    result.map(|r| serde_json::json!({ "port": port, "binary": bin.to_string_lossy(), "result": r }))
}
