pub mod ai;
mod artwork;
pub mod catalog;
pub mod discover;
mod engine;
pub mod enrich;
mod export;
pub mod indexer;
mod metadata;
pub mod music;
mod organize;
pub mod posters;
mod spotify;
pub mod tvmaze;

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use catalog::{Catalog, CatalogItem, Source};
use engine::{DownloadStats, Engine, MediaInfo};
use serde::Serialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// A current Safari UA so Cloudflare-protected sites serve the normal page in the
/// embedded browser (and so any cf_clearance cookie stays valid for this engine).
const BROWSER_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15";
const VERIFY_LABEL: &str = "ghosty-verify";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    download_dir: String,
    data_dir: String,
    ffmpeg_available: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VpnStatus {
    active: bool,
    interface: String,
}

/// Heuristic VPN detection: a full-tunnel VPN routes the default route through a
/// tunnel interface (utun/ipsec/ppp/…) rather than physical en0/Wi-Fi. Local-only,
/// no external calls.
#[tauri::command]
fn vpn_status() -> VpnStatus {
    let interface = default_route_interface();
    let prefix: String = interface.chars().take_while(|c| !c.is_ascii_digit()).collect();
    let active = matches!(prefix.as_str(), "utun" | "tun" | "tap" | "ppp" | "ipsec" | "wg" | "gpd");
    VpnStatus { active, interface }
}

#[cfg(target_os = "macos")]
fn default_route_interface() -> String {
    std::process::Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.trim().strip_prefix("interface:").map(|x| x.trim().to_string()))
        })
        .unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn default_route_interface() -> String {
    String::new()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- streaming engine commands ----

#[tauri::command]
async fn add_torrent(engine: tauri::State<'_, Engine>, magnet: String) -> Result<String, String> {
    engine.add(&magnet).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn stream_url(
    engine: tauri::State<'_, Engine>,
    id: String,
    file_idx: Option<usize>,
) -> Result<String, String> {
    engine.stream_url(&id, file_idx).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn torrent_stats(engine: tauri::State<'_, Engine>, id: String) -> Result<DownloadStats, String> {
    engine.stats_for(&id).await.ok_or_else(|| "unknown torrent".to_string())
}

#[tauri::command]
async fn list_downloads(engine: tauri::State<'_, Engine>) -> Result<Vec<DownloadStats>, String> {
    Ok(engine.snapshot().await)
}

#[tauri::command]
async fn media_info(engine: tauri::State<'_, Engine>, id: String) -> Result<MediaInfo, String> {
    engine.media_info(&id).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn remove_torrent(
    engine: tauri::State<'_, Engine>,
    id: String,
    delete_files: Option<bool>,
) -> Result<(), String> {
    engine.remove(&id, delete_files.unwrap_or(false)).await.map_err(|e| format!("{e:#}"))
}

// ---- catalog / source commands ----

#[tauri::command]
fn list_sources(catalog: tauri::State<'_, Catalog>) -> Result<Vec<Source>, String> {
    catalog.list_sources().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn add_source(
    catalog: tauri::State<'_, Catalog>,
    name: String,
    kind: String,
    url: String,
) -> Result<Source, String> {
    catalog.add_source(&name, &kind, &url).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn remove_source(catalog: tauri::State<'_, Catalog>, id: String) -> Result<(), String> {
    catalog.remove_source(&id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn list_catalog(
    catalog: tauri::State<'_, Catalog>,
    query: Option<String>,
    category: Option<String>,
    sort: Option<String>,
) -> Result<Vec<CatalogItem>, String> {
    catalog
        .list_items(query.as_deref(), category.as_deref(), sort.as_deref().unwrap_or("popularity"), 1000)
        .map_err(|e| format!("{e:#}"))
}

/// Fetch + parse a source, upsert discovered items, stamp the source. Returns count found.
#[tauri::command]
async fn refresh_source(catalog: tauri::State<'_, Catalog>, id: String) -> Result<usize, String> {
    let src = catalog
        .get_source(&id)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| "unknown source".to_string())?;
    let items = indexer::run_source(&src.kind, &src.url, &src.name, now_ms())
        .await
        .map_err(|e| format!("{e:#}"))?;
    let n = items.len();
    catalog.upsert_items(&items).map_err(|e| format!("{e:#}"))?;
    catalog.set_source_indexed(&id, now_ms()).map_err(|e| format!("{e:#}"))?;
    Ok(n)
}

/// Probe a source and return detailed diagnostics (HTTP status, detected format, item
/// count, a sample, and a plain-language hint) for the "Test source" button. Read-only —
/// nothing is persisted.
#[tauri::command]
async fn test_source(
    catalog: tauri::State<'_, Catalog>,
    id: String,
) -> Result<indexer::SourceTest, String> {
    let src = catalog
        .get_source(&id)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| "unknown source".to_string())?;
    Ok(indexer::test_source(&src.kind, &src.url, &src.name, now_ms()).await)
}

/// Live-search every enabled source for `query`, merge + dedupe by infohash,
/// persist to the catalog, and return the results (seeders-sorted).
#[tauri::command]
async fn search_sources(
    catalog: tauri::State<'_, Catalog>,
    query: String,
) -> Result<Vec<CatalogItem>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let sources: Vec<Source> = catalog
        .list_sources()
        .map_err(|e| format!("{e:#}"))?
        .into_iter()
        .filter(|s| s.enabled)
        .collect();
    let now = now_ms();
    let mut seen = HashSet::new();
    let mut merged: Vec<CatalogItem> = Vec::new();
    for s in &sources {
        if let Ok(items) = indexer::search_source(&s.kind, &s.url, &q, &s.name, now).await {
            for it in items {
                if seen.insert(it.id.clone()) {
                    merged.push(it);
                }
            }
        }
    }
    let merged = rank_by_relevance(&q, merged);
    let _ = catalog.upsert_items(&merged);
    Ok(merged)
}

/// Significant lowercase tokens of a search query: drops stopwords / season-noise /
/// 1-char fragments so relevance keys on the title words that actually matter.
fn query_tokens(q: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "the", "a", "an", "of", "and", "or", "to", "in", "on", "at",
        "complete", "series", "season", "episode", "part", "vol",
    ];
    q.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 2 && !STOP.contains(t))
        .map(str::to_string)
        .collect()
}

/// Drop results that share NO significant word with the query, then rank by how many
/// query words they match (desc) and seeders (desc). Without this a popular-but-
/// unrelated file leads on pure seeders — e.g. searching "The Apothecary Diaries"
/// surfacing "The Lion King". If the query is all stopwords, fall back to seeders.
fn rank_by_relevance(query: &str, items: Vec<CatalogItem>) -> Vec<CatalogItem> {
    let tokens = query_tokens(query);
    if tokens.is_empty() {
        let mut items = items;
        items.sort_by(|a, b| b.seeders.cmp(&a.seeders));
        return items;
    }
    let mut scored: Vec<(usize, CatalogItem)> = items
        .into_iter()
        .map(|it| {
            let score = title_score(&tokens, &it.title);
            (score, it)
        })
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.seeders.cmp(&a.1.seeders)));
    scored.into_iter().map(|(_, it)| it).collect()
}

/// How many of `tokens` appear (as substrings) in `title`. 0 = no overlap = irrelevant.
fn title_score(tokens: &[String], title: &str) -> usize {
    let title = title.to_lowercase();
    tokens.iter().filter(|tok| title.contains(tok.as_str())).count()
}

#[cfg(test)]
mod relevance_tests {
    use super::{query_tokens, title_score};

    #[test]
    fn drops_unrelated_popular_result() {
        // The reported bug: "The Apothecary Diaries" must not surface "The Lion King".
        let tokens = query_tokens("The Apothecary Diaries");
        assert_eq!(tokens, vec!["apothecary", "diaries"]); // "the" dropped as a stopword
        assert_eq!(title_score(&tokens, "The Lion King"), 0); // filtered out (no overlap)
        assert_eq!(title_score(&tokens, "The Apothecary Diaries S01 1080p WEB"), 2);
        // A weaker single-word match survives but ranks below the full match.
        assert_eq!(title_score(&tokens, "Diary of a Wimpy Kid"), 0); // "diaries" != "diary"
        assert_eq!(title_score(&tokens, "The Apothecary 2023"), 1);
    }

    #[test]
    fn season_query_keeps_both_naming_styles() {
        let tokens = query_tokens("The Apothecary Diaries S01 complete");
        // "the", "complete" dropped; "s01" kept as meaningful.
        assert_eq!(tokens, vec!["apothecary", "diaries", "s01"]);
        assert_eq!(title_score(&tokens, "The.Apothecary.Diaries.S01.1080p"), 3);
        assert_eq!(title_score(&tokens, "The Apothecary Diaries Season 1"), 2); // still kept
    }

    #[test]
    fn all_stopword_query_yields_no_tokens() {
        assert!(query_tokens("the of and").is_empty());
    }
}

// ---- settings / enrichment / download management ----

#[tauri::command]
fn get_setting(catalog: tauri::State<'_, Catalog>, key: String) -> Option<String> {
    catalog.get_setting(&key)
}

#[tauri::command]
fn set_setting(catalog: tauri::State<'_, Catalog>, key: String, value: String) -> Result<(), String> {
    catalog.set_setting(&key, &value).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn clear_catalog(catalog: tauri::State<'_, Catalog>) -> Result<usize, String> {
    catalog.clear_items().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn app_info(info: tauri::State<'_, AppInfo>) -> AppInfo {
    info.inner().clone()
}

/// Look up posters/overviews for un-enriched items via TMDB (needs `tmdb_key`).
#[tauri::command]
async fn enrich_catalog(catalog: tauri::State<'_, Catalog>) -> Result<usize, String> {
    let key = catalog
        .get_setting("tmdb_key")
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "Set a TMDB API key in Settings first".to_string())?;
    let todo = catalog.items_needing_poster(40).map_err(|e| format!("{e:#}"))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut enriched = 0usize;
    for (id, title) in todo {
        if let Ok(Some(e)) = enrich::enrich_title(&client, &key, &title).await {
            let had_poster = e.poster.is_some();
            let _ = catalog.set_enrichment(&id, e.poster.as_deref(), e.description.as_deref(), e.year);
            if had_poster {
                enriched += 1;
            }
        }
    }
    Ok(enriched)
}

// ---- local LLM + artwork library ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    organized: usize,
    posters: usize,
    remaining: i64,
    ai_used: bool,
    model: Option<String>,
}

/// Report whether the local Ollama daemon is up and which models are installed.
#[tauri::command]
async fn ai_status() -> ai::AiStatus {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .unwrap_or_default();
    ai::status(&client).await
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PosterResult {
    found: usize,
    scanned: usize,
    remaining: i64,
    used_keys: bool,
}

/// Fetch cover art for items missing a poster — keyless-first (IMDb for movies/TV,
/// iTunes for music), falling back to TMDB/OMDb when the user has added keys. Fast
/// (no local LLM), so it can run automatically as results come in. Returns a summary.
#[tauri::command]
async fn fetch_posters(
    catalog: tauri::State<'_, Catalog>,
    info: tauri::State<'_, AppInfo>,
    limit: Option<i64>,
) -> Result<PosterResult, String> {
    let limit = limit.unwrap_or(60).clamp(1, 300);
    let art_dir = std::path::PathBuf::from(&info.data_dir).join("artwork");
    std::fs::create_dir_all(&art_dir).ok();
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let tmdb = catalog.get_setting("tmdb_key").filter(|k| !k.trim().is_empty());
    let omdb = catalog.get_setting("omdb_key").filter(|k| !k.trim().is_empty());

    let todo = catalog.items_needing_poster(limit).map_err(|e| format!("{e:#}"))?;
    let scanned = todo.len();
    let mut found = 0usize;
    for (id, title) in todo {
        let year = posters::year_from_title(&title);
        let kind = posters::guess_kind(&title);
        let clean = posters::clean_for_query(&title, kind);
        let Some(url) =
            posters::find_poster(&http, &clean, year, kind, tmdb.as_deref(), omdb.as_deref()).await
        else {
            continue;
        };
        // Cache to disk and serve from /art; fall back to the remote URL if the
        // download fails (still better than no poster).
        let stored = if artwork::cache_image(&http, &url, &art_dir, &id).await.unwrap_or(false) {
            format!("http://127.0.0.1:{}/art/{}", engine::STREAM_PORT, id)
        } else {
            url
        };
        let _ = catalog.set_enrichment(&id, Some(&stored), None, year);
        found += 1;
    }
    let remaining = catalog.count_needing_poster().unwrap_or(0);
    Ok(PosterResult {
        found,
        scanned,
        remaining,
        used_keys: tmdb.is_some() || omdb.is_some(),
    })
}

// ---- TV series finder (keyless TVMaze metadata) ----

fn web_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// Search TVMaze for shows matching `query` (the real series catalog).
#[tauri::command]
async fn tv_search(query: String) -> Result<Vec<tvmaze::TvShow>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    tvmaze::search_shows(&web_client()?, q).await.map_err(|e| format!("{e:#}"))
}

/// Every episode of a TVMaze show, in order — so the finder can list seasons/episodes.
#[tauri::command]
async fn tv_episodes(show_id: i64) -> Result<Vec<tvmaze::TvEpisode>, String> {
    tvmaze::episodes(&web_client()?, show_id).await.map_err(|e| format!("{e:#}"))
}

// ---- Music discovery (keyless iTunes metadata) ----

/// Search iTunes for recording artists matching `query` (the artist finder).
#[tauri::command]
async fn music_search_artists(query: String) -> Result<Vec<music::Artist>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    music::search_artists(&web_client()?, q).await.map_err(|e| format!("{e:#}"))
}

/// An artist's albums, newest first — so the finder can lay out the discography.
#[tauri::command]
async fn music_artist_albums(artist_id: i64) -> Result<Vec<music::Album>, String> {
    music::artist_albums(&web_client()?, artist_id).await.map_err(|e| format!("{e:#}"))
}

/// Every track on an album, in order — so the finder can list songs to source.
#[tauri::command]
async fn music_album_tracks(album_id: i64) -> Result<Vec<music::Track>, String> {
    music::album_tracks(&web_client()?, album_id).await.map_err(|e| format!("{e:#}"))
}

/// A YouTube trailer key for a show via TMDB (needs `tmdb_key`). Returns None if
/// there's no key or no trailer — the UI just hides the trailer in that case.
#[tauri::command]
async fn tv_trailer(
    catalog: tauri::State<'_, Catalog>,
    title: String,
    year: Option<i64>,
) -> Result<Option<String>, String> {
    let Some(key) = catalog.get_setting("tmdb_key").filter(|k| !k.trim().is_empty()) else {
        return Ok(None);
    };
    let client = web_client()?;
    // 1. Resolve the TMDB tv id (year-filtered so the right show wins).
    let mut params: Vec<(&str, String)> = vec![("api_key", key.clone()), ("query", title)];
    if let Some(y) = year {
        params.push(("first_air_date_year", y.to_string()));
    }
    let search: serde_json::Value = client
        .get("https://api.themoviedb.org/3/search/tv")
        .query(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let Some(id) = search["results"].get(0).and_then(|r| r["id"].as_i64()) else {
        return Ok(None);
    };
    // 2. Pick the best YouTube trailer (official trailer → trailer → teaser → any).
    let vids: serde_json::Value = client
        .get(format!("https://api.themoviedb.org/3/tv/{id}/videos"))
        .query(&[("api_key", key.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let arr = vids["results"].as_array().cloned().unwrap_or_default();
    let yt = |v: &serde_json::Value| v["site"].as_str() == Some("YouTube");
    let pick = arr
        .iter()
        .find(|v| yt(v) && v["type"].as_str() == Some("Trailer") && v["official"].as_bool() == Some(true))
        .or_else(|| arr.iter().find(|v| yt(v) && v["type"].as_str() == Some("Trailer")))
        .or_else(|| arr.iter().find(|v| yt(v) && v["type"].as_str() == Some("Teaser")))
        .or_else(|| arr.iter().find(|v| yt(v)))
        .and_then(|v| v["key"].as_str().map(|s| s.to_string()));
    Ok(pick)
}

/// Scanned items joined with their AI/artwork metadata — the Library view.
#[tauri::command]
fn list_library(catalog: tauri::State<'_, Catalog>) -> Result<Vec<catalog::LibraryItem>, String> {
    catalog.list_library(500).map_err(|e| format!("{e:#}"))
}

// ---- manual poster overrides (right-click → Replace poster) ----

fn norm_title(s: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_space = false;
        } else if !prev_space && !out.is_empty() {
            out.push(' ');
            prev_space = true;
        }
    }
    out.trim().to_string()
}

/// Candidate poster URLs for a title (keyless IMDb + iTunes) — the picker grid.
#[tauri::command]
async fn poster_candidates(title: String, kind: Option<String>) -> Vec<String> {
    let Ok(client) = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
    else {
        return Vec::new();
    };
    posters::candidates(&client, &title, kind.as_deref().unwrap_or("movie")).await
}

/// Set a manual poster for everything matching `title`. Caches the chosen image and
/// records the override (keyed by normalized title). Returns the local art URL.
#[tauri::command]
async fn set_poster(
    catalog: tauri::State<'_, Catalog>,
    info: tauri::State<'_, AppInfo>,
    title: String,
    url: String,
) -> Result<String, String> {
    let key = norm_title(&title);
    if key.is_empty() || url.trim().is_empty() {
        return Err("Missing title or image.".into());
    }
    let art_dir = std::path::PathBuf::from(&info.data_dir).join("artwork");
    std::fs::create_dir_all(&art_dir).ok();
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut h);
    let name = format!("ovr-{:x}", h.finish());

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let stored = if artwork::cache_image(&http, &url, &art_dir, &name).await.unwrap_or(false) {
        format!("http://127.0.0.1:{}/art/{}", engine::STREAM_PORT, name)
    } else {
        url
    };
    catalog.set_poster_override(&key, &stored).map_err(|e| format!("{e:#}"))?;
    Ok(stored)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PosterOverride {
    title: String,
    url: String,
}

/// All manual poster overrides (normalized title → url) for the UI to overlay.
#[tauri::command]
fn list_poster_overrides(catalog: tauri::State<'_, Catalog>) -> Vec<PosterOverride> {
    catalog
        .list_poster_overrides()
        .unwrap_or_default()
        .into_iter()
        .map(|(title, url)| PosterOverride { title, url })
        .collect()
}

// ---- local Library (content downloaded to disk) ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadedItem {
    id: String,
    title: String,
    file_name: String,
    kind: String,       // "video" | "audio"
    media_type: String, // "movie" | "show" | "music"
    season: Option<i64>,
    episode: Option<i64>,
    size_bytes: i64,
    /// File mtime as epoch seconds — drives the "Recently added" feed.
    added_at: i64,
    /// Loopback URL the player can stream the local file from (with HTTP Range).
    url: String,
    /// True once the user has curated it into the Library; otherwise it lives,
    /// "unsorted", under Downloads.
    in_library: bool,
}

/// Everything downloaded is in the Library by default; "Remove from library" hides a
/// file (it stays on disk, reappears under Downloads to re-add) without deleting it —
/// that's "Move to Trash". So we persist the OPT-OUT set of removed ids (relative
/// paths), as a JSON array in settings — survives restarts, no schema migration.
fn removed_set(catalog: &Catalog) -> HashSet<String> {
    catalog
        .get_setting("library_removed")
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

fn save_removed_set(catalog: &Catalog, set: &HashSet<String>) {
    let v: Vec<&String> = set.iter().collect();
    if let Ok(json) = serde_json::to_string(&v) {
        let _ = catalog.set_setting("library_removed", &json);
    }
}

/// Restore a removed item to the Library (un-hide).
#[tauri::command]
fn add_to_library(
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
    id: String,
) -> Result<(), String> {
    let mut s = removed_set(&catalog);
    s.remove(&id);
    save_removed_set(&catalog, &s);
    invalidate_scan(&cache); // in_library flag changed
    Ok(())
}

/// Hide an item from the Library (keeps the file on disk).
#[tauri::command]
fn remove_from_library(
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
    id: String,
) -> Result<(), String> {
    let mut s = removed_set(&catalog);
    s.insert(id);
    save_removed_set(&catalog, &s);
    invalidate_scan(&cache); // in_library flag changed
    Ok(())
}

/// Reveal a downloaded file in Finder (by its relative-path id).
#[tauri::command]
fn reveal_path(info: tauri::State<'_, AppInfo>, id: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&info.download_dir).join(&id);
    std::process::Command::new("open")
        .arg("-R")
        .arg(&p)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Move a downloaded file to the Trash (recoverable) and drop it from the Library.
/// Path-guarded to the download folder so nothing outside it can be touched.
#[tauri::command]
fn trash_downloaded(
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
    id: String,
) -> Result<(), String> {
    let root = std::path::PathBuf::from(&info.download_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = root.join(&id).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&root) {
        return Err("Refusing to trash a file outside the download folder.".to_string());
    }
    let path = target.display().to_string().replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("tell application \"Finder\" to delete POSIX file \"{path}\"");
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    // Drop any "removed" flag so a future re-download starts back in the Library.
    let mut s = removed_set(&catalog);
    s.remove(&id);
    save_removed_set(&catalog, &s);
    invalidate_scan(&cache); // file gone from disk
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearResult {
    removed_active: usize,
    trashed: usize,
}

/// Clear Downloads: stop & drop every active transfer (wiping partials), then move every
/// on-disk file that ISN'T in the Library to the Trash (recoverable). The curated Library
/// is kept untouched. Empty leftover folders are swept.
#[tauri::command]
async fn clear_downloads(
    engine: tauri::State<'_, Engine>,
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
) -> Result<ClearResult, String> {
    let removed_active = engine.clear().await;

    let root = std::path::PathBuf::from(&info.download_dir);
    let removed = removed_set(&catalog);
    // On-disk media files removed from the Library (the "unsorted" shelf) — these get trashed.
    let victims: Vec<std::path::PathBuf> = export::scan(&root)
        .into_iter()
        .filter_map(|e| {
            let abs = std::path::PathBuf::from(&e.path);
            let rel = abs.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
            removed.contains(&rel).then_some(abs)
        })
        .collect();

    let root2 = root.clone();
    let trashed = tokio::task::spawn_blocking(move || {
        let n = trash_files(&victims);
        sweep_empty_dirs(&root2);
        n
    })
    .await
    .map_err(|e| e.to_string())?;

    invalidate_scan(&cache); // files trashed off disk
    Ok(ClearResult { removed_active, trashed })
}

/// Batch-move files to the Trash via Finder (one AppleScript call, falling back to
/// per-file so one locked file can't abort the batch). Returns how many were moved.
fn trash_files(paths: &[std::path::PathBuf]) -> usize {
    if paths.is_empty() {
        return 0;
    }
    let list = paths
        .iter()
        .map(|p| format!("POSIX file \"{}\"", applescript_escape(p)))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!("tell application \"Finder\" to delete {{{list}}}");
    let ok = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if ok {
        paths.len()
    } else {
        paths
            .iter()
            .filter(|p| {
                let s = format!("tell application \"Finder\" to delete POSIX file \"{}\"", applescript_escape(p));
                std::process::Command::new("osascript").arg("-e").arg(&s).output().map(|o| o.status.success()).unwrap_or(false)
            })
            .count()
    }
}

fn applescript_escape(p: &std::path::Path) -> String {
    p.display().to_string().replace('\\', "\\\\").replace('"', "\\\"")
}

/// Remove now-empty leftover folders under `root` (bottom-up; `remove_dir` only deletes
/// empty dirs, so folders that still hold Library files are never touched).
fn sweep_empty_dirs(root: &std::path::Path) {
    let mut dirs = Vec::new();
    collect_dirs(root, 0, &mut dirs);
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = std::fs::remove_dir(&d);
    }
}

fn collect_dirs(dir: &std::path::Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_dirs(&p, depth + 1, out);
            out.push(p);
        }
    }
}

/// Percent-encode each path segment so spaces / unicode survive the loopback URL.
fn enc_path(rel: &str) -> String {
    rel.split('/')
        .map(|seg| {
            seg.chars()
                .flat_map(|c| match c {
                    'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => vec![c.to_string()],
                    _ => c.to_string().bytes().map(|b| format!("%{b:02X}")).collect(),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// In-memory TTL cache over the (recursive, disk-walking) library scan. Every media tab
/// re-runs `list_downloaded` on mount, so without this a Library→Movies→Music sweep
/// re-walks the same folder several times. Invalidated explicitly on any mutation
/// (add/remove/trash/clear/organize); the short TTL also picks up just-finished downloads.
struct ScanCache(Mutex<Option<(Vec<DownloadedItem>, Instant)>>);
const SCAN_TTL: Duration = Duration::from_secs(5);

fn invalidate_scan(cache: &ScanCache) {
    if let Ok(mut g) = cache.0.lock() {
        *g = None;
    }
}

/// The actual disk walk + parse (uncached). Kept separate so the command can cache it.
fn scan_downloaded(info: &AppInfo, catalog: &Catalog) -> Vec<DownloadedItem> {
    let root = std::path::PathBuf::from(&info.download_dir);
    let removed = removed_set(catalog);
    export::scan(&root)
        .into_iter()
        .filter_map(|e| {
            let abs = std::path::PathBuf::from(&e.path);
            let rel = abs.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
            // Video the webview can't decode (mkv, avi, …) is served via on-the-fly HLS
            // transcode; everything else (web-native video, audio) is served raw with Range.
            let url = if info.ffmpeg_available && engine::local_transcodes(&rel) {
                format!("http://127.0.0.1:{}/localhls/{}/index.m3u8", engine::STREAM_PORT, engine::hls_token(&rel))
            } else {
                format!("http://127.0.0.1:{}/file/{}", engine::STREAM_PORT, enc_path(&rel))
            };
            Some(DownloadedItem {
                in_library: !removed.contains(&rel),
                id: rel.clone(),
                title: e.title,
                file_name: e.file_name,
                kind: e.kind,
                media_type: e.media_type,
                season: e.season,
                episode: e.episode,
                size_bytes: e.size_bytes as i64,
                added_at: e.added_at,
                url,
            })
        })
        .collect()
}

/// Everything downloaded to disk, parsed into movies / shows / music with a ready-to-play
/// loopback URL. This is the Library — your local content, independent of the live session.
/// Served from a 5s in-memory cache so rapid tab-switching doesn't re-walk the disk.
#[tauri::command]
fn list_downloaded(
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
) -> Vec<DownloadedItem> {
    if let Ok(g) = cache.0.lock() {
        if let Some((items, at)) = g.as_ref() {
            if at.elapsed() < SCAN_TTL {
                return items.clone();
            }
        }
    }
    let items = scan_downloaded(info.inner(), catalog.inner());
    if let Ok(mut g) = cache.0.lock() {
        *g = Some((items.clone(), Instant::now()));
    }
    items
}

/// The model the AI tasks should use: the user's `ollama_model` override when it is
/// actually installed, otherwise the best auto-pick. None when Ollama is offline.
async fn resolve_model(catalog: &Catalog, client: &reqwest::Client) -> Option<String> {
    let status = ai::status(client).await;
    if let Some(pref) = catalog.get_setting("ollama_model").filter(|m| !m.trim().is_empty()) {
        if status.models.iter().any(|m| *m == pref) {
            return Some(pref);
        }
    }
    status.model
}

/// Incrementally organize the download folder into a separate `Organized/` library —
/// one file at a time, moved as it is processed, so a crash or stop resumes without
/// redoing finished files (organized files leave the source tree). Streams a per-file
/// `organize://progress` step to the UI.
#[tauri::command]
async fn organize_run(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
    cache: tauri::State<'_, ScanCache>,
) -> Result<organize::OrganizeResult, String> {
    use tauri::Emitter;
    let root = std::path::PathBuf::from(&info.download_dir);
    let organized = root.join("Organized");
    let llm = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let model = resolve_model(catalog.inner(), &llm).await;
    let res = organize::run(&root, &organized, &llm, model.as_deref(), move |step| {
        let _ = app.emit("organize://progress", &step);
    })
    .await;
    invalidate_scan(&cache); // files moved on disk
    Ok(res)
}

fn organize_progress(phase: &str, done: usize, total: usize) -> serde_json::Value {
    serde_json::json!({ "phase": phase, "done": done, "total": total })
}

// ---- AI metadata tagging (clean tags + legible names, embedded into files) ----

/// Preview clean tags + legible filenames for the music library (Ollama-driven,
/// regex fallback). Read-only — embeds nothing until `tag_apply`.
#[tauri::command]
async fn tag_plan(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    catalog: tauri::State<'_, Catalog>,
) -> Result<metadata::TagResult, String> {
    use tauri::Emitter;
    let root = std::path::PathBuf::from(&info.download_dir);
    let llm = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let model = resolve_model(catalog.inner(), &llm).await;
    Ok(metadata::plan(&root, &llm, model.as_deref(), move |done, total| {
        let _ = app.emit("tag://progress", organize_progress("plan", done, total));
    })
    .await)
}

/// Write previewed tags into the files (lofty, pure-Rust) + apply legible renames.
/// Blocking fs/tag work runs off the main thread; never overwrites or deletes.
#[tauri::command]
async fn tag_apply(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    cache: tauri::State<'_, ScanCache>,
    changes: Vec<metadata::TagApply>,
) -> Result<metadata::TagResult, String> {
    let root = std::path::PathBuf::from(&info.download_dir);
    let res = tokio::task::spawn_blocking(move || {
        use tauri::Emitter;
        metadata::apply(&root, &changes, |done, total| {
            let _ = app.emit("tag://progress", organize_progress("apply", done, total));
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    invalidate_scan(&cache); // files renamed on disk
    Ok(res)
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct ConvertResult {
    converted: usize,
    skipped: usize,
    errors: usize,
    dest: String,
}

/// Transcode non-portable audio (FLAC/OGG/Opus/WMA/AIFF…) into a device-friendly
/// format under a `Converted/` folder. Originals stay put (keep seeding).
#[tauri::command]
async fn convert_audio(
    app: tauri::AppHandle,
    info: tauri::State<'_, AppInfo>,
    format: String,
) -> Result<ConvertResult, String> {
    use tauri::Emitter;
    let root = std::path::PathBuf::from(&info.download_dir);
    let (ffmpeg, _ffprobe) = engine::resolve_ffmpeg();
    let ffmpeg = ffmpeg.ok_or("FFmpeg not found — install it to convert audio")?;
    let codec = if format == "mp3" { "mp3" } else { "alac" };
    let target_ext = if codec == "mp3" { "mp3" } else { "m4a" };
    let portable = ["mp3", "m4a", "aac", "alac"];

    let files: Vec<_> = export::scan(&root)
        .into_iter()
        .filter(|e| e.kind == "audio")
        .filter(|e| {
            let ext = std::path::Path::new(&e.file_name)
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            !portable.contains(&ext.as_str())
        })
        .collect();

    let dest_root = root.join("Converted");
    let dest_str = dest_root.display().to_string();
    let res = tokio::task::spawn_blocking(move || {
        let mut r = ConvertResult { dest: dest_str, ..Default::default() };
        let total = files.len();
        for (i, f) in files.iter().enumerate() {
            let _ = app.emit("convert://progress", organize_progress("convert", i + 1, total));
            let src = std::path::PathBuf::from(&f.path);
            let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
            let dst = dest_root.join(format!("{stem}.{target_ext}"));
            if dst.exists() {
                r.skipped += 1;
                continue;
            }
            match export::transcode_audio(&ffmpeg, &src, &dst, codec) {
                Ok(()) => r.converted += 1,
                Err(_) => r.errors += 1,
            }
        }
        r
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(res)
}

/// Organize + scan up to `limit` un-processed items: the local LLM parses each
/// messy release name into a clean title/type/quality/tags, then OMDb (IMDb + RT)
/// and TMDB fill in posters and ratings, cached to disk. Degrades to a regex
/// title clean-up when Ollama isn't running. Returns a per-run summary.
#[tauri::command]
async fn ai_scan(
    catalog: tauri::State<'_, Catalog>,
    info: tauri::State<'_, AppInfo>,
    limit: Option<i64>,
) -> Result<ScanResult, String> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let art_dir = std::path::PathBuf::from(&info.data_dir).join("artwork");
    std::fs::create_dir_all(&art_dir).ok();

    // The LLM client gets a generous timeout — a 7B model on CPU can take seconds
    // per title; the HTTP client for posters/ratings stays snappy.
    let llm = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let model = resolve_model(catalog.inner(), &llm).await;
    let omdb = catalog.get_setting("omdb_key").filter(|k| !k.trim().is_empty());
    let tmdb = catalog.get_setting("tmdb_key").filter(|k| !k.trim().is_empty());

    let todo = catalog.items_needing_scan(limit).map_err(|e| format!("{e:#}"))?;
    let mut organized = 0usize;
    let mut posters = 0usize;

    for (id, title) in &todo {
        // 1. Understand the title (LLM, else regex fallback).
        let parsed = match &model {
            Some(m) => ai::parse_title(&llm, m, title).await.ok(),
            None => None,
        };
        let clean = parsed
            .as_ref()
            .map(|p| p.title.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| enrich::clean_title(title));
        let kind = parsed.as_ref().map(|p| p.kind.clone()).filter(|k| !k.is_empty());
        let mut year = parsed.as_ref().and_then(|p| p.year);

        // 2. Classification tags from the parse.
        let mut tags: Vec<String> = Vec::new();
        if let Some(p) = &parsed {
            for s in [p.quality.as_ref(), p.codec.as_ref(), p.language.as_ref()].into_iter().flatten() {
                if !s.is_empty() {
                    tags.push(s.clone());
                }
            }
            if let (Some(s), Some(e)) = (p.season, p.episode) {
                tags.push(format!("S{s:02}E{e:02}"));
            }
            tags.extend(p.genres.iter().filter(|g| !g.is_empty()).cloned());
        }

        // 3. Posters + ratings for video-ish items. OMDb (IMDb + RT) first, TMDB poster fallback.
        let video_ish = kind.as_deref().map(|k| matches!(k, "movie" | "show")).unwrap_or(true);
        let mut poster_url: Option<String> = None;
        let (mut imdb, mut rt, mut genre, mut plot) = (None, None, None, None);
        if video_ish {
            if let Some(k) = &omdb {
                if let Ok(Some(a)) = artwork::omdb_lookup(&http, k, &clean, year, kind.as_deref()).await {
                    poster_url = a.poster_url;
                    imdb = a.imdb_rating;
                    rt = a.rt_rating;
                    genre = a.genre;
                    plot = a.plot;
                    year = year.or(a.year);
                }
            }
            if poster_url.is_none() {
                if let Some(k) = &tmdb {
                    if let Ok(Some(e)) = enrich::enrich_title(&http, k, &clean).await {
                        poster_url = e.poster;
                        plot = plot.or(e.description);
                        year = year.or(e.year);
                    }
                }
            }
        }

        // 4. Cache the poster to disk; prefer the local /art URL once cached.
        let mut art_url = poster_url.clone();
        if let Some(url) = &poster_url {
            if artwork::cache_image(&http, url, &art_dir, id).await.unwrap_or(false) {
                art_url = Some(format!("http://127.0.0.1:{}/art/{}", engine::STREAM_PORT, id));
                posters += 1;
            }
        }

        // Fold OMDb genres into the tag list.
        if let Some(g) = &genre {
            for part in g.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                if !tags.iter().any(|t| t.eq_ignore_ascii_case(part)) {
                    tags.push(part.to_string());
                }
            }
        }
        let tags_json = (!tags.is_empty()).then(|| serde_json::to_string(&tags).unwrap_or_default());

        // 5. Persist: enrich the item row, then write the meta row (marks it scanned).
        let _ = catalog.set_enrichment(id, art_url.as_deref(), plot.as_deref(), year);
        let meta = catalog::Meta {
            clean_title: Some(clean),
            media_type: kind,
            imdb_rating: imdb,
            rt_rating: rt,
            genre,
            quality: parsed.as_ref().and_then(|p| p.quality.clone()),
            tags: tags_json,
        };
        let _ = catalog.set_meta(id, &meta, now_ms());
        organized += 1;
    }

    let remaining = catalog.count_needing_scan().unwrap_or(0);
    Ok(ScanResult {
        organized,
        posters,
        remaining,
        ai_used: model.is_some(),
        model,
    })
}

#[tauri::command]
async fn pause_download(
    engine: tauri::State<'_, Engine>,
    id: String,
    paused: bool,
) -> Result<(), String> {
    engine.set_paused(&id, paused).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn reveal_download(engine: tauri::State<'_, Engine>, id: String) -> Result<(), String> {
    engine.reveal(&id).await.map_err(|e| format!("{e:#}"))
}

// ---- manual-verification browser (Cloudflare / "I'm not a robot") ----

/// Open (or refocus) an embedded browser window at `url`. The user solves any
/// Cloudflare / bot-check challenge there themselves, then browses to a results or
/// detail page. Window creation is marshalled to the main thread (required on macOS).
#[tauri::command]
async fn open_browser(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid URL: {e}"))?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let r = (|| -> Result<(), String> {
            if let Some(w) = app2.get_webview_window(VERIFY_LABEL) {
                w.navigate(parsed.clone()).map_err(|e| e.to_string())?;
                let _ = w.set_focus();
                return Ok(());
            }
            WebviewWindowBuilder::new(&app2, VERIFY_LABEL, WebviewUrl::External(parsed.clone()))
                .title("Verify & browse — The Black Pearl")
                .inner_size(1180.0, 840.0)
                .user_agent(BROWSER_UA)
                .build()
                .map(|_| ())
                .map_err(|e| format!("{e:#}"))
        })();
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())??;
    Ok(VERIFY_LABEL.to_string())
}

/// Scrape magnets from whatever page is currently shown in the verification browser
/// and add them to the catalog under `source_name`. Reads the rendered DOM via
/// `eval_with_callback` (no page-side IPC needed), then runs the normal parser.
#[tauri::command]
async fn import_from_browser(
    app: tauri::AppHandle,
    catalog: tauri::State<'_, Catalog>,
    source_name: String,
) -> Result<usize, String> {
    let w = app
        .get_webview_window(VERIFY_LABEL)
        .ok_or_else(|| "The verification browser isn't open. Click \"Open & verify\" first.".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let slot = std::sync::Mutex::new(Some(tx));
    let w2 = w.clone();
    app.run_on_main_thread(move || {
        let _ = w2.eval_with_callback("document.documentElement.outerHTML", move |json| {
            if let Ok(mut g) = slot.lock() {
                if let Some(s) = g.take() {
                    let _ = s.send(json);
                }
            }
        });
    })
    .map_err(|e| e.to_string())?;

    let json = tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| "Timed out reading the page.".to_string())?
        .map_err(|_| "Couldn't read the page contents.".to_string())?;
    // eval results arrive JSON-encoded; the DOM string decodes back to raw HTML.
    let html: String = serde_json::from_str(&json).unwrap_or(json);

    let items = indexer::parse_body(&html, &source_name, now_ms());
    let n = items.len();
    if n > 0 {
        catalog.upsert_items(&items).map_err(|e| format!("{e:#}"))?;
    }
    Ok(n)
}

// ---- export to media libraries (Plex / Apple Music / generic folder) ----

/// Native folder picker (supports creating new folders). Returns the chosen path.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    rx.await
        .ok()
        .flatten()
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.display().to_string())
}

/// Choose a new storage folder. Optionally migrate (move) existing downloads into it.
/// The setting is read on next launch, so the UI prompts a restart to apply.
#[tauri::command]
fn set_storage_dir(
    catalog: tauri::State<'_, Catalog>,
    info: tauri::State<'_, AppInfo>,
    path: String,
    migrate: bool,
) -> Result<String, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("No folder chosen.".into());
    }
    let new_dir = std::path::PathBuf::from(&path);
    std::fs::create_dir_all(&new_dir).map_err(|e| format!("Can't use that folder: {e}"))?;
    let old_dir = std::path::PathBuf::from(&info.download_dir);

    let mut moved = 0usize;
    if migrate && old_dir != new_dir && old_dir.is_dir() {
        moved = move_dir_contents(&old_dir, &new_dir).map_err(|e| format!("Move failed: {e}"))?;
    }
    catalog.set_setting("storage_dir", &path).map_err(|e| format!("{e:#}"))?;

    Ok(if moved > 0 {
        format!(
            "Saved. Moved {moved} item{} to the new folder — restart to start using it.",
            if moved == 1 { "" } else { "s" }
        )
    } else {
        "Saved. Restart the app to start using the new folder.".into()
    })
}

/// Relaunch the app (so a new storage folder takes effect).
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// Move every entry from `from` into `to` (rename when same volume, else copy + delete).
fn move_dir_contents(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<usize> {
    let mut n = 0usize;
    for entry in std::fs::read_dir(from)? {
        let src = entry?.path();
        let dest = to.join(src.file_name().unwrap_or_default());
        if std::fs::rename(&src, &dest).is_err() {
            copy_recursive(&src, &dest)?;
            if src.is_dir() {
                let _ = std::fs::remove_dir_all(&src);
            } else {
                let _ = std::fs::remove_file(&src);
            }
        }
        n += 1;
    }
    Ok(n)
}

fn copy_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

/// Media files found in the download folder, with parsed names + library-path previews.
#[tauri::command]
fn list_exportable(info: tauri::State<'_, AppInfo>) -> Vec<export::Exportable> {
    export::scan(std::path::Path::new(&info.download_dir))
}

/// Export the given files to `target` ("plex" | "generic" | "apple_music"). Copies
/// (keeps seeding), organizes into the right structure, transcodes audio to ALAC for
/// Apple Music as needed, and triggers a Plex scan when a server is configured.
#[tauri::command]
async fn export_items(
    catalog: tauri::State<'_, Catalog>,
    info: tauri::State<'_, AppInfo>,
    target: String,
    paths: Vec<String>,
) -> Result<Vec<export::ExportResult>, String> {
    let staging = export::staging_dir(&info.data_dir);
    let (ffmpeg, _ffprobe) = engine::resolve_ffmpeg();
    let plex_url = catalog.get_setting("plex_url").filter(|s| !s.trim().is_empty());
    let plex_token = catalog.get_setting("plex_token").filter(|s| !s.trim().is_empty());

    let lib_root: Option<std::path::PathBuf> = match target.as_str() {
        "plex" => Some(
            catalog
                .get_setting("plex_dir")
                .filter(|s| !s.trim().is_empty())
                .ok_or("Set your Plex library folder first (Export settings).")?
                .into(),
        ),
        "generic" => Some(
            catalog
                .get_setting("generic_dir")
                .filter(|s| !s.trim().is_empty())
                .ok_or("Choose an export folder first (Export settings).")?
                .into(),
        ),
        "apple_music" => None,
        other => return Err(format!("Unknown export target: {other}")),
    };

    let is_plex = target == "plex";
    let mut results = tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| {
                let src = std::path::Path::new(p);
                match target.as_str() {
                    "apple_music" => export::export_to_apple_music(src, ffmpeg.as_deref(), &staging),
                    _ => export::export_to_library(src, lib_root.as_ref().unwrap()),
                }
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;

    // Best-effort Plex rescan once files have landed.
    if is_plex && results.iter().any(|r| r.ok) {
        if let (Some(url), Some(token)) = (plex_url, plex_token) {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?;
            let (ok, message) = match export::plex_scan(&client, &url, &token).await {
                Ok(()) => (true, "Plex library scan triggered.".to_string()),
                Err(e) => (false, format!("Files copied, but Plex scan failed: {e}")),
            };
            results.push(export::ExportResult {
                path: "Plex server".to_string(),
                ok,
                dest: None,
                converted: false,
                message,
            });
        }
    }
    Ok(results)
}

// ---- TV discovery + AI season compilation ----

/// Popular/trending TV shows merged from TMDB, Trakt and IMDb (whichever are
/// available), enriched with posters + IMDb/RT ratings. Powers the TV discovery page.
#[tauri::command]
async fn popular_shows(catalog: tauri::State<'_, Catalog>) -> Result<Vec<discover::Show>, String> {
    let tmdb = catalog.get_setting("tmdb_key").filter(|s| !s.trim().is_empty());
    let trakt = catalog.get_setting("trakt_key").filter(|s| !s.trim().is_empty());
    let omdb = catalog.get_setting("omdb_key").filter(|s| !s.trim().is_empty());
    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(discover::popular_shows(&client, tmdb.as_deref(), trakt.as_deref(), omdb.as_deref()).await)
}

/// For a chosen show, search every linked source and bucket the magnets by season
/// (validated against TMDB's real season list when a key is set) so each season is
/// one click to stream.
#[tauri::command]
async fn compile_seasons(
    catalog: tauri::State<'_, Catalog>,
    title: String,
    year: Option<i64>,
) -> Result<discover::Compilation, String> {
    let tmdb = catalog.get_setting("tmdb_key").filter(|s| !s.trim().is_empty());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;
    discover::compile_seasons(&catalog, &client, tmdb.as_deref(), &title, year, now_ms())
        .await
        .map_err(|e| format!("{e:#}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // Single-instance (desktop only): the engine binds a fixed loopback port, so a
    // second launch — e.g. opening the installed app while the dev build runs, or a
    // double-launch — would otherwise abort on the port. Instead, focus the running
    // window and let the new process exit cleanly. iOS is single-instance via the OS.
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("ghosty");
            std::fs::create_dir_all(&data_dir).ok();

            // Catalog store (sources + discovered items).
            let catalog = Catalog::open(&data_dir.join("ghosty.db"))
                .map_err(|e| Box::<dyn std::error::Error>::from(format!("{e:#}")))?;
            if catalog.list_sources().map(|s| s.is_empty()).unwrap_or(false) {
                seed_default_sources(&catalog);
            }
            // A user-chosen storage folder (Settings) overrides the default download dir.
            let stored_dir = catalog.get_setting("storage_dir").filter(|s| !s.trim().is_empty());
            app.manage(catalog);
            app.manage(ScanCache(Mutex::new(None)));

            // Streaming engine (librqbit + loopback HTTP server).
            let download_dir = stored_dir.map(std::path::PathBuf::from).unwrap_or_else(|| {
                app.path()
                    .download_dir()
                    .unwrap_or_else(|_| std::env::temp_dir())
                    .join("The Black Pearl")
            });
            std::fs::create_dir_all(&download_dir).ok();
            let art_dir = data_dir.join("artwork");
            std::fs::create_dir_all(&art_dir).ok();
            let (ffmpeg, ffprobe) = engine::resolve_ffmpeg();
            app.manage(AppInfo {
                download_dir: download_dir.display().to_string(),
                data_dir: data_dir.display().to_string(),
                ffmpeg_available: ffmpeg.is_some(),
            });
            let engine = tauri::async_runtime::block_on(Engine::start(
                app.handle().clone(),
                download_dir,
                art_dir,
                ffmpeg,
                ffprobe,
            ))
            .map_err(|e| Box::<dyn std::error::Error>::from(format!("{e:#}")))?;
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_torrent,
            stream_url,
            torrent_stats,
            list_downloads,
            media_info,
            remove_torrent,
            list_sources,
            add_source,
            remove_source,
            list_catalog,
            refresh_source,
            test_source,
            search_sources,
            get_setting,
            set_setting,
            clear_catalog,
            app_info,
            vpn_status,
            enrich_catalog,
            fetch_posters,
            tv_search,
            tv_episodes,
            tv_trailer,
            music_search_artists,
            music_artist_albums,
            music_album_tracks,
            ai_status,
            ai_scan,
            organize_run,
            tag_plan,
            tag_apply,
            convert_audio,
            list_library,
            list_downloaded,
            poster_candidates,
            set_poster,
            list_poster_overrides,
            add_to_library,
            remove_from_library,
            reveal_path,
            trash_downloaded,
            clear_downloads,
            pause_download,
            reveal_download,
            open_browser,
            import_from_browser,
            pick_folder,
            set_storage_dir,
            restart_app,
            list_exportable,
            export_items,
            popular_shows,
            compile_seasons,
            spotify::spotify_status,
            spotify::spotify_login,
            spotify::spotify_logout,
            spotify::spotify_replicate,
            spotify::spotify_album_art
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Legal-by-default sources. Magnet-exposing pages so the generic scraper has
/// something to find; users add their own from the Sources tab.
fn seed_default_sources(catalog: &Catalog) {
    let defaults = [
        ("WebTorrent (free media)", "scraper", "https://webtorrent.io/free-torrents"),
        ("Academic Torrents", "scraper", "https://academictorrents.com/browse.php?cat=6"),
        ("Linux Tracker", "scraper", "https://linuxtracker.org/index.php?page=torrents&active=1"),
    ];
    for (name, kind, url) in defaults {
        let _ = catalog.add_source(name, kind, url);
    }
}
