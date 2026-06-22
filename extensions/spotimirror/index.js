// SpotiMirror — a GhostWire built-in extension (requires the SpotiFLAC extension).
//
// Mirrors your Spotify playlists + Liked Songs into local GhostWire playlists, finds the tracks you
// don't have, and queues them for lossless download through SpotiFLAC's native import queue. As
// downloads land it re-links them into the mirrored playlists automatically.
//
// UI is a 3-column app: the GhostWire nav rail, SpotiMirror's own contextual sidebar (registered via
// the view's `sidebar` render), and a rich main panel with a live download queue.
//
// First-party builtin → reaches native commands directly via gw.native(...):
//   spotify_status / spotify_login / spotify_logout / spotify_my_playlists / spotify_liked_tracks /
//   spotify_playlist_preview, create_playlist / set_playlist_tracks / get_playlist,
//   music_import_enqueue / music_imports_list, get_setting / set_setting — listens to music-imports://state.

let GW = null;
let unsub = null;
let relinkTimer = null;

const cfg = (key, def) => GW.storage.get(key, def);
const setCfg = (key, val) => GW.storage.set(key, val);
const getMap = (key) => {
  const v = GW.storage.get(key, {});
  return v && typeof v === "object" ? v : {};
};
const errStr = (e) => String(e && e.message ? e.message : e);

// ---- shared store (the sidebar + main render functions are separate components; this keeps them
//      in lockstep, and lets the music-imports event feed both) ----
const bus = {
  s: { conn: null, playlists: null, loadingPl: false, tab: "overview", busy: null, progress: null, summary: null, error: null, jobs: [], dlFilter: "active", dlShown: 30, bulkBusy: null, concurrency: 3 },
  subs: new Set(),
  set(patch) {
    Object.assign(this.s, patch);
    for (const fn of this.subs) { try { fn(); } catch { /* ignore */ } }
  },
};
function useBus(React) {
  const [, force] = React.useState(0);
  React.useEffect(() => {
    const fn = () => force((n) => n + 1);
    bus.subs.add(fn);
    return () => bus.subs.delete(fn);
  }, []);
  return bus.s;
}

// ---- engine ----

async function mirrorOne(name, spTracks, mapKey) {
  const plTracks = (spTracks || []).map((t) => ({
    title: t.name, artist: t.artist, album: t.album,
    durationMs: t.durationMs, isrc: t.isrc, spotifyUrl: t.url,
  }));
  const map = getMap("mirrorMap");
  let pl = null;
  if (map[mapKey]) {
    try { pl = await GW.native("set_playlist_tracks", { id: map[mapKey], tracks: plTracks }); }
    catch { pl = null; }
  }
  if (!pl) {
    pl = await GW.native("create_playlist", { name, tracks: plTracks });
    map[mapKey] = pl.id;
    setCfg("mirrorMap", map);
  }
  const tracks = pl.tracks || [];
  return { playlist: pl, missing: tracks.filter((t) => !t.path && t.spotifyUrl), total: tracks.length };
}

async function enqueueMissing(missing) {
  if (!missing || !missing.length) return 0;
  // Reconcile against the live download queue so a track that previously FAILED gets re-run instead
  // of being skipped forever. The old code stamped every URL into `queuedUrls` permanently, so once
  // a download errored it could never be retried by a later sync. We now look at the real job list:
  // a failed job is retried (SpotiFLAC resumes, skipping files already on disk), an in-flight/done
  // job is left alone, and a track with no job at all is freshly enqueued.
  await refreshJobs();
  const byUrl = new Map();
  for (const j of bus.s.jobs || []) { if (j && j.url) byUrl.set(j.url, j); }
  const queued = getMap("queuedUrls");
  let n = 0;
  for (const t of missing) {
    const url = t.spotifyUrl;
    if (!url) continue;
    const job = byUrl.get(url);
    if (job) {
      if (job.state === "error") {
        try { await GW.native("music_import_retry", { id: job.id }); n++; }
        catch (e) { GW.log("retry failed", url, e); }
      }
      queued[url] = true;
      continue;
    }
    try {
      await GW.native("music_import_enqueue", { url });
      queued[url] = true; n++;
      await new Promise((r) => setTimeout(r, 120));
    } catch (e) { GW.log("enqueue failed", url, e); }
  }
  setCfg("queuedUrls", queued);
  return n;
}

async function syncAll(onProgress) {
  const status = await GW.native("spotify_status");
  if (!status || !status.connected) throw new Error("Connect your Spotify account first.");
  const playlists = await GW.native("spotify_my_playlists");
  const selected = getMap("selected");
  const targets = (playlists || []).filter((p) => selected[p.id] !== false);
  const includeLiked = cfg("includeLiked", true);
  const steps = targets.length + (includeLiked ? 1 : 0);

  let done = 0, missingTotal = 0, enqueuedTotal = 0;
  const errors = [], perPlaylist = [];

  for (const sp of targets) {
    if (onProgress) onProgress({ label: sp.name, done, steps });
    try {
      const preview = await GW.native("spotify_playlist_preview", { playlistUrl: sp.url });
      const { missing, total } = await mirrorOne(sp.name, preview.tracks || [], sp.id);
      const enq = await enqueueMissing(missing);
      perPlaylist.push({ id: sp.id, name: sp.name, total, missing: missing.length, enqueued: enq });
      missingTotal += missing.length; enqueuedTotal += enq;
    } catch (e) { errors.push(`${sp.name}: ${errStr(e)}`); }
    done++;
  }
  if (includeLiked) {
    if (onProgress) onProgress({ label: "Liked Songs", done, steps });
    try {
      const liked = await GW.native("spotify_liked_tracks");
      const { missing, total } = await mirrorOne("Liked Songs", liked || [], "__liked__");
      const enq = await enqueueMissing(missing);
      perPlaylist.push({ id: "__liked__", name: "Liked Songs", total, missing: missing.length, enqueued: enq });
      missingTotal += missing.length; enqueuedTotal += enq;
    } catch (e) { errors.push(`Liked Songs: ${errStr(e)}`); }
    done++;
  }
  if (onProgress) onProgress({ label: "Done", done: steps, steps });
  const res = { playlists: targets.length, missing: missingTotal, enqueued: enqueuedTotal, errors, perPlaylist, at: Date.now() };
  setCfg("lastSyncAt", res.at); setCfg("lastSummary", res);
  return res;
}

async function relinkOnly() {
  const map = getMap("mirrorMap");
  for (const id of Object.values(map)) {
    try { await GW.native("get_playlist", { id }); } catch { /* deleted */ }
  }
}
function scheduleRelink() {
  if (!cfg("autoRelink", true)) return;
  if (relinkTimer) clearTimeout(relinkTimer);
  relinkTimer = setTimeout(() => { relinkOnly().then(() => detectSync(false)).catch(() => {}); }, 4000);
}

// ---- intelligent sync detection (figures out what's already local, downloads nothing) ----
const normKey = (title, artist) => `${(title || "").toLowerCase().trim()}::${(artist || "").toLowerCase().trim()}`;

async function localIndex() {
  try {
    const items = await GW.native("list_downloaded");
    const set = new Set();
    for (const it of items || []) { if (it && it.title) set.add(normKey(it.title, it.artist)); }
    return set;
  } catch { return new Set(); }
}

/** Work out, per playlist, how many of its tracks are already in the local library — WITHOUT
 *  downloading. Cheap path: a playlist already mirrored locally is read back (get_playlist resolves
 *  file paths, so a null path = still missing). Deep path (deep=true): also fetch + match playlists
 *  that have no mirror yet against the library index, so even never-synced playlists report real state. */
async function detectSync(deep, onProgress) {
  const playlists = bus.s.playlists || [];
  const map = getMap("mirrorMap");
  const detect = { ...(bus.s.detect || {}) };
  const targets = deep ? playlists : playlists.filter((p) => map[p.id]);
  let idx = null, done = 0;
  for (const p of targets) {
    if (onProgress) onProgress({ label: p.name, done, steps: targets.length });
    try {
      if (map[p.id]) {
        const pl = await GW.native("get_playlist", { id: map[p.id] });
        const tracks = pl.tracks || [];
        detect[p.id] = { total: tracks.length, missing: tracks.filter((t) => !t.path).length };
      } else if (deep) {
        if (!idx) idx = await localIndex();
        const preview = await GW.native("spotify_playlist_preview", { playlistUrl: p.url });
        const tracks = preview.tracks || [];
        detect[p.id] = { total: tracks.length, missing: tracks.filter((t) => !idx.has(normKey(t.name, t.artist))).length };
        await new Promise((r) => setTimeout(r, 80));
      }
    } catch (e) { GW.log("detect failed", p.name, e); }
    done++;
    bus.set({ detect: { ...detect } });
  }
  if (map["__liked__"]) {
    try {
      const pl = await GW.native("get_playlist", { id: map["__liked__"] });
      const tracks = pl.tracks || [];
      detect["__liked__"] = { total: tracks.length, missing: tracks.filter((t) => !t.path).length };
    } catch { /* deleted */ }
  }
  setCfg("detect", detect);
  bus.set({ detect });
}
function fmtWhen(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---- actions (mutate the shared store) ----
async function refreshConn() {
  try { bus.set({ conn: await GW.native("spotify_status") }); }
  catch { bus.set({ conn: { connected: false, hasCredentials: false } }); }
}
async function loadPlaylists() {
  bus.set({ loadingPl: true, error: null });
  try { bus.set({ playlists: await GW.native("spotify_my_playlists") }); }
  catch (e) { bus.set({ error: errStr(e) }); }
  finally { bus.set({ loadingPl: false }); }
}
async function refreshJobs() {
  try { const j = await GW.native("music_imports_list"); bus.set({ jobs: Array.isArray(j) ? j : [] }); }
  catch { /* desktop-only */ }
}
async function connectSpotify() {
  bus.set({ busy: "connect", error: null });
  try { await GW.native("spotify_login"); await refreshConn(); await loadPlaylists(); }
  catch (e) { bus.set({ error: errStr(e) }); }
  finally { bus.set({ busy: null }); }
}
async function disconnectSpotify() {
  try { await GW.native("spotify_logout"); } catch { /* ignore */ }
  bus.set({ playlists: null });
  await refreshConn();
}
async function runSync() {
  bus.set({ busy: "sync", error: null, tab: "downloads", progress: { label: "Starting…", done: 0, steps: 1, verb: "Mirroring" } });
  try { const s = await syncAll((p) => bus.set({ progress: { ...p, verb: "Mirroring" } })); bus.set({ summary: s }); await detectSync(false); }
  catch (e) { bus.set({ error: errStr(e) }); }
  finally { bus.set({ busy: null, progress: null }); }
}
const setTab = (tab) => bus.set({ tab });
const toggleSel = (id) => { const m = getMap("selected"); m[id] = m[id] === false ? true : false; setCfg("selected", m); bus.set({}); };
const setAll = (on) => { const m = {}; for (const p of bus.s.playlists || []) m[p.id] = on; setCfg("selected", m); bus.set({}); };
async function runDetect() {
  bus.set({ detecting: true, error: null });
  try { await detectSync(true, (p) => bus.set({ progress: { ...p, verb: "Scanning" } })); }
  catch (e) { bus.set({ error: errStr(e) }); }
  finally { bus.set({ detecting: false, progress: null }); }
}

// ---- download-queue actions (filter / retry / resume / remove) ----
const setDlFilter = (f) => bus.set({ dlFilter: f, dlShown: 30 });
const showMoreDl = () => bus.set({ dlShown: (bus.s.dlShown || 30) + 30 });

/** Re-run a single failed/finished import. Retry sets it back to "queued"; SpotiFLAC resumes the
 *  collection, skipping anything already on disk. */
async function retryJob(id) {
  try { await GW.native("music_import_retry", { id }); await refreshJobs(); }
  catch (e) { GW.log("retry failed", id, e); }
}
async function removeJob(id) {
  try { await GW.native("music_import_remove", { id }); await refreshJobs(); }
  catch (e) { GW.log("remove failed", id, e); }
}
async function retryAllFailed() {
  const failed = (bus.s.jobs || []).filter((j) => j.state === "error");
  if (!failed.length) return;
  bus.set({ bulkBusy: "retry" });
  try {
    for (const j of failed) {
      try { await GW.native("music_import_retry", { id: j.id }); }
      catch (e) { GW.log("retry failed", j.id, e); }
    }
    await refreshJobs();
  } finally { bus.set({ bulkBusy: null }); }
}
async function clearJobs(states, busyTag) {
  bus.set({ bulkBusy: busyTag });
  try { await GW.native("music_imports_clear", { states }); await refreshJobs(); }
  catch (e) { GW.log("clear failed", e); }
  finally { bus.set({ bulkBusy: null }); }
}
const clearFinished = () => clearJobs(["done"], "clear");
const clearQueued = () => clearJobs(["queued"], "clearq");

/** Delete any 30s preview clips a provider saved instead of the real song, then re-queue full
 *  downloads for them (the de-duped enqueue makes fresh jobs since the old ones are "done"). */
async function fixPreviews() {
  bus.set({ bulkBusy: "previews" });
  try {
    const urls = await GW.native("music_purge_previews");
    for (const url of urls || []) {
      try { await GW.native("music_import_enqueue", { url }); }
      catch (e) { GW.log("re-enqueue failed", url, e); }
    }
    await refreshJobs();
  } catch (e) { GW.log("fix previews failed", e); bus.set({ error: errStr(e) }); }
  finally { bus.set({ bulkBusy: null }); }
}

// ---- simultaneous-downloads control (backed by the native music_import_concurrency setting) ----
async function loadConcurrency() {
  try {
    const v = await GW.native("get_setting", { key: "music_import_concurrency" });
    bus.set({ concurrency: Math.max(1, Math.min(6, parseInt(v, 10) || 3)) });
  } catch { /* desktop-only */ }
}
async function setConcurrency(n) {
  const v = Math.max(1, Math.min(6, n));
  bus.set({ concurrency: v });
  try { await GW.native("set_setting", { key: "music_import_concurrency", value: String(v) }); }
  catch (e) { GW.log("set concurrency failed", e); }
}

const STYLE = `
.smr-side { display:flex; flex-direction:column; gap:14px; padding:6px 2px; }
.smr-brand { display:flex; align-items:center; gap:11px; }
.smr-badge-ic { width:42px; height:42px; border-radius:13px; display:grid; place-items:center; color:#04121a; flex:0 0 auto;
  background:linear-gradient(135deg, var(--gg-seafoam, #5fe1e9), var(--gg-teal, #2dcdd6)); box-shadow:0 8px 22px rgba(95,225,233,.30); }
.smr-brand-title { font-size:16px; font-weight:800; letter-spacing:.2px; }
.smr-brand-sub { font-size:10.5px; opacity:.55; margin-top:1px; }
.smr-conn { display:flex; align-items:center; gap:8px; padding:9px 11px; border-radius:11px;
  background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.07); font-size:12px; }
.smr-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
.smr-side-nav { display:flex; flex-direction:column; gap:3px; }
.smr-nav-item { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:11px; cursor:pointer;
  border:1px solid transparent; color:inherit; background:transparent; font-size:13px; font-weight:600; text-align:left;
  width:100%; transition:background .15s, border-color .15s; }
.smr-nav-item:hover { background:rgba(255,255,255,.05); }
.smr-nav-item.on { background:color-mix(in srgb, var(--gg-seafoam, #5fe1e9) 16%, transparent);
  border-color:color-mix(in srgb, var(--gg-seafoam, #5fe1e9) 40%, transparent); }
.smr-nav-item .ct { font-size:11px; font-weight:800; opacity:.85; background:color-mix(in srgb, var(--gg-seafoam, #5fe1e9) 22%, transparent);
  color:var(--gg-seafoam, #5fe1e9); padding:1px 8px; border-radius:999px; }
.smr-side-cta { display:flex; flex-direction:column; gap:8px; margin-top:4px; }
.smr-main { display:flex; flex-direction:column; gap:18px; min-width:0; }
.smr-hero { position:relative; overflow:hidden; border-radius:20px; padding:24px 26px;
  background:radial-gradient(130% 150% at 0% 0%, color-mix(in srgb, var(--gg-seafoam, #5fe1e9) 28%, transparent), transparent 58%),
  linear-gradient(135deg, rgba(95,225,233,.10), rgba(45,205,214,.03)); border:1px solid rgba(255,255,255,.08); }
.smr-hero h2 { margin:0 0 6px; font-size:22px; font-weight:800; }
.smr-hero p { margin:0; opacity:.72; font-size:13px; max-width:580px; line-height:1.5; }
.smr-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(132px,1fr)); gap:12px; }
.smr-stat { padding:16px 18px; border-radius:15px; background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.06); }
.smr-stat .n { font-size:26px; font-weight:800; line-height:1; }
.smr-stat .l { font-size:10.5px; opacity:.6; margin-top:7px; text-transform:uppercase; letter-spacing:.6px; display:flex; align-items:center; gap:6px; }
.smr-sec-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.smr-sec-title { font-size:15px; font-weight:700; display:flex; align-items:center; gap:8px; }
.smr-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:16px; }
.smr-tile { position:relative; border-radius:15px; overflow:hidden; cursor:pointer; background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.06); transition:transform .16s, border-color .16s, box-shadow .16s; }
.smr-tile:hover { transform:translateY(-3px); border-color:color-mix(in srgb, var(--gg-seafoam, #5fe1e9) 42%, transparent); box-shadow:0 10px 26px rgba(0,0,0,.28); }
.smr-tile.sel { border-color:var(--gg-seafoam, #5fe1e9); }
.smr-tile:not(.sel) { opacity:.7; }
.smr-tile:not(.sel):hover { opacity:1; }
.smr-art { aspect-ratio:1; width:100%; object-fit:cover; display:grid; place-items:center;
  background:linear-gradient(135deg, rgba(95,225,233,.20), rgba(45,205,214,.05)); }
.smr-art-ph { color:color-mix(in srgb, var(--gg-seafoam, #5fe1e9) 70%, #fff); }
.smr-tile-body { padding:11px 13px; }
.smr-tile-name { font-size:13px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.smr-tile-sub { font-size:11px; opacity:.6; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.smr-check { position:absolute; top:9px; right:9px; width:24px; height:24px; border-radius:7px; display:grid; place-items:center;
  background:rgba(0,0,0,.45); color:transparent; border:1.5px solid rgba(255,255,255,.5); transition:background .15s, border-color .15s; z-index:1; }
.smr-check.on { background:var(--gg-seafoam, #5fe1e9); color:#04121a; border-color:var(--gg-seafoam, #5fe1e9); }
.smr-tile-foot { margin-top:9px; }
.smr-status { display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:700; opacity:.82; }
.smr-status.ok { color:var(--gg-seafoam, #5fe1e9); opacity:1; }
.smr-status.miss { color:#ffb020; opacity:1; }
.smr-sdot { width:7px; height:7px; border-radius:50%; flex:0 0 auto; }
.smr-sdot.none { background:rgba(255,255,255,.32); }
.smr-sdot.ok { background:var(--gg-seafoam, #5fe1e9); }
.smr-sdot.miss { background:#ffb020; }
.smr-empty { padding:48px 24px; text-align:center; opacity:.62; font-size:13px; border-radius:16px; border:1px dashed rgba(255,255,255,.13); }
.smr-bar { height:8px; border-radius:999px; background:rgba(255,255,255,.08); overflow:hidden; }
.smr-bar > i { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg, var(--gg-seafoam, #5fe1e9), var(--gg-teal, #2dcdd6)); transition:width .3s; }
.smr-card { padding:18px 20px; border-radius:16px; background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.07); }
.smr-step { display:flex; gap:13px; align-items:flex-start; padding:13px 0; }
.smr-step + .smr-step { border-top:1px solid rgba(255,255,255,.06); }
.smr-step-ic { width:34px; height:34px; border-radius:11px; display:grid; place-items:center; flex:0 0 auto;
  background:color-mix(in srgb, var(--gg-seafoam, #5fe1e9) 15%, transparent); color:var(--gg-seafoam, #5fe1e9); }
.smr-step b { font-size:13px; } .smr-step p { margin:3px 0 0; font-size:12px; opacity:.65; line-height:1.45; }
.smr-row { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:13px 0; }
.smr-row + .smr-row { border-top:1px solid rgba(255,255,255,.06); }
.smr-queue { display:flex; flex-direction:column; gap:12px; }
.smr-job { display:flex; gap:14px; align-items:center; padding:13px; border-radius:15px;
  background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.06); }
.smr-job-art { width:54px; height:54px; border-radius:10px; object-fit:cover; flex:0 0 auto; display:grid; place-items:center;
  background:linear-gradient(135deg, rgba(95,225,233,.20), rgba(45,205,214,.05)); color:color-mix(in srgb, var(--gg-seafoam, #5fe1e9) 70%, #fff); }
.smr-job-title { font-size:13px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.smr-job-sub { font-size:11px; opacity:.6; margin-top:1px; text-transform:capitalize; }
.smr-job-cur { font-size:11px; opacity:.7; margin-top:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.smr-job-state { font-size:12px; font-weight:800; flex:0 0 auto; text-transform:capitalize; }
.smr-job-side { display:flex; flex-direction:column; align-items:flex-end; gap:8px; flex:0 0 auto; }
.smr-job-actions { display:flex; align-items:center; gap:6px; }
.smr-dlfilters { display:flex; flex-wrap:wrap; gap:8px; }
.smr-chip { display:inline-flex; align-items:center; gap:7px; padding:7px 13px; border-radius:999px; cursor:pointer; font-size:12px; font-weight:700;
  background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); color:inherit; transition:background .15s, border-color .15s, color .15s; }
.smr-chip:hover { background:rgba(255,255,255,.07); }
.smr-chip.on { background:color-mix(in srgb, var(--gg-seafoam, #5fe1e9) 18%, transparent); border-color:color-mix(in srgb, var(--gg-seafoam, #5fe1e9) 45%, transparent); color:var(--gg-seafoam, #5fe1e9); }
.smr-chip .c { font-size:11px; font-weight:800; opacity:.9; padding:0 7px; border-radius:999px; background:rgba(255,255,255,.10); min-width:18px; text-align:center; }
.smr-chip.on .c { background:color-mix(in srgb, var(--gg-seafoam, #5fe1e9) 30%, transparent); }
.smr-chip.danger { color:#ff9b9b; border-color:rgba(255,107,107,.32); }
.smr-chip.danger.on { background:color-mix(in srgb, #ff6b6b 16%, transparent); border-color:rgba(255,107,107,.5); color:#ffb3b3; }
.smr-chip.danger .c { background:rgba(255,107,107,.18); }
.smr-more { display:flex; justify-content:center; padding:6px 0 2px; }
.smr-bar.indet { position:relative; overflow:hidden; }
.smr-bar.indet > i { position:absolute; top:0; left:0; width:38%; height:100%; transform:translateX(-110%);
  background:linear-gradient(90deg, transparent, var(--gg-seafoam, #5fe1e9), transparent); animation:smr-indet 1.15s ease-in-out infinite; }
@keyframes smr-indet { 0% { transform:translateX(-110%); } 100% { transform:translateX(320%); } }
.smr-conc { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; border-radius:13px;
  background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.07); }
.smr-conc-l { display:flex; align-items:center; gap:8px; font-size:12.5px; font-weight:600; opacity:.85; }
.smr-conc-step { display:flex; align-items:center; gap:6px; }
.smr-conc-n { min-width:20px; text-align:center; font-size:14px; font-weight:800; }
`;

// ---- renders ----

function sideRender({ React, ui }) {
  const h = React.createElement;
  const ic = (n, s) => h(ui.Icon, { icon: ui.icons[n], size: s || "sm" });
  const st = useBus(React);
  const connected = !!(st.conn && st.conn.connected);
  const hasCreds = !!(st.conn && st.conn.hasCredentials);
  const pls = st.playlists || [];
  const active = (st.jobs || []).filter((j) => j.state === "downloading" || j.state === "queued").length;

  const navItem = (id, icon, label, count) =>
    h("button", { key: id, className: `smr-nav-item${st.tab === id ? " on" : ""}`, onClick: () => setTab(id) },
      ic(icon), h("span", { style: { flex: 1 } }, label), count ? h("span", { className: "ct" }, count) : null);

  return h(React.Fragment, null,
    h("style", null, STYLE),
    h("div", { className: "smr-side" },
      h("div", { className: "smr-brand" },
        h("div", { className: "smr-badge-ic" }, ic("rotateCw", "base")),
        h("div", null,
          h("div", { className: "smr-brand-title" }, "SpotiMirror"),
          h("div", { className: "smr-brand-sub" }, "Spotify → your library"),
        ),
      ),
      h("div", { className: "smr-conn" },
        h("span", { className: "smr-dot", style: { background: connected ? "var(--gg-seafoam, #5fe1e9)" : "#ff6b6b", boxShadow: connected ? "0 0 10px var(--gg-seafoam, #5fe1e9)" : "none" } }),
        connected ? h("span", null, "Connected") : h("span", { style: { opacity: .7 } }, hasCreds ? "Not connected" : "Setup needed"),
      ),
      h("div", { className: "smr-side-nav" },
        navItem("overview", "sparkles", "Overview"),
        navItem("playlists", "list", "Playlists", connected ? pls.length : 0),
        navItem("liked", "star", "Liked Songs"),
        navItem("downloads", "download", "Downloads", active),
      ),
      h("div", { className: "smr-side-cta" },
        st.progress ? h("div", null,
          h("div", { style: { fontSize: 11, opacity: .7, marginBottom: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `${st.progress.verb || "Working"} ${st.progress.label}…`),
          h("div", { className: "smr-bar" }, h("i", { style: { width: `${st.progress.steps ? Math.round(st.progress.done / st.progress.steps * 100) : 0}%` } })),
        ) : null,
        connected
          ? h(ui.Button, { variant: "primary", shape: "pill", size: "lg", icon: ui.icons.rotateCw, onClick: runSync, disabled: st.busy === "sync" }, st.busy === "sync" ? "Syncing…" : "Sync now")
          : h(ui.Button, { variant: "primary", shape: "pill", size: "lg", icon: ui.icons.link2, onClick: connectSpotify, disabled: st.busy === "connect" || !hasCreds }, st.busy === "connect" ? "Waiting…" : "Connect Spotify"),
        connected ? h(ui.Button, { variant: "ghost", shape: "pill", icon: ui.icons.x, onClick: disconnectSpotify }, "Disconnect") : null,
        h("div", { style: { fontSize: 10.5, opacity: .5, textAlign: "center", marginTop: 2 } }, `Last sync ${fmtWhen(cfg("lastSyncAt", 0))}`),
      ),
    ),
  );
}

function mainRender({ React, ui }) {
  const h = React.createElement;
  const ic = (n, s) => h(ui.Icon, { icon: ui.icons[n], size: s || "sm" });
  const st = useBus(React);
  const connected = !!(st.conn && st.conn.connected);
  const hasCreds = !!(st.conn && st.conn.hasCredentials);
  const pls = st.playlists || [];
  const selected = getMap("selected");
  const selCount = pls.filter((p) => selected[p.id] !== false).length;
  const trackTotal = pls.reduce((a, p) => a + (p.trackCount || 0), 0);
  // Per-playlist sync state: live detection (current local state) wins over the last sync summary.
  const statusMap = {};
  if (st.summary && st.summary.perPlaylist) for (const r of st.summary.perPlaylist) statusMap[r.id] = { total: r.total, missing: r.missing };
  const det = st.detect || {};
  for (const id in det) statusMap[id] = det[id];
  const inSyncCount = pls.filter((p) => statusMap[p.id] && statusMap[p.id].missing === 0).length;
  const activeJobs = (st.jobs || []).filter((j) => j.state === "downloading" || j.state === "queued").length;
  let detMissing = 0, detKnown = false;
  for (const p of pls) { const s = statusMap[p.id]; if (s) { detMissing += s.missing; detKnown = true; } }

  const stat = (n, label, icon) => h("div", { className: "smr-stat" }, h("div", { className: "n" }, n), h("div", { className: "l" }, ic(icon), label));
  const step = (icon, title, body) => h("div", { className: "smr-step" }, h("div", { className: "smr-step-ic" }, ic(icon)), h("div", null, h("b", null, title), h("p", null, body)));

  const overview = h("div", { className: "smr-main" },
    h("div", { className: "smr-hero" },
      h("h2", null, connected ? "Your Spotify, mirrored locally" : "Connect Spotify to begin"),
      h("p", null, connected
        ? "SpotiMirror keeps your playlists and Liked Songs in lockstep with your library, and downloads anything missing in lossless quality through SpotiFLAC."
        : "Link Spotify to mirror your playlists and auto-download missing tracks. Add your free Spotify app credentials in this extension’s settings first."),
    ),
    h("div", { className: "smr-stats" },
      stat(connected ? pls.length : "—", "Playlists", "list"),
      stat(connected ? trackTotal : "—", "Tracks", "music"),
      stat(connected ? inSyncCount : "—", "In sync", "check"),
      stat(detKnown ? detMissing : (st.summary ? st.summary.missing : "—"), "Missing", "download"),
      stat(activeJobs, "Downloading", "rotateCw"),
    ),
    st.summary && st.summary.errors && st.summary.errors.length > 0 && h("div", { className: "smr-card" },
      h("div", { className: "smr-sec-title", style: { marginBottom: 6 } }, ic("triangleAlert"), "Last sync issues"),
      h("ul", { className: "field-hint", style: { margin: 0, paddingLeft: 18 } }, st.summary.errors.slice(0, 6).map((er, i) => h("li", { key: i }, er))),
    ),
    h("div", { className: "smr-card" },
      h("div", { className: "smr-sec-title", style: { marginBottom: 4 } }, ic("gauge"), "How it works"),
      step("list", "Mirror playlists", "Each selected Spotify playlist becomes a local playlist, matched to files you already have."),
      step("download", "Fill the gaps", "Tracks with no local match queue in SpotiFLAC for lossless download — de-duped so nothing downloads twice."),
      step("check", "Auto re-link", "As downloads land they’re linked into their playlists automatically."),
    ),
  );

  const tile = (p) => {
    const sel = selected[p.id] !== false;
    const s = statusMap[p.id];
    const miss = s ? s.missing : null;
    const count = (p.trackCount || 0) || (s && s.total) || 0;
    let status;
    if (miss == null) status = h("span", { className: "smr-status" }, h("i", { className: "smr-sdot none" }), "Not synced");
    else if (miss === 0) status = h("span", { className: "smr-status ok" }, h("i", { className: "smr-sdot ok" }), "In sync");
    else status = h("span", { className: "smr-status miss" }, h("i", { className: "smr-sdot miss" }), `${miss} missing`);
    return h("div", { className: `smr-tile${sel ? " sel" : ""}`, key: p.id, onClick: () => toggleSel(p.id), title: sel ? "Selected to sync — click to exclude" : "Click to include in sync" },
      h("div", { className: `smr-check${sel ? " on" : ""}` }, sel ? ic("check") : null),
      p.image
        ? h("img", { className: "smr-art", src: p.image, alt: "", loading: "lazy" })
        : h("div", { className: "smr-art smr-art-ph" }, ic("music", "lg")),
      h("div", { className: "smr-tile-body" },
        h("div", { className: "smr-tile-name" }, p.name),
        h("div", { className: "smr-tile-sub" }, `${count} song${count === 1 ? "" : "s"}${p.owner ? ` · ${p.owner}` : ""}`),
        h("div", { className: "smr-tile-foot" }, status),
      ),
    );
  };

  const playlistsPanel = h("div", { className: "smr-main" },
    h("div", { className: "smr-sec-head" },
      h("div", { className: "smr-sec-title" }, ic("list"), "Playlists",
        h("span", { style: { opacity: .55, fontWeight: 600 } }, pls.length ? `· ${selCount}/${pls.length} selected` : "")),
      pls.length > 0 && h("div", { style: { display: "flex", gap: 8 } },
        h(ui.Button, { variant: "ghost", shape: "pill", onClick: () => setAll(true) }, "All"),
        h(ui.Button, { variant: "ghost", shape: "pill", onClick: () => setAll(false) }, "None"),
        h(ui.Button, { variant: "secondary", shape: "pill", icon: ui.icons.search, onClick: runDetect, disabled: st.detecting }, st.detecting ? "Detecting…" : "Detect"),
        h(ui.Button, { variant: "ghost", shape: "pill", icon: ui.icons.rotateCw, onClick: loadPlaylists, disabled: st.loadingPl }, "Reload"),
      ),
    ),
    !connected ? h("div", { className: "smr-empty" }, "Connect Spotify to see your playlists.")
      : st.loadingPl ? h("div", { className: "smr-empty" }, "Loading your playlists…")
      : pls.length === 0 ? h("div", { className: "smr-empty" }, "No playlists found on your account.")
      : h("div", { className: "smr-grid" }, pls.map(tile)),
  );

  const includeLiked = cfg("includeLiked", true);
  const autoRelink = cfg("autoRelink", true);
  const likedPanel = h("div", { className: "smr-main" },
    h("div", { className: "smr-card", style: { display: "flex", gap: 18, alignItems: "center" } },
      h("div", { className: "smr-badge-ic", style: { width: 64, height: 64, borderRadius: 18 } }, ic("star", "lg")),
      h("div", { style: { flex: 1 } },
        h("div", { style: { fontSize: 17, fontWeight: 800 } }, "Liked Songs"),
        h("p", { className: "field-hint", style: { margin: "4px 0 0", maxWidth: 460 } },
          "Mirror your Spotify ❤ into a local “Liked Songs” playlist and download anything missing."),
      ),
      h(ui.Toggle, { checked: includeLiked, onChange: (e) => { setCfg("includeLiked", !!e.currentTarget.checked); bus.set({}); } }),
    ),
    h("div", { className: "smr-card" },
      h("div", { className: "smr-row", style: { paddingTop: 0 } },
        h("div", null, h("b", { style: { fontSize: 13 } }, "Auto re-link on download"),
          h("p", { className: "field-hint", style: { margin: "3px 0 0" } }, "Link freshly-downloaded tracks into their playlists automatically.")),
        h(ui.Toggle, { checked: autoRelink, onChange: (e) => { setCfg("autoRelink", !!e.currentTarget.checked); bus.set({}); } }),
      ),
      h("p", { className: "field-hint", style: { margin: "10px 0 0" } },
        "Liked Songs needs library access — if you connected before installing SpotiMirror, disconnect and reconnect once to grant it."),
    ),
  );

  const jobs = st.jobs || [];
  const STATE_LABEL = { downloading: "Downloading", queued: "Queued", done: "Done", error: "Failed" };
  const counts = { downloading: 0, queued: 0, done: 0, error: 0 };
  for (const j of jobs) { if (counts[j.state] != null) counts[j.state]++; }
  const activeCount = counts.downloading + counts.queued;
  const dlFilter = st.dlFilter || "active";
  const dlShown = st.dlShown || 30;
  const conc = st.concurrency || 3;
  const matchFilter = (j) =>
    dlFilter === "all" ? true
      : dlFilter === "active" ? (j.state === "downloading" || j.state === "queued")
      : j.state === dlFilter;
  // Surface what's actually happening first: downloading → queued → failed → done, newest within each.
  const ORDER = { downloading: 0, queued: 1, error: 2, done: 3 };
  const filtered = jobs.filter(matchFilter)
    .sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || ((b.createdAt || 0) - (a.createdAt || 0)));
  const visible = filtered.slice(0, dlShown);

  const jobCard = (j) => {
    const pct = j.total ? Math.round((j.completed / j.total) * 100) : (j.state === "done" ? 100 : j.state === "downloading" ? 8 : 0);
    const col = j.state === "error" ? "#ff6b6b" : j.state === "queued" ? "#9aa0a6" : "var(--gg-seafoam, #5fe1e9)";
    return h("div", { className: "smr-job", key: j.id },
      j.artworkUrl
        ? h("img", { className: "smr-job-art", src: j.artworkUrl, alt: "", loading: "lazy" })
        : h("div", { className: "smr-job-art" }, ic("music")),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { className: "smr-job-title" }, j.title || j.url),
        h("div", { className: "smr-job-sub" }, `${STATE_LABEL[j.state] || j.state} · ${j.subtitle || j.kind || "music"}`),
        j.state === "downloading"
          ? h("div", { className: "smr-bar indet", style: { marginTop: 8 } }, h("i", null))
          : h("div", { className: "smr-bar", style: { marginTop: 8 } }, h("i", { style: { width: `${pct}%`, background: j.state === "error" ? "#ff6b6b" : undefined } })),
        (j.state === "error" && j.error)
          ? h("div", { className: "smr-job-cur", style: { color: "#ff9b9b" }, title: j.error }, j.error.split("\n")[0])
          : j.currentTrack ? h("div", { className: "smr-job-cur" }, `Saved ${j.currentTrack}`) : null,
      ),
      h("div", { className: "smr-job-side" },
        h("div", { className: "smr-job-state", style: { color: col } }, j.total ? `${j.completed}/${j.total}` : (STATE_LABEL[j.state] || j.state)),
        h("div", { className: "smr-job-actions" },
          j.state === "error"
            ? h(ui.Button, { variant: "secondary", shape: "pill", size: "sm", icon: ui.icons.rotateCw, onClick: () => retryJob(j.id) }, "Retry")
            : null,
          j.state !== "downloading"
            ? h(ui.Button, { variant: "ghost", shape: "pill", size: "sm", iconOnly: true, icon: ui.icons.x, title: "Remove from queue", "aria-label": "Remove from queue", onClick: () => removeJob(j.id) })
            : null,
        ),
      ),
    );
  };

  const dlChip = (id, label, count, danger) =>
    h("button", { key: id, className: `smr-chip${dlFilter === id ? " on" : ""}${danger && count > 0 ? " danger" : ""}`, onClick: () => setDlFilter(id) },
      label, h("span", { className: "c" }, count));

  const emptyFilterMsg = dlFilter === "error" ? "No failed downloads — nice."
    : dlFilter === "active" ? "Nothing downloading right now."
    : dlFilter === "done" ? "No finished downloads yet."
    : "Nothing here yet.";

  const downloadsPanel = h("div", { className: "smr-main" },
    h("div", { className: "smr-sec-head" },
      h("div", { className: "smr-sec-title" }, ic("download"), "Download queue",
        h("span", { style: { opacity: .55, fontWeight: 600 } }, jobs.length ? `· ${jobs.length}` : "")),
      h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        counts.error > 0
          ? h(ui.Button, { variant: "secondary", shape: "pill", icon: ui.icons.rotateCw, onClick: retryAllFailed, disabled: st.bulkBusy === "retry" }, st.bulkBusy === "retry" ? "Retrying…" : `Retry failed (${counts.error})`)
          : null,
        counts.done > 0
          ? h(ui.Button, { variant: "ghost", shape: "pill", icon: ui.icons.check, onClick: clearFinished, disabled: st.bulkBusy === "clear" }, "Clear finished")
          : null,
        counts.queued > 0
          ? h(ui.Button, { variant: "ghost", shape: "pill", icon: ui.icons.x, onClick: clearQueued, disabled: st.bulkBusy === "clearq" }, st.bulkBusy === "clearq" ? "Clearing…" : `Clear queued (${counts.queued})`)
          : null,
        h(ui.Button, { variant: "ghost", shape: "pill", icon: ui.icons.triangleAlert, onClick: fixPreviews, disabled: st.bulkBusy === "previews" }, st.bulkBusy === "previews" ? "Fixing…" : "Fix 30s previews"),
        h(ui.Button, { variant: "ghost", shape: "pill", icon: ui.icons.rotateCw, onClick: refreshJobs }, "Refresh"),
      ),
    ),
    st.progress && h("div", { className: "smr-card" },
      h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, `${st.progress.verb || "Working"} ${st.progress.label} · ${st.progress.done}/${st.progress.steps}`),
      h("div", { className: "smr-bar" }, h("i", { style: { width: `${st.progress.steps ? Math.round(st.progress.done / st.progress.steps * 100) : 0}%` } })),
    ),
    jobs.length > 0 && h("div", { className: "smr-conc" },
      h("span", { className: "smr-conc-l" }, ic("gauge"), "Simultaneous downloads"),
      h("div", { className: "smr-conc-step" },
        h(ui.Button, { variant: "ghost", shape: "pill", size: "sm", disabled: conc <= 1, onClick: () => setConcurrency(conc - 1), title: "Fewer at once", "aria-label": "Fewer at once" }, "−"),
        h("span", { className: "smr-conc-n" }, conc),
        h(ui.Button, { variant: "ghost", shape: "pill", size: "sm", disabled: conc >= 6, onClick: () => setConcurrency(conc + 1), title: "More at once", "aria-label": "More at once" }, "+"),
      ),
    ),
    jobs.length > 0 && h("div", { className: "smr-dlfilters" },
      dlChip("active", "Active", activeCount),
      dlChip("error", "Failed", counts.error, true),
      dlChip("done", "Done", counts.done),
      dlChip("all", "All", jobs.length),
    ),
    jobs.length === 0
      ? h("div", { className: "smr-empty" }, "Nothing downloading. Missing tracks you sync will appear here with live progress.")
      : filtered.length === 0
        ? h("div", { className: "smr-empty" }, emptyFilterMsg)
        : h(React.Fragment, null,
            h("div", { className: "smr-queue" }, visible.map(jobCard)),
            filtered.length > visible.length
              ? h("div", { className: "smr-more" },
                  h(ui.Button, { variant: "ghost", shape: "pill", onClick: showMoreDl }, `Show more (${filtered.length - visible.length})`))
              : null,
          ),
  );

  const panel = st.tab === "playlists" ? playlistsPanel : st.tab === "liked" ? likedPanel : st.tab === "downloads" ? downloadsPanel : overview;
  const banner = !hasCreds && st.conn !== null && h("div", { className: "smr-card", style: { borderColor: "color-mix(in srgb, #ffb020 40%, transparent)", background: "color-mix(in srgb, #ffb020 8%, transparent)" } },
    h("div", { style: { display: "flex", gap: 10, alignItems: "center" } }, ic("settings2"),
      h("span", { style: { fontSize: 13 } }, "Add your Spotify Client ID + Secret in Settings ▸ Extensions ▸ SpotiMirror to connect.")));

  return h(React.Fragment, null,
    h("style", null, STYLE),
    h("div", { className: "smr-main" },
      banner,
      st.error && h("div", { className: "smr-card", style: { borderColor: "rgba(255,107,107,.4)", color: "#ff9b9b", fontSize: 13 } }, st.error),
      panel,
    ),
  );
}

// ---- activate ----

export function activate(gw) {
  GW = gw;
  bus.s.summary = cfg("lastSummary", null);
  bus.s.detect = cfg("detect", {});

  gw.events
    .on("music-imports://state", (jobs) => {
      bus.set({ jobs: Array.isArray(jobs) ? jobs : [] });
      if (Array.isArray(jobs) && jobs.some((j) => j && j.state === "done")) scheduleRelink();
    })
    .then((u) => { unsub = u; })
    .catch(() => {});

  // Prefetch so the view is ready the moment it's opened.
  refreshJobs();
  loadConcurrency();
  refreshConn().then(async () => {
    if (bus.s.conn && bus.s.conn.connected) { await loadPlaylists(); await detectSync(false); }
  }).catch(() => {});

  gw.registerNav({ id: "spotimirror", label: "SpotiMirror", icon: "rotateCw" });
  gw.registerView({ id: "spotimirror", render: mainRender, sidebar: sideRender });

  gw.registerSettingsSection({
    id: "spotimirror.config",
    label: "SpotiMirror",
    icon: "rotateCw",
    render: ({ React, ui }) => {
      const h = React.createElement;
      const [clientId, setClientId] = React.useState("");
      const [secret, setSecret] = React.useState("");
      const [redirect, setRedirect] = React.useState("");
      const [saved, setSaved] = React.useState(false);

      React.useEffect(() => {
        (async () => {
          try {
            setClientId((await gw.native("get_setting", { key: "spotify_client_id" })) || "");
            setSecret((await gw.native("get_setting", { key: "spotify_client_secret" })) || "");
            const s = await gw.native("spotify_status");
            setRedirect((s && s.redirectUri) || "");
          } catch { /* desktop-only */ }
        })();
      }, []);

      const save = async () => {
        try {
          await gw.native("set_setting", { key: "spotify_client_id", value: (clientId || "").trim() });
          await gw.native("set_setting", { key: "spotify_client_secret", value: (secret || "").trim() });
          setSaved(true); setTimeout(() => setSaved(false), 2000);
          refreshConn();
        } catch (e) { gw.log("save creds failed", e); }
      };
      const resetMirrors = () => { gw.storage.set("mirrorMap", {}); gw.storage.set("queuedUrls", {}); };

      return h("div", { className: "settings-group", style: { display: "grid", gap: 14, maxWidth: 560 } },
        h("p", { className: "field-hint", style: { margin: 0 } },
          "SpotiMirror needs a free Spotify app to read your library. Create one at developer.spotify.com, add the redirect URI below, then paste the Client ID + Secret here."),
        redirect && h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Redirect URI (add this to your Spotify app)"),
          h("code", { style: { fontSize: 12, opacity: 0.85, wordBreak: "break-all" } }, redirect)),
        h("div", null, h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Client ID"),
          h(ui.Input, { shape: "pill", value: clientId, onChange: (e) => setClientId(e.currentTarget.value), onClear: () => setClientId("") })),
        h("div", null, h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Client Secret"),
          h(ui.Input, { shape: "pill", type: "password", value: secret, onChange: (e) => setSecret(e.currentTarget.value), onClear: () => setSecret("") })),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
          h(ui.Button, { variant: "secondary", shape: "pill", icon: ui.icons.check, onClick: save }, "Save credentials"),
          saved && h("span", { style: { fontSize: 12, color: "var(--gg-seafoam, #5fe1e9)" } }, "Saved.")),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 12 } },
          h(ui.Button, { variant: "ghost", shape: "pill", icon: ui.icons.x, onClick: resetMirrors }, "Reset mirror links"),
          h("span", { className: "field-hint" }, "Forgets which local playlist mirrors which Spotify one.")),
      );
    },
  });

  gw.log("SpotiMirror activated");
}

export function deactivate() {
  try { if (unsub) unsub(); } catch { /* ignore */ }
  if (relinkTimer) clearTimeout(relinkTimer);
  bus.subs.clear();
  unsub = null;
  relinkTimer = null;
}
