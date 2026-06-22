// Watch Later — shared store for the native Watch Later queue (baked in from the former extension).
// One JSON array persisted via the `watch_later` setting, with an in-memory cache + pub/sub so the
// WatchLater view AND the right-click "Add to Watch Later" menu actions stay in sync from one source
// of truth. Items added from Discover/Library cards carry a real magnet; items typed into the view
// are title-only (magnet:null). De-dup is case-insensitive by title, matching the view's original add.

import { getSetting, setSetting } from "../ipc/library";

export interface WatchLaterItem {
  id: string;
  title: string;
  magnet?: string | null;
  addedAt: number;
}

const KEY = "watch_later";
let cache: WatchLaterItem[] = [];
let loadedPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => { try { f(); } catch { /* ignore */ } });

function ensureLoaded(): Promise<void> {
  if (!loadedPromise) {
    loadedPromise = getSetting(KEY)
      .then((raw) => { if (raw) { try { const v = JSON.parse(raw); if (Array.isArray(v)) cache = v; } catch { /* fresh */ } } notify(); })
      .catch(() => {});
  }
  return loadedPromise;
}
void ensureLoaded(); // warm the cache on first import

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persistSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void setSetting(KEY, JSON.stringify(cache)).catch(() => {}); }, 300);
}

export function subscribeWatchLater(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** A snapshot of the queue (most-recently-added first, as stored). */
export function getWatchLater(): WatchLaterItem[] {
  return cache.slice();
}

/** True if a title is already queued (case-insensitive) — used to hide the menu action / avoid dups. */
export function isInWatchLater(title: string): boolean {
  const t = title.trim().toLowerCase();
  return !!t && cache.some((i) => i.title.toLowerCase() === t);
}

/** Add a title to the queue. No-op if an equal title (case-insensitive) is already saved.
 *  Returns true if it was added. A magnet is kept when supplied so the view can download it directly. */
export function addToWatchLater(entry: { title: string; magnet?: string | null }): boolean {
  const title = (entry.title || "").trim();
  if (!title || isInWatchLater(title)) return false;
  cache = [{ id: `wl-${Date.now()}`, title, magnet: entry.magnet ?? null, addedAt: Date.now() }, ...cache];
  persistSoon();
  notify();
  return true;
}

/** Remove a queued item by id. */
export function removeFromWatchLater(id: string): void {
  const next = cache.filter((i) => i.id !== id);
  if (next.length !== cache.length) {
    cache = next;
    persistSoon();
    notify();
  }
}
