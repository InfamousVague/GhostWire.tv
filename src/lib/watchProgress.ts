// Continue Watching — native playback-position tracking (baked in from the former extension).
// One JSON blob persisted via the `continue_watching` setting; a tiny pub/sub lets the Discover row
// re-render when the player records progress. Resume-seek is read back when re-opening the same media.

import { getSetting, setSetting } from "../ipc/library";

export interface WatchEntry {
  id: string;
  title: string;
  show?: string;
  season?: number;
  episode?: number;
  position: number;
  duration: number;
  pct: number;
  at: number;
}

const KEY = "continue_watching";
let cache: Record<string, WatchEntry> = {};
let loadedPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => { try { f(); } catch { /* ignore */ } });

function ensureLoaded(): Promise<void> {
  if (!loadedPromise) {
    loadedPromise = getSetting(KEY)
      .then((raw) => { if (raw) { try { const v = JSON.parse(raw); if (v && typeof v === "object") cache = v; } catch { /* fresh */ } } notify(); })
      .catch(() => {});
  }
  return loadedPromise;
}
void ensureLoaded(); // warm the cache on first import

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persistSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void setSetting(KEY, JSON.stringify(cache)).catch(() => {}); }, 400);
}

export function subscribeWatchProgress(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** In-progress titles (2%–95% watched), most-recent first, capped for the Discover row. */
export function getContinueWatching(): WatchEntry[] {
  return Object.values(cache)
    .filter((e) => e.pct >= 2 && e.pct < 95)
    .sort((a, b) => b.at - a.at)
    .slice(0, 16);
}

/** The saved resume position for a media id once the cache is loaded (null if none / finished). */
export async function getResumePosition(id: string): Promise<number | null> {
  await ensureLoaded();
  const e = cache[id];
  return e && e.position > 30 && e.pct < 95 ? e.position : null;
}

/** Record playback progress. Drops the entry at ≥95% / "ended"; ignores the opening 30s; caps to 50. */
export function recordProgress(e: {
  id: string; title: string; show?: string; season?: number; episode?: number;
  position: number; duration: number; state?: "playing" | "paused" | "ended";
}): void {
  const dur = e.duration || 0;
  const pos = e.position || 0;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;
  if (e.state === "ended" || pct >= 95) {
    if (cache[e.id]) { delete cache[e.id]; persistSoon(); notify(); }
    return;
  }
  if (pos < 30) return;
  cache[e.id] = { id: e.id, title: e.title, show: e.show, season: e.season, episode: e.episode, position: pos, duration: dur, pct, at: Date.now() };
  const entries = Object.values(cache).sort((a, b) => b.at - a.at);
  if (entries.length > 50) {
    const keep = new Set(entries.slice(0, 50).map((x) => x.id));
    for (const k of Object.keys(cache)) if (!keep.has(k)) delete cache[k];
  }
  persistSoon();
  notify();
}

export function clearContinueWatching(): void {
  cache = {};
  void setSetting(KEY, "{}").catch(() => {});
  notify();
}
