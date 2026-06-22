// SpotiFLAC — a GhostWire built-in extension.
//
// Turns pasted music-service links (Spotify / Tidal / Apple Music / Deezer / Qobuz / YouTube Music)
// into lossless downloads queued into the library. The heavy lifting lives in the app's native
// engine: the `spotiflac` CLI is resolved/installed and driven by the Rust host, which streams live
// progress into the Downloads queue. This extension OWNS the capability — it declares the importer
// the app routes links to, and contributes the engine's configuration panel. Disable it and music
// importing turns off everywhere (the Music ▸ Import tab, the Discover search bar, ⌘K).
//
// Built-ins may reach the app's in-process commands via gw.native(...) (first-party privilege); it
// imports nothing — the app hands React, a UI kit, and `gw` to every render function.

const MUSIC_LINK_RE = [
  /^spotify:/i,
  /\bopen\.spotify\.com\//i,
  /\bmusic\.apple\.com\//i,
  /\b(?:listen\.)?tidal\.com\//i,
  /\bdeezer\.com\//i,
  /\bmusic\.youtube\.com\//i,
  /\b(?:open|play)\.qobuz\.com\//i,
];

/** True when a pasted string is a music-service link this importer should handle (not a torrent). */
function handlesLink(url) {
  const v = (url || "").trim().toLowerCase();
  if (!v || v.startsWith("magnet:")) return false;
  return MUSIC_LINK_RE.some((re) => re.test(v));
}

// Providers offered in the settings UI (priority order, left → right). The native side also accepts
// joox/netease/migu/kuwo/flacdownloader if typed, but these are the ones worth surfacing.
const SPOTIFLAC_PROVIDERS = ["tidal", "qobuz", "deezer", "amazon", "soundcloud", "youtube", "apple", "pandora"];
const SPOTIFLAC_QUALITIES = ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"];
const SPOTIFLAC_DEFAULT_SERVICES = "tidal qobuz youtube";

export function activate(gw) {
  // ---- the import capability the app routes pasted music links to ----
  // enqueue() drives the native, persistent import queue (the same background worker the Downloads
  // page renders as cards with live per-track progress).
  gw.registerMusicImporter({
    id: "spotiflac",
    label: "SpotiFLAC",
    handles: handlesLink,
    enqueue: async (url) => {
      await gw.native("music_import_enqueue", { url });
    },
  });

  // ---- configuration panel (Settings ▸ Extensions ▸ SpotiFLAC) ----
  // Engine status + one-click install, the output folder, and the optional custom TIDAL HiFi API.
  gw.registerSettingsSection({
    id: "spotiflac.config",
    label: "SpotiFLAC",
    icon: "download",
    render: ({ React, ui }) => {
      const h = React.createElement;
      const [status, setStatus] = React.useState(null); // { available, command, outputDir, hint } | null
      const [loading, setLoading] = React.useState(true);
      const [installing, setInstalling] = React.useState(false);
      const [installMsg, setInstallMsg] = React.useState(null); // { ok, msg } | null
      const [tidalApi, setTidalApi] = React.useState("");
      const [savedApi, setSavedApi] = React.useState("");
      const [qobuzApi, setQobuzApi] = React.useState("");
      const [services, setServices] = React.useState(SPOTIFLAC_DEFAULT_SERVICES); // space-separated priority list
      const [quality, setQuality] = React.useState("LOSSLESS");
      const [retries, setRetries] = React.useState(2);
      const [trackTimeout, setTrackTimeout] = React.useState(""); // seconds string; "" = engine default
      const [lyrics, setLyrics] = React.useState(true);
      const [enrich, setEnrich] = React.useState(true);

      const refreshStatus = React.useCallback(async () => {
        try {
          const s = await gw.native("music_spotiflac_status");
          setStatus(s);
        } catch (e) {
          setStatus(null);
          gw.log("status failed:", e);
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          await refreshStatus();
          try {
            const [api, svc, q, rt, to, ly, en, qz] = await Promise.all([
              gw.native("get_setting", { key: "spotiflac_tidal_api" }),
              gw.native("get_setting", { key: "spotiflac_service" }),
              gw.native("get_setting", { key: "spotiflac_quality" }),
              gw.native("get_setting", { key: "spotiflac_retries" }),
              gw.native("get_setting", { key: "spotiflac_timeout" }),
              gw.native("get_setting", { key: "spotiflac_lyrics" }),
              gw.native("get_setting", { key: "spotiflac_enrich" }),
              gw.native("get_setting", { key: "spotiflac_qobuz_api" }),
            ]);
            if (!alive) return;
            setTidalApi(api || ""); setSavedApi(api || "");
            setQobuzApi(qz || "");
            setServices((svc && svc.trim()) || SPOTIFLAC_DEFAULT_SERVICES);
            setQuality((q && q.trim()) || "LOSSLESS");
            setRetries(Math.max(0, Math.min(10, parseInt(rt, 10) || 2)));
            setTrackTimeout(to == null ? "" : String(to));
            setLyrics(ly !== "0");
            setEnrich(en !== "0");
          } catch { /* desktop-only — leave defaults in the browser preview */ }
        })();
        return () => { alive = false; };
      }, [refreshStatus]);

      const install = async () => {
        setInstalling(true);
        setInstallMsg(null);
        try {
          await gw.native("music_spotiflac_install");
          setInstallMsg({ ok: true, msg: "SpotiFLAC installed." });
          await refreshStatus();
        } catch (e) {
          setInstallMsg({ ok: false, msg: String(e && e.message ? e.message : e) });
        } finally {
          setInstalling(false);
        }
      };

      const saveApi = async () => {
        const v = (tidalApi || "").trim();
        try {
          await gw.native("set_setting", { key: "spotiflac_tidal_api", value: v });
          setSavedApi(v);
        } catch (e) {
          gw.log("save tidal api failed:", e);
        }
      };

      // The download settings below save immediately (no Save button) so changes apply to the
      // already-queued tracks on their next attempt.
      const persist = (key, value) =>
        gw.native("set_setting", { key, value: String(value) }).catch((e) => gw.log("save " + key + " failed:", e));
      const toggleProvider = (p) => {
        const list = (services || "").split(/[\s,]+/).filter(Boolean);
        const next = list.includes(p) ? list.filter((x) => x !== p) : [...list, p];
        const value = SPOTIFLAC_PROVIDERS.filter((x) => next.includes(x)).join(" ");
        setServices(value);
        persist("spotiflac_service", value);
      };
      const pickQuality = (q) => { setQuality(q); persist("spotiflac_quality", q); };
      const bumpRetries = (n) => { const v = Math.max(0, Math.min(10, n)); setRetries(v); persist("spotiflac_retries", v); };
      const saveTimeout = () => persist("spotiflac_timeout", (trackTimeout || "").trim());
      const toggleLyrics = (on) => { setLyrics(on); persist("spotiflac_lyrics", on ? "1" : "0"); };
      const toggleEnrich = (on) => { setEnrich(on); persist("spotiflac_enrich", on ? "1" : "0"); };
      const selectedProviders = new Set((services || "").split(/[\s,]+/).filter(Boolean));

      const available = !!(status && status.available);
      const dirty = (tidalApi || "").trim() !== (savedApi || "").trim();
      const statusColor = available ? "var(--gg-seafoam)" : "var(--gg-text-dim, #9aa0a6)";

      return h("div", { className: "settings-group", style: { display: "grid", gap: 14, maxWidth: 560 } },
        // engine status
        h("div", { className: "settings-row", style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
          h("div", null,
            h("div", { style: { fontWeight: 600, fontSize: 13 } }, "Download engine"),
            h("div", { className: "field-hint" },
              loading ? "Checking…" : available ? "Ready — lossless downloads are available." : "Not installed yet."),
          ),
          h("span", { style: { fontSize: 12, fontWeight: 600, color: statusColor } },
            loading ? "…" : available ? "Ready" : "Not installed"),
        ),
        // install (when missing)
        !loading && !available && h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
          h(ui.Button, { variant: "primary", shape: "pill", icon: ui.icons.download, onClick: install, disabled: installing },
            installing ? "Installing…" : "Install SpotiFLAC"),
          installMsg && h("span", { style: { fontSize: 12, color: installMsg.ok ? "var(--gg-seafoam)" : "var(--gg-danger, #ff6b6b)" } }, installMsg.msg),
        ),
        !loading && available && installMsg &&
          h("span", { style: { fontSize: 12, color: installMsg.ok ? "var(--gg-seafoam)" : "var(--gg-danger, #ff6b6b)" } }, installMsg.msg),
        // output dir
        status && status.outputDir && h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Saved to"),
          h("code", { style: { fontSize: 12, opacity: 0.85, wordBreak: "break-all" } }, status.outputDir),
        ),
        // download sources (priority order)
        h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 6 } }, "Download sources — tried in order, falls through on failure"),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 7 } },
            SPOTIFLAC_PROVIDERS.map((p) => h(ui.Button, {
              key: p, variant: selectedProviders.has(p) ? "primary" : "ghost", shape: "pill", size: "sm",
              onClick: () => toggleProvider(p),
            }, p.charAt(0).toUpperCase() + p.slice(1))),
          ),
          h("p", { className: "field-hint", style: { margin: "6px 0 0" } },
            "Enable several so a song one source can’t match still downloads from another. YouTube is the widest but lowest quality. Note: Deezer goes through a public resolver that can fall back to 30-second previews — Tidal & Qobuz are the most reliable for full lossless."),
        ),
        // quality
        h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 6 } }, "Quality"),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 7 } },
            SPOTIFLAC_QUALITIES.map((q) => h(ui.Button, {
              key: q, variant: quality === q ? "primary" : "ghost", shape: "pill", size: "sm",
              onClick: () => pickQuality(q),
            }, q.replace(/_/g, " "))),
          ),
        ),
        // retries + per-track timeout
        h("div", { style: { display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" } },
          h("div", null,
            h("div", { className: "field-hint", style: { marginBottom: 6 } }, "Retries per track"),
            h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
              h(ui.Button, { variant: "ghost", shape: "pill", size: "sm", disabled: retries <= 0, onClick: () => bumpRetries(retries - 1) }, "−"),
              h("span", { style: { minWidth: 18, textAlign: "center", fontWeight: 800 } }, retries),
              h(ui.Button, { variant: "ghost", shape: "pill", size: "sm", disabled: retries >= 10, onClick: () => bumpRetries(retries + 1) }, "+"),
            ),
          ),
          h("div", { style: { flex: 1, minWidth: 190 } },
            h("div", { className: "field-hint", style: { marginBottom: 6 } }, "Per-track timeout (seconds)"),
            h(ui.Input, {
              shape: "pill", value: trackTimeout, placeholder: "120", inputMode: "numeric",
              onChange: (e) => setTrackTimeout(e.currentTarget.value.replace(/[^0-9]/g, "")),
              onBlur: saveTimeout,
              onClear: () => { setTrackTimeout(""); persist("spotiflac_timeout", ""); },
            }),
            h("p", { className: "field-hint", style: { margin: "6px 0 0" } }, "Skips a track that can’t be fetched in time so it can’t stall the queue. Blank = 120s; 0 = no limit."),
          ),
        ),
        // lyrics + enrichment
        h("div", { style: { display: "grid", gap: 12 } },
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
            h("div", null, h("div", { style: { fontWeight: 600, fontSize: 13 } }, "Embed lyrics"),
              h("div", { className: "field-hint" }, "Save synced lyrics into each file when available.")),
            h(ui.Toggle, { checked: lyrics, onChange: (e) => toggleLyrics(!!e.currentTarget.checked) }),
          ),
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
            h("div", null, h("div", { style: { fontWeight: 600, fontSize: 13 } }, "Metadata enrichment"),
              h("div", { className: "field-hint" }, "Fill missing tags & art from Deezer, Apple, Qobuz, Tidal, SoundCloud.")),
            h(ui.Toggle, { checked: enrich, onChange: (e) => toggleEnrich(!!e.currentTarget.checked) }),
          ),
        ),
        // optional custom TIDAL HiFi API endpoint
        h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Custom TIDAL HiFi API (optional)"),
          h(ui.Input, {
            shape: "pill", value: tidalApi, iconLeft: ui.icons.globe,
            placeholder: "https://your-tidal-api.example.com",
            onChange: (e) => setTidalApi(e.currentTarget.value),
            onClear: () => setTidalApi(""),
          }),
          h("p", { className: "field-hint", style: { margin: "6px 0 0" } },
            "Leave blank to use SpotiFLAC’s public TIDAL pool (no login). Set a self-hosted endpoint for higher reliability."),
        ),
        dirty && h(ui.Button, { variant: "secondary", shape: "pill", icon: ui.icons.check, onClick: saveApi }, "Save endpoint"),
        // optional self-hosted Qobuz API (full lossless from Qobuz)
        h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Qobuz local API (optional)"),
          h(ui.Input, {
            shape: "pill", value: qobuzApi, iconLeft: ui.icons.globe,
            placeholder: "http://127.0.0.1:9000",
            onChange: (e) => setQobuzApi(e.currentTarget.value),
            onBlur: () => persist("spotiflac_qobuz_api", (qobuzApi || "").trim()),
            onClear: () => { setQobuzApi(""); persist("spotiflac_qobuz_api", ""); },
          }),
          h("p", { className: "field-hint", style: { margin: "6px 0 0" } },
            "Point at a self-hosted Qobuz API for full-lossless Qobuz downloads (saves on blur). Leave blank to use the public pool."),
        ),
        h("p", { className: "field-hint", style: { margin: 0 } },
          "Paste a Spotify, Tidal, Apple Music, Deezer, Qobuz or YouTube Music link in search or the Music ▸ Import tab — it queues here and downloads in the background."),
      );
    },
  });

  gw.log("SpotiFLAC activated");
}
