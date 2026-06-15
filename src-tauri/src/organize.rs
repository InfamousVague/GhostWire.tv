//! "Clean up the library folder" — an Ollama-driven tidy pass over the download root.
//!
//! Runs INCREMENTALLY, one file at a time: for each media file the local model parses
//! the messy release name into a clean title / year / type / season+episode, a foldered
//! Plex-convention destination is computed (so Plex/Jellyfin/Infuse all read it), and the
//! file is MOVED right then — into a SEPARATE `Organized/` library folder, kept apart
//! from the loose downloads. Because each file is finished before the next is touched and
//! organized files leave the source tree, a crash or stop loses no work: the next run
//! re-scans the source (skipping `Organized/`) and simply resumes where it left off.
//! Safety: never deletes a file, never overwrites an existing target, only ever removes
//! *empty* leftover folders. Falls back to the regex parser when Ollama is offline.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::ai;
use crate::export::{self, Exportable};

const SUBTITLE_EXT: &[&str] = &["srt", "ass", "ssa", "vtt", "sub", "idx"];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeMove {
    /// Absolute source path.
    pub from: String,
    /// Current file name (for display).
    pub from_name: String,
    /// Destination path relative to the library root.
    pub to_rel: String,
    pub media_type: String, // movie | show | music
    /// "plan" | "moved" | "skipped" | "unchanged" | "error"
    pub status: String,
    pub message: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeResult {
    pub root: String,
    pub ai_used: bool,
    pub model: Option<String>,
    pub planned: usize,
    pub moved: usize,
    pub skipped: usize,
    pub unchanged: usize,
    pub errors: usize,
    pub moves: Vec<OrganizeMove>,
}

/// One file's outcome, streamed to the UI the moment it's organized (or skipped/failed),
/// so progress is visible live and the running list reflects what is already done on disk.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeStep {
    pub done: usize,
    pub total: usize,
    pub file: String,
    pub to_rel: String,
    pub media_type: String,
    /// "moved" | "skipped" | "error"
    pub status: String,
    pub message: Option<String>,
}

/// Incrementally organize the download folder into a SEPARATE `organized_root`, one file
/// at a time. Each file is parsed (LLM/fallback), moved into its tidy Plex destination,
/// and reported via `on_progress` BEFORE the next is touched — so a crash or stop leaves
/// finished files in place and the next run simply resumes (organized files live under
/// `organized_root`, which the source scan skips). Never overwrites or deletes content.
pub async fn run(
    root: &Path,
    organized_root: &Path,
    client: &reqwest::Client,
    model: Option<&str>,
    on_progress: impl Fn(OrganizeStep),
) -> OrganizeResult {
    // Source = everything under the download root EXCEPT the organized library subtree
    // (already-organized files are "done" and must not be re-processed).
    let files: Vec<Exportable> = export::scan(root)
        .into_iter()
        .filter(|f| !Path::new(&f.path).starts_with(organized_root))
        .collect();
    let total = files.len();
    let mut result = OrganizeResult {
        root: organized_root.display().to_string(),
        ai_used: model.is_some(),
        model: model.map(|m| m.to_string()),
        ..Default::default()
    };

    // Reserve targets we've already assigned this run so two files can't collide.
    let mut taken: BTreeSet<String> = BTreeSet::new();

    for (idx, f) in files.iter().enumerate() {
        let ext = ext_of(&f.file_name);
        let stem = f.file_name.strip_suffix(&format!(".{ext}")).unwrap_or(&f.file_name);

        // LLM parse the name; fall back to the regex fields from the scan.
        let parsed = match model {
            Some(m) => ai::parse_title(client, m, stem).await.ok(),
            None => None,
        };
        let mut to_rel = target_rel(parsed.as_ref(), f, &ext);
        to_rel = dedupe_target(&mut taken, organized_root, to_rel);

        let from = PathBuf::from(&f.path);
        let to = organized_root.join(&to_rel);
        let media = media_type_of(parsed.as_ref(), f);

        // Move it right now, into the separate library. Each move is durable on its own.
        let (status, message): (&str, Option<String>) = if to.exists() {
            result.skipped += 1;
            ("skipped", Some("a file is already there".into()))
        } else if !from.is_file() {
            result.errors += 1;
            ("error", Some("source missing".into()))
        } else {
            match move_file(&from, &to) {
                Ok(()) => {
                    move_siblings(&from, &to);
                    result.moved += 1;
                    ("moved", None)
                }
                Err(e) => {
                    result.errors += 1;
                    ("error", Some(e))
                }
            }
        };

        result.moves.push(OrganizeMove {
            from: f.path.clone(),
            from_name: f.file_name.clone(),
            to_rel: to_rel.clone(),
            media_type: media.clone(),
            status: status.to_string(),
            message: message.clone(),
        });
        on_progress(OrganizeStep {
            done: idx + 1,
            total,
            file: f.file_name.clone(),
            to_rel,
            media_type: media,
            status: status.to_string(),
            message,
        });
    }

    // Tidy up empty download folders left behind, but keep the organized library tree.
    sweep_empty_dirs_src(root, organized_root);
    result
}

// ---- naming ----

/// Plex-convention destination relative to the root, driven by the LLM parse when present.
fn target_rel(p: Option<&ai::Parsed>, f: &Exportable, ext: &str) -> String {
    let raw_title = p
        .map(|p| p.title.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| f.title.clone());
    let title = export::sanitize(&raw_title);
    // sanitize() strips path separators; also reject `.`/`..` so a title can never
    // resolve to a parent dir once joined onto the organized root.
    let title = if title.is_empty() || title == "." || title == ".." { "Unknown".to_string() } else { title };

    if f.kind == "audio" {
        return format!("Music/{title}.{ext}");
    }

    let season = p.and_then(|p| p.season).or(f.season);
    let episode = p.and_then(|p| p.episode).or(f.episode);
    let llm_show = matches!(p.map(|p| p.kind.as_str()), Some("show") | Some("series") | Some("tv"));
    let is_show = llm_show || f.media_type == "show" || (season.is_some() && episode.is_some());

    if is_show {
        let ss = season.unwrap_or(1);
        let ee = episode.unwrap_or(1);
        format!("TV Shows/{title}/Season {ss:02}/{title} - S{ss:02}E{ee:02}.{ext}")
    } else {
        let year = p.and_then(|p| p.year).or(f.year);
        let name = match year {
            Some(y) => format!("{title} ({y})"),
            None => title,
        };
        format!("Movies/{name}/{name}.{ext}")
    }
}

fn media_type_of(p: Option<&ai::Parsed>, f: &Exportable) -> String {
    if f.kind == "audio" {
        return "music".into();
    }
    let season = p.and_then(|p| p.season).or(f.season);
    let episode = p.and_then(|p| p.episode).or(f.episode);
    let llm_show = matches!(p.map(|p| p.kind.as_str()), Some("show") | Some("series") | Some("tv"));
    if llm_show || f.media_type == "show" || (season.is_some() && episode.is_some()) {
        "show".into()
    } else {
        "movie".into()
    }
}

/// If a target rel-path is already taken this run (or exists on disk), append " (2)" etc.
fn dedupe_target(taken: &mut BTreeSet<String>, root: &Path, rel: String) -> String {
    if !taken.contains(&rel) && !root.join(&rel).exists() {
        taken.insert(rel.clone());
        return rel;
    }
    let (stem, ext) = rel.rsplit_once('.').unwrap_or((rel.as_str(), ""));
    for n in 2..100 {
        let candidate = if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        if !taken.contains(&candidate) && !root.join(&candidate).exists() {
            taken.insert(candidate.clone());
            return candidate;
        }
    }
    taken.insert(rel.clone());
    rel
}

// ---- filesystem ----

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // Cross-device fallback: copy then remove the original.
    std::fs::copy(from, to).map_err(|e| e.to_string())?;
    std::fs::remove_file(from).map_err(|e| e.to_string())?;
    Ok(())
}

/// Move subtitle files that share the video's stem into the new folder, keeping any
/// language suffix (e.g. `Movie.en.srt` → `<new stem>.en.srt`).
fn move_siblings(from: &Path, to: &Path) {
    let (Some(dir), Some(stem), Some(to_dir), Some(to_stem)) =
        (from.parent(), from.file_stem().and_then(|s| s.to_str()), to.parent(), to.file_stem().and_then(|s| s.to_str()))
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let ext = ext_of(&p.to_string_lossy());
        if !SUBTITLE_EXT.contains(&ext.as_str()) {
            continue;
        }
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or_default();
        if let Some(suffix) = name.strip_prefix(stem) {
            let dest = to_dir.join(format!("{to_stem}{suffix}"));
            if !dest.exists() {
                let _ = move_file(&p, &dest);
            }
        }
    }
}

/// Remove now-empty leftover directories under the source root (bottom-up). `remove_dir`
/// only succeeds on empty dirs, so this never deletes content; the root itself and the
/// organized library subtree are preserved.
fn sweep_empty_dirs_src(root: &Path, organized_root: &Path) {
    let mut dirs = Vec::new();
    collect_dirs(root, 0, &mut dirs);
    // Deepest first so children are gone before parents are tried.
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        if d == root || d == organized_root || d.starts_with(organized_root) {
            continue;
        }
        let _ = std::fs::remove_dir(&d); // no-op if not empty
    }
}

fn collect_dirs(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
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

fn ext_of(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

