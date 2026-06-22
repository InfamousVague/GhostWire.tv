import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PlayerTrack } from "./player";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface LyricLine {
  timeMs: number;
  text: string;
}
export interface SongLyrics {
  source: "embedded" | "lrc" | "lrclib" | "none";
  /** Timed lines (empty when only plain/unsynced lyrics exist). */
  synced: LyricLine[];
  plain: string | null;
}

const EMPTY: SongLyrics = { source: "none", synced: [], plain: null };

/** Resolve lyrics for a library track: embedded → sidecar .lrc → LRCLIB (keyless), parsed in Rust. */
export async function songLyrics(args: {
  rel: string;
  artist?: string;
  title?: string;
  album?: string;
  durationMs?: number;
}): Promise<SongLyrics> {
  if (!IN_TAURI) return EMPTY;
  try {
    return await invoke<SongLyrics>("song_lyrics", {
      rel: args.rel,
      artist: args.artist ?? null,
      title: args.title ?? null,
      album: args.album ?? null,
      durationMs: args.durationMs ?? null,
    });
  } catch {
    return EMPTY;
  }
}

// Per-session cache by track id so revisiting a song is instant (the backend also caches 24h).
const sessionCache = new Map<string, SongLyrics>();

/** Lazily resolve lyrics for `track`, fetching once per id (cached). Pass the loaded duration when
 *  known to sharpen the LRCLIB match. Returns `{ lyrics, loading }`. */
export function useLyrics(track: PlayerTrack | null, durationMs?: number): { lyrics: SongLyrics; loading: boolean } {
  const [lyrics, setLyrics] = useState<SongLyrics>(EMPTY);
  const [loading, setLoading] = useState(false);
  const id = track?.id ?? "";
  useEffect(() => {
    if (!id) {
      setLyrics(EMPTY);
      setLoading(false);
      return;
    }
    const hit = sessionCache.get(id);
    if (hit) {
      setLyrics(hit);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLyrics(EMPTY);
    void songLyrics({ rel: id, artist: track?.artist, title: track?.title, album: track?.album, durationMs })
      .then((l) => {
        if (cancelled) return;
        // Only cache a positive result so a transient miss (e.g. before duration loaded) can retry.
        if (l.source !== "none") sessionCache.set(id, l);
        setLyrics(l);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return { lyrics, loading };
}
