// Séance — a GhostWire built-in extension. Summons videos from the void (YouTube / Vimeo / Twitch /
// TikTok / Reddit / …) into your library via a native yt-dlp backend.
//
// First-party builtin → reaches native commands directly via gw.native(...):
//   seance_status / seance_install / seance_download — and listens to the live seance://output stream.
// The heavy lifting (resolve/install yt-dlp, spawn it, stream progress, fold the file into the library)
// lives in Rust; this is the séance circle: a paste box, a quality pick, and a live summoning queue.

let GW = null;
let unsub = null;
let processing = false;

const cfg = (key, def) => GW.storage.get(key, def);
const setCfg = (key, val) => GW.storage.set(key, val);
const errStr = (e) => String(e && e.message ? e.message : e);

const bus = {
  s: { status: null, installing: false, installMsg: null, draft: "", jobs: [] },
  subs: new Set(),
  set(patch) {
    if (patch) Object.assign(this.s, patch);
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

// ---- actions ----
async function refreshStatus() {
  try { bus.set({ status: await GW.native("seance_status") }); }
  catch { bus.set({ status: { available: false } }); }
}
async function install() {
  bus.set({ installing: true, installMsg: null });
  try {
    await GW.native("seance_install");
    bus.set({ installMsg: { ok: true, msg: "yt-dlp installed." } });
    await refreshStatus();
  } catch (e) {
    bus.set({ installMsg: { ok: false, msg: errStr(e) } });
  } finally {
    bus.set({ installing: false });
  }
}
const setQuality = (q) => { setCfg("quality", q); bus.set({}); };

function enqueue(url) {
  url = (url || "").trim();
  if (!url) return;
  const job = {
    id: `sea-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    url, title: url, quality: cfg("quality", "best"),
    state: "queued", pct: 0, stage: "", line: "", error: null,
  };
  bus.s.jobs = [job, ...bus.s.jobs]; // newest on top
  bus.set({});
  processQueue();
}
async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    // FIFO: oldest queued first (jobs[0] is newest).
    let job;
    while ((job = [...bus.s.jobs].reverse().find((j) => j.state === "queued"))) {
      job.state = "summoning"; job.stage = "Starting"; bus.set({});
      try { await GW.native("seance_download", { url: job.url, quality: job.quality }); job.state = "done"; job.pct = 100; }
      catch (e) { job.state = "error"; job.error = errStr(e); }
      bus.set({});
    }
  } finally { processing = false; }
}
function clearFinished() {
  bus.s.jobs = bus.s.jobs.filter((j) => j.state === "summoning" || j.state === "queued");
  bus.set({});
}

const STYLE = `
.sea-side { display:flex; flex-direction:column; gap:13px; padding:6px 2px; }
.sea-brand { display:flex; align-items:center; gap:11px; }
.sea-badge { width:44px; height:44px; border-radius:13px; display:grid; place-items:center; color:#04121a; flex:0 0 auto;
  background:linear-gradient(135deg, var(--gg-seafoam,#5fe1e9), var(--gg-teal,#2dcdd6)); box-shadow:0 8px 22px rgba(95,225,233,.30); }
.sea-title { font-size:16px; font-weight:800; letter-spacing:.2px; }
.sea-sub { font-size:10.5px; opacity:.55; margin-top:1px; }
.sea-conn { display:flex; align-items:center; gap:8px; padding:10px 12px; border-radius:12px; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.07); font-size:12px; }
.sea-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
.sea-label { font-size:10px; text-transform:uppercase; letter-spacing:.6px; opacity:.55; margin:6px 2px 1px; font-weight:700; }
.sea-qs { display:flex; flex-wrap:wrap; gap:6px; }
.sea-q { font-size:12px; font-weight:700; padding:7px 12px; border-radius:999px; cursor:pointer; border:1px solid rgba(255,255,255,.12); background:transparent; color:inherit; transition:background .15s, border-color .15s, color .15s; }
.sea-q:hover { background:rgba(255,255,255,.06); }
.sea-q.on { background:color-mix(in srgb, var(--gg-seafoam,#5fe1e9) 18%, transparent); border-color:var(--gg-seafoam,#5fe1e9); color:var(--gg-seafoam,#5fe1e9); }
.sea-main { display:flex; flex-direction:column; gap:18px; min-width:0; }
.sea-hero { position:relative; overflow:hidden; border-radius:20px; padding:24px 26px; border:1px solid rgba(255,255,255,.08);
  background:radial-gradient(130% 150% at 100% 0%, color-mix(in srgb, var(--gg-seafoam,#5fe1e9) 26%, transparent), transparent 58%), linear-gradient(135deg, rgba(95,225,233,.08), rgba(45,205,214,.02)); }
.sea-hero h2 { margin:0 0 14px; font-size:20px; font-weight:800; }
.sea-paste { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.sea-paste > :first-child { flex:1; min-width:240px; }
.sea-sec { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.sea-sec-title { font-size:15px; font-weight:700; display:flex; align-items:center; gap:8px; }
.sea-queue { display:flex; flex-direction:column; gap:12px; }
.sea-job { display:flex; gap:14px; align-items:center; padding:13px; border-radius:15px; background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.06); }
.sea-thumb { width:62px; height:46px; border-radius:9px; flex:0 0 auto; display:grid; place-items:center;
  background:linear-gradient(135deg, rgba(95,225,233,.20), rgba(45,205,214,.05)); color:color-mix(in srgb, var(--gg-seafoam,#5fe1e9) 70%, #fff); }
.sea-job-title { font-size:13px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sea-job-sub { font-size:11px; opacity:.6; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sea-job-state { font-size:12px; font-weight:800; flex:0 0 auto; }
.sea-bar { height:8px; border-radius:999px; background:rgba(255,255,255,.08); overflow:hidden; }
.sea-bar > i { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg, var(--gg-seafoam,#5fe1e9), var(--gg-teal,#2dcdd6)); transition:width .3s; }
.sea-empty { padding:48px 24px; text-align:center; opacity:.62; font-size:13px; border-radius:16px; border:1px dashed rgba(255,255,255,.13); }
`;

// ---- renders ----
function sideRender({ React, ui }) {
  const h = React.createElement;
  const ic = (n, s) => h(ui.Icon, { icon: ui.icons[n], size: s || "sm" });
  const st = useBus(React);
  const available = !!(st.status && st.status.available);
  const q = cfg("quality", "best");
  const QS = [["best", "Best"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"], ["audio", "Audio"]];

  return h(React.Fragment, null,
    h("style", null, STYLE),
    h("div", { className: "sea-side" },
      h("div", { className: "sea-brand" },
        h("div", { className: "sea-badge" }, ic("sparkles", "base")),
        h("div", null, h("div", { className: "sea-title" }, "Séance"), h("div", { className: "sea-sub" }, "Summon videos from the void")),
      ),
      h("div", { className: "sea-conn" },
        h("span", { className: "sea-dot", style: { background: available ? "var(--gg-seafoam, #5fe1e9)" : "#ff6b6b", boxShadow: available ? "0 0 10px var(--gg-seafoam, #5fe1e9)" : "none" } }),
        h("span", null, st.status === null ? "Checking…" : available ? "yt-dlp ready" : "yt-dlp not installed"),
      ),
      !available && st.status !== null
        ? h(ui.Button, { variant: "primary", shape: "pill", icon: ui.icons.download, onClick: install, disabled: st.installing }, st.installing ? "Installing…" : "Install yt-dlp")
        : null,
      st.installMsg ? h("span", { style: { fontSize: 11, color: st.installMsg.ok ? "var(--gg-seafoam, #5fe1e9)" : "#ff9b9b" } }, st.installMsg.msg) : null,
      h("div", { className: "sea-label" }, "Quality"),
      h("div", { className: "sea-qs" }, QS.map(([val, label]) => h("button", { key: val, className: `sea-q${q === val ? " on" : ""}`, onClick: () => setQuality(val) }, label))),
      st.status && st.status.outputDir ? h("div", null,
        h("div", { className: "sea-label" }, "Saved to"),
        h("code", { style: { fontSize: 11, opacity: .8, wordBreak: "break-all" } }, st.status.outputDir),
      ) : null,
      h("p", { className: "field-hint", style: { margin: "6px 2px 0", fontSize: 11 } }, "Saved videos land in your library. Powered by yt-dlp."),
    ),
  );
}

function mainRender({ React, ui }) {
  const h = React.createElement;
  const ic = (n, s) => h(ui.Icon, { icon: ui.icons[n], size: s || "sm" });
  const st = useBus(React);
  const available = !!(st.status && st.status.available);
  const jobs = st.jobs || [];
  const draft = st.draft || "";
  const summon = () => { if (draft.trim()) { enqueue(draft); bus.set({ draft: "" }); } };

  const jobCard = (j) => {
    const pct = Math.round(j.pct || 0);
    const col = j.state === "error" ? "#ff6b6b" : "var(--gg-seafoam, #5fe1e9)";
    const label = j.state === "done" ? "Saved" : j.state === "error" ? "Failed" : j.state === "queued" ? "Queued" : `${pct}%`;
    return h("div", { className: "sea-job", key: j.id },
      h("div", { className: "sea-thumb" }, ic(j.state === "done" ? "check" : j.state === "error" ? "triangleAlert" : "tv", "base")),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { className: "sea-job-title" }, j.title || j.url),
        h("div", { className: "sea-job-sub" }, j.state === "error" ? (j.error || "Failed") : j.state === "summoning" ? (j.stage || "Summoning…") : j.url),
        (j.state === "summoning" || j.state === "queued") ? h("div", { className: "sea-bar", style: { marginTop: 8 } }, h("i", { style: { width: `${j.state === "queued" ? 0 : pct}%` } })) : null,
      ),
      h("div", { className: "sea-job-state", style: { color: col } }, label),
    );
  };

  return h(React.Fragment, null,
    h("style", null, STYLE),
    h("div", { className: "sea-main" },
      h("div", { className: "sea-hero" },
        h("h2", null, available ? "Summon a video" : "Séance needs yt-dlp"),
        available
          ? h("div", { className: "sea-paste" },
              h(ui.Input, {
                shape: "pill", size: "lg", iconLeft: ui.icons.link2, value: draft,
                placeholder: "Paste a YouTube, Vimeo, Twitch or TikTok link…",
                onChange: (e) => bus.set({ draft: e.currentTarget.value }),
                onClear: () => bus.set({ draft: "" }),
                onKeyDown: (e) => { if (e.key === "Enter") summon(); },
              }),
              h(ui.Button, { variant: "primary", shape: "pill", size: "lg", icon: ui.icons.sparkles, onClick: summon, disabled: !draft.trim() }, "Summon"),
            )
          : h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
              h(ui.Button, { variant: "primary", shape: "pill", icon: ui.icons.download, onClick: install, disabled: st.installing }, st.installing ? "Installing…" : "Install yt-dlp"),
              h("span", { className: "field-hint" }, "yt-dlp powers the summoning — install it once to begin."),
            ),
      ),
      h("div", { className: "sea-sec" },
        h("div", { className: "sea-sec-title" }, ic("download"), "Summonings", h("span", { style: { opacity: .55, fontWeight: 600 } }, jobs.length ? `· ${jobs.length}` : "")),
        jobs.some((j) => j.state === "done" || j.state === "error") && h(ui.Button, { variant: "ghost", shape: "pill", icon: ui.icons.x, onClick: clearFinished }, "Clear finished"),
      ),
      jobs.length === 0
        ? h("div", { className: "sea-empty" }, "No summonings yet. Paste a link above and Séance will conjure it into your library.")
        : h("div", { className: "sea-queue" }, jobs.map(jobCard)),
    ),
  );
}

// ---- activate ----
export function activate(gw) {
  GW = gw;
  bus.subs = new Set();

  gw.events
    .on("seance://output", (o) => {
      if (!o) return;
      const active = bus.s.jobs.find((j) => j.state === "summoning");
      if (!active) return;
      if (o.line) {
        const m = /\[download\]\s+([\d.]+)%/.exec(o.line);
        if (m) active.pct = Math.min(100, parseFloat(m[1]));
        const d = /Destination:\s*(.+)$/.exec(o.line);
        if (d) { const base = d[1].split("/").pop(); if (base) active.title = base; }
        if (/\[Merger\]/i.test(o.line)) active.stage = "Merging";
        else if (/Extract|ffmpeg|\[Metadata\]/i.test(o.line)) active.stage = "Processing";
        else if (/\[download\]/i.test(o.line)) active.stage = "Downloading";
        active.line = o.line;
        bus.set({});
      }
    })
    .then((u) => { unsub = u; })
    .catch(() => {});

  refreshStatus();

  gw.registerNav({ id: "seance", label: "Séance", icon: "tv" });
  gw.registerView({ id: "seance", render: mainRender, sidebar: sideRender });

  gw.registerSettingsSection({
    id: "seance.config",
    label: "Séance",
    icon: "tv",
    render: ({ React, ui }) => {
      const h = React.createElement;
      const [status, setStatus] = React.useState(null);
      React.useEffect(() => { gw.native("seance_status").then(setStatus).catch(() => {}); }, []);
      const avail = !!(status && status.available);
      return h("div", { className: "settings-group", style: { display: "grid", gap: 12, maxWidth: 560 } },
        h("p", { className: "field-hint", style: { margin: 0 } },
          "Séance summons videos with yt-dlp — install it once, then paste any YouTube / Vimeo / Twitch / TikTok link on the Séance page."),
        status && status.outputDir ? h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Saved to"),
          h("code", { style: { fontSize: 12, opacity: 0.85, wordBreak: "break-all" } }, status.outputDir)) : null,
        avail
          ? h("span", { style: { fontSize: 12, color: "var(--gg-seafoam, #5fe1e9)" } }, "yt-dlp ready.")
          : h(ui.Button, { variant: "primary", shape: "pill", icon: ui.icons.download, onClick: async () => { try { await gw.native("seance_install"); setStatus(await gw.native("seance_status")); } catch { /* ignore */ } } }, "Install yt-dlp"),
      );
    },
  });

  gw.log("Séance activated");
}

export function deactivate() {
  try { if (unsub) unsub(); } catch { /* ignore */ }
  bus.subs.clear();
  unsub = null;
}
