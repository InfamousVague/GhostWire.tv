//! Song lyrics: parse LRC timestamps into timed lines and fetch lyrics from LRCLIB (free, keyless).
//! Mirrors the subtitles/anime keyless-API modules. The LRC string is parsed HERE (in Rust) so the
//! frontend only renders `{ timeMs, text }` and binary-searches the playhead — no TS LRC parser.

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub time_ms: i64,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SongLyrics {
    /// "embedded" | "lrc" | "lrclib" | "none"
    pub source: String,
    /// Timed lines, sorted by time (empty when only plain/unsynced lyrics are available).
    pub synced: Vec<LyricLine>,
    /// Plain text (newline-joined) for the unsynced fallback.
    pub plain: Option<String>,
}

impl SongLyrics {
    pub fn none() -> Self {
        SongLyrics { source: "none".into(), synced: Vec::new(), plain: None }
    }
    /// True when there is nothing worth showing (no timed lines and no plain text).
    pub fn is_empty(&self) -> bool {
        self.synced.is_empty() && self.plain.as_deref().map(str::trim).unwrap_or("").is_empty()
    }
    /// Build from any lyrics string: an LRC document (timestamps) → synced + plain; otherwise plain.
    pub fn from_text(source: &str, text: &str) -> SongLyrics {
        let (lines, plain) = parse_lrc(text);
        if lines.is_empty() {
            let t = text.trim();
            SongLyrics {
                source: source.into(),
                synced: Vec::new(),
                plain: (!t.is_empty()).then(|| t.to_string()),
            }
        } else {
            SongLyrics { source: source.into(), synced: lines, plain }
        }
    }
}

/// Parse an LRC document into timed lines + a plain-text fallback. A line may carry MULTIPLE
/// timestamps (a repeated chorus) — each becomes its own `LyricLine`. Metadata tags
/// (`[ar:]`/`[ti:]`/`[al:]`/`[length:]`/`[by:]`…) are dropped. Lines are sorted by time. Returns
/// `(timed_lines, plain_text)`; `timed_lines` is empty for a plain (non-LRC) document.
pub fn parse_lrc(text: &str) -> (Vec<LyricLine>, Option<String>) {
    use std::sync::OnceLock;
    static TS: OnceLock<regex::Regex> = OnceLock::new();
    let ts = TS.get_or_init(|| regex::Regex::new(r"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]").unwrap());

    let mut lines: Vec<LyricLine> = Vec::new();
    let mut plain: Vec<String> = Vec::new();
    for raw in text.lines() {
        // The lyric text on this line = everything left after the timestamps are removed.
        let content = ts.replace_all(raw, "").trim().to_string();
        let stamps: Vec<i64> = ts
            .captures_iter(raw)
            .map(|m| {
                let mm: i64 = m[1].parse().unwrap_or(0);
                let ss: i64 = m[2].parse().unwrap_or(0);
                let frac = m.get(3).map(|g| g.as_str()).unwrap_or("");
                // Normalize 1–3 fractional digits to milliseconds.
                let ms: i64 = match frac.len() {
                    0 => 0,
                    1 => frac.parse::<i64>().unwrap_or(0) * 100,
                    2 => frac.parse::<i64>().unwrap_or(0) * 10,
                    _ => frac[..3].parse::<i64>().unwrap_or(0),
                };
                mm * 60_000 + ss * 1000 + ms
            })
            .collect();
        if stamps.is_empty() {
            // No timestamp: keep prose lines, drop `[tag:value]` metadata.
            let trimmed = raw.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('[') {
                plain.push(trimmed.to_string());
            }
            continue;
        }
        for t in stamps {
            lines.push(LyricLine { time_ms: t, text: content.clone() });
        }
        plain.push(content);
    }
    lines.sort_by_key(|l| l.time_ms);
    let plain_text = if plain.is_empty() { None } else { Some(plain.join("\n")) };
    (lines, plain_text)
}

#[derive(Deserialize)]
struct LrclibResp {
    #[serde(rename = "syncedLyrics")]
    synced_lyrics: Option<String>,
    #[serde(rename = "plainLyrics")]
    plain_lyrics: Option<String>,
}

fn lrclib_to_lyrics(body: LrclibResp) -> Option<SongLyrics> {
    if let Some(synced) = body.synced_lyrics.filter(|s| !s.trim().is_empty()) {
        let (lines, plain) = parse_lrc(&synced);
        if !lines.is_empty() {
            return Some(SongLyrics {
                source: "lrclib".into(),
                synced: lines,
                plain: plain.or(body.plain_lyrics),
            });
        }
    }
    if let Some(plain) = body.plain_lyrics.filter(|s| !s.trim().is_empty()) {
        return Some(SongLyrics { source: "lrclib".into(), synced: Vec::new(), plain: Some(plain) });
    }
    None
}

/// Fetch lyrics from LRCLIB (<https://lrclib.net>) — free, keyless. Tries the exact `/api/get`
/// (artist + track + album + duration, which LRCLIB matches within ±2s) first, then falls back to
/// `/api/search` by artist + track when that 404s or the duration is unknown. Returns None when
/// nothing usable is found; never errors to the UI (a missing match is a normal 404).
pub async fn fetch_lrclib(
    client: &reqwest::Client,
    artist: &str,
    track: &str,
    album: Option<&str>,
    duration_secs: Option<i64>,
) -> Result<Option<SongLyrics>> {
    if track.trim().is_empty() {
        return Ok(None);
    }
    // 1) Exact match by duration.
    if let Some(dur) = duration_secs.filter(|d| *d > 0) {
        let mut q: Vec<(&str, String)> = vec![
            ("artist_name", artist.to_string()),
            ("track_name", track.to_string()),
            ("duration", dur.to_string()),
        ];
        if let Some(al) = album.filter(|a| !a.is_empty()) {
            q.push(("album_name", al.to_string()));
        }
        if let Ok(r) = client.get("https://lrclib.net/api/get").query(&q).send().await {
            if r.status().is_success() {
                if let Ok(body) = r.json::<LrclibResp>().await {
                    if let Some(sl) = lrclib_to_lyrics(body) {
                        return Ok(Some(sl));
                    }
                }
            }
        }
    }
    // 2) Search fallback (no duration) — take the first hit with usable lyrics.
    if let Ok(r) = client
        .get("https://lrclib.net/api/search")
        .query(&[("artist_name", artist), ("track_name", track)])
        .send()
        .await
    {
        if r.status().is_success() {
            if let Ok(list) = r.json::<Vec<LrclibResp>>().await {
                for body in list {
                    if let Some(sl) = lrclib_to_lyrics(body) {
                        return Ok(Some(sl));
                    }
                }
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::parse_lrc;

    #[test]
    fn parses_timestamps_and_drops_metadata() {
        let lrc = "[ar:Artist]\n[ti:Song]\n[00:12.50]First line\n[00:15.00]Second line\n";
        let (lines, plain) = parse_lrc(lrc);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].time_ms, 12_500);
        assert_eq!(lines[0].text, "First line");
        assert_eq!(lines[1].time_ms, 15_000);
        assert!(plain.unwrap().contains("Second line"));
    }

    #[test]
    fn repeated_chorus_timestamps_expand() {
        let (lines, _) = parse_lrc("[00:10.00][01:20.00]Chorus\n");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].time_ms, 10_000);
        assert_eq!(lines[1].time_ms, 80_000);
        assert_eq!(lines[1].text, "Chorus");
    }

    #[test]
    fn plain_text_has_no_timed_lines() {
        let (lines, plain) = parse_lrc("Just some\nplain lyrics");
        assert!(lines.is_empty());
        assert_eq!(plain.unwrap(), "Just some\nplain lyrics");
    }
}
