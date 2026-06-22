// Prowlarr / Jackett Bridge — a GhostWire reference extension.
//
// Proves the backend host-fetch path + the search-source slot + a settings section. It runs entirely
// in the webview, reaching the user's self-hosted indexer through gw.fetch (a permissioned host-fetch
// the Rust host gates against this extension's declared network allowlist). Two modes:
//   • Prowlarr  → its JSON search API ({base}/api/v1/search)
//   • Jackett   → a Torznab endpoint (XML), e.g. {jackett}/api/v2.0/indexers/all/results/torznab/api
//
// It imports nothing — the app hands React, a UI kit, and `gw` to every render function.

export function activate(gw) {
  // ---- config (namespaced, synchronous reads via the host) ----
  const cfg = () => ({
    url: (gw.storage.get("url", "") || "").trim().replace(/\/+$/, ""),
    key: (gw.storage.get("key", "") || "").trim(),
    torznab: !!gw.storage.get("torznab", false),
  });

  // newznab/Torznab category ranges → GhostWire's coarse category.
  function mapCategory(catId) {
    const n = parseInt(catId, 10);
    if (!Number.isFinite(n)) return "other";
    if (n >= 2000 && n < 3000) return "video"; // Movies
    if (n >= 5000 && n < 6000) return "video"; // TV
    if (n >= 6000 && n < 7000) return "video"; // XXX
    if (n >= 3000 && n < 4000) return "audio"; // Audio
    if (n >= 7000 && n < 8000) return "books"; // Books
    if (n >= 4000 && n < 5000) return "software"; // PC/Apps
    return "other";
  }

  const isMagnet = (s) => typeof s === "string" && s.toLowerCase().startsWith("magnet:");

  // ---- Prowlarr JSON search ----
  async function prowlarrSearch(q) {
    const { url, key } = cfg();
    if (!url) return [];
    const endpoint = `${url}/api/v1/search?query=${encodeURIComponent(q)}&type=search&limit=100`;
    const res = await gw.fetch(endpoint, { headers: { "X-Api-Key": key, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Prowlarr ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const r of rows) {
      const magnet = [r.magnetUrl, r.guid, r.downloadUrl, r.link].find(isMagnet);
      if (!magnet) continue; // POC: only releases that expose a magnet (no .torrent fetch yet)
      const catId = Array.isArray(r.categories) && r.categories.length ? r.categories[0].id : undefined;
      out.push({
        title: r.title || "Untitled",
        magnet,
        sizeBytes: Number(r.size) || 0,
        seeders: Number(r.seeders) || 0,
        leechers: Number(r.leechers ?? (r.peers != null ? r.peers - (r.seeders || 0) : 0)) || 0,
        category: mapCategory(catId),
      });
    }
    return out;
  }

  // ---- Jackett / Torznab XML search ----
  async function torznabSearch(q) {
    const { url, key } = cfg();
    if (!url) return [];
    const sep = url.includes("?") ? "&" : "?";
    const endpoint = `${url}${sep}t=search&q=${encodeURIComponent(q)}${key ? `&apikey=${encodeURIComponent(key)}` : ""}`;
    const res = await gw.fetch(endpoint, { headers: { Accept: "application/xml,text/xml" } });
    if (!res.ok) throw new Error(`Torznab ${res.status}`);
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("Torznab returned invalid XML");
    const attr = (item, name) => {
      const el = [...item.getElementsByTagName("torznab:attr")].find((a) => a.getAttribute("name") === name);
      return el ? el.getAttribute("value") : null;
    };
    const out = [];
    for (const item of doc.querySelectorAll("item")) {
      const cand = [
        attr(item, "magneturl"),
        item.querySelector("link")?.textContent,
        item.querySelector("enclosure")?.getAttribute("url"),
        item.querySelector("guid")?.textContent,
      ].find(isMagnet);
      if (!cand) continue;
      const seeders = Number(attr(item, "seeders")) || 0;
      const peers = Number(attr(item, "peers"));
      out.push({
        title: item.querySelector("title")?.textContent || "Untitled",
        magnet: cand,
        sizeBytes: Number(item.querySelector("size")?.textContent || attr(item, "size")) || 0,
        seeders,
        leechers: Number.isFinite(peers) ? Math.max(0, peers - seeders) : 0,
        category: mapCategory(attr(item, "category")),
      });
    }
    return out;
  }

  // ---- search-source slot ----
  gw.registerSearchSource({
    id: "prowlarr",
    label: "Prowlarr",
    search: async (q) => {
      const { url, torznab } = cfg();
      if (!url || !q.trim()) return [];
      try {
        return torznab ? await torznabSearch(q) : await prowlarrSearch(q);
      } catch (e) {
        gw.log("search failed:", e);
        return [];
      }
    },
  });

  // ---- settings section (config UI) ----
  gw.registerSettingsSection({
    id: "prowlarr.config",
    label: "Prowlarr / Jackett",
    icon: "link2",
    render: ({ React, ui }) => {
      const h = React.createElement;
      const [url, setUrl] = React.useState(() => gw.storage.get("url", ""));
      const [key, setKey] = React.useState(() => gw.storage.get("key", ""));
      const [torznab, setTorznab] = React.useState(() => !!gw.storage.get("torznab", false));
      const [status, setStatus] = React.useState(null); // {ok, msg}
      const [testing, setTesting] = React.useState(false);

      const persist = (patch) => {
        if ("url" in patch) { setUrl(patch.url); gw.storage.set("url", patch.url); }
        if ("key" in patch) { setKey(patch.key); gw.storage.set("key", patch.key); }
        if ("torznab" in patch) { setTorznab(patch.torznab); gw.storage.set("torznab", patch.torznab); }
        setStatus(null);
      };

      const test = async () => {
        const base = (url || "").trim().replace(/\/+$/, "");
        if (!base) { setStatus({ ok: false, msg: "Enter your server URL first." }); return; }
        setTesting(true);
        setStatus(null);
        try {
          let res;
          if (torznab) {
            const sep = base.includes("?") ? "&" : "?";
            res = await gw.fetch(`${base}${sep}t=caps${key ? `&apikey=${encodeURIComponent(key)}` : ""}`);
          } else {
            res = await gw.fetch(`${base}/api/v1/system/status`, { headers: { "X-Api-Key": (key || "").trim() } });
          }
          setStatus(res.ok ? { ok: true, msg: "Connected — indexers are reachable." } : { ok: false, msg: `Server returned ${res.status}.` });
        } catch (e) {
          setStatus({ ok: false, msg: String(e && e.message ? e.message : e) });
        } finally {
          setTesting(false);
        }
      };

      return h("div", { className: "settings-group", style: { display: "grid", gap: 12, maxWidth: 520 } },
        h("label", { className: "settings-row", style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 } },
          h("div", null,
            h("div", { style: { fontWeight: 600, fontSize: 13 } }, "Jackett (Torznab) endpoint"),
            h("div", { className: "field-hint" }, "Off = Prowlarr. On = a Jackett/Torznab results URL."),
          ),
          h(ui.Toggle, { checked: torznab, onChange: (e) => persist({ torznab: e.currentTarget.checked }) }),
        ),
        h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, torznab ? "Torznab results URL" : "Prowlarr base URL"),
          h(ui.Input, {
            shape: "pill", value: url, iconLeft: ui.icons.link2,
            placeholder: torznab ? "http://localhost:9117/api/v2.0/indexers/all/results/torznab/api" : "http://localhost:9696",
            onChange: (e) => persist({ url: e.currentTarget.value }),
            onClear: () => persist({ url: "" }),
          }),
        ),
        h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, "API key"),
          h(ui.Input, {
            shape: "pill", value: key, type: "password",
            placeholder: "Your indexer API key",
            onChange: (e) => persist({ key: e.currentTarget.value }),
            onClear: () => persist({ key: "" }),
          }),
        ),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
          h(ui.Button, { variant: "secondary", shape: "pill", icon: ui.icons.search, onClick: test, disabled: testing },
            testing ? "Testing…" : "Test connection"),
          status && h("span", { style: { fontSize: 12, color: status.ok ? "var(--gg-seafoam)" : "var(--gg-danger, #ff6b6b)" } }, status.msg),
        ),
        h("p", { className: "field-hint", style: { margin: 0 } },
          "Searches run automatically — your Prowlarr/Jackett results merge into GhostWire’s search under the “Prowlarr” source."),
      );
    },
  });

  gw.log("Prowlarr / Jackett Bridge activated");
}
