// Trakt.tv Sync — a GhostWire reference extension (the Phase 3 showcase).
//
// Exercises the PLAYBACK EVENT BUS (scrobbles what you watch) + the DISCOVER-ROW slot (an "Up Next"
// rail) + a settings section (device OAuth). All network goes through gw.fetch (permissioned
// host-fetch → api.trakt.tv). The user supplies their own Trakt API app (Client ID + Secret).
//
// It imports nothing — the app hands React, a UI kit, and `gw` to every render function.

const TRAKT = "https://api.trakt.tv";

export function activate(gw) {
  const cfg = () => ({
    clientId: (gw.storage.get("clientId", "") || "").trim(),
    clientSecret: (gw.storage.get("clientSecret", "") || "").trim(),
    token: gw.storage.get("token", null),
    refreshToken: gw.storage.get("refreshToken", null),
    user: gw.storage.get("user", null),
  });
  const connected = () => !!cfg().token;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const today = () => new Date().toISOString().slice(0, 10);

  function authHeaders(auth) {
    const c = cfg();
    const h = { "Content-Type": "application/json", "trakt-api-version": "2", "trakt-api-key": c.clientId };
    if (auth && c.token) h["Authorization"] = `Bearer ${c.token}`;
    return h;
  }
  const api = (path, { method = "GET", body, auth = true } = {}) =>
    gw.fetch(`${TRAKT}${path}`, { method, headers: authHeaders(auth), body: body ? JSON.stringify(body) : undefined });

  // ---- device OAuth ----
  async function deviceCode() {
    const res = await gw.fetch(`${TRAKT}/oauth/device/code`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: cfg().clientId }),
    });
    if (!res.ok) throw new Error(`device code ${res.status}`);
    return res.json(); // { device_code, user_code, verification_url, expires_in, interval }
  }
  async function pollToken(deviceCodeVal, interval, expiresIn) {
    const c = cfg();
    const deadline = Date.now() + (expiresIn || 600) * 1000;
    let wait = Math.max(5, interval || 5);
    while (Date.now() < deadline) {
      await sleep(wait * 1000);
      const res = await gw.fetch(`${TRAKT}/oauth/device/token`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: deviceCodeVal, client_id: c.clientId, client_secret: c.clientSecret }),
      });
      if (res.status === 200) return res.json();
      if (res.status === 400) continue;       // pending — keep polling
      if (res.status === 429) { wait += 1; continue; } // slow down
      throw new Error(`authorization failed (${res.status})`); // 404/409/410/418
    }
    throw new Error("the code expired — try again");
  }
  async function saveTokens(tok) {
    gw.storage.set("token", tok.access_token);
    gw.storage.set("refreshToken", tok.refresh_token);
    try {
      const r = await api("/users/me", { auth: true });
      if (r.ok) { const u = await r.json(); gw.storage.set("user", u.username || u.name || "Trakt"); }
    } catch { /* leave user unset */ }
  }
  async function refresh() {
    const c = cfg();
    if (!c.refreshToken) return false;
    try {
      const res = await gw.fetch(`${TRAKT}/oauth/token`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refresh_token: c.refreshToken, client_id: c.clientId, client_secret: c.clientSecret,
          grant_type: "refresh_token", redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
        }),
      });
      if (res.ok) { await saveTokens(await res.json()); return true; }
    } catch { /* fall through */ }
    return false;
  }
  function disconnect() {
    ["token", "refreshToken", "user"].forEach((k) => gw.storage.set(k, null));
  }

  // ---- scrobbler: react to playback events ----
  gw.onPlayback(async (ev) => {
    if (ev.kind !== "video" || !connected()) return;
    const action = ev.state === "ended" ? "stop" : ev.state === "paused" ? "pause" : "start";
    const progress = ev.progress != null ? ev.progress : (ev.duration ? (ev.position / ev.duration) * 100 : 0);
    const body = { progress: Math.max(0, Math.min(100, progress)), app_version: "1.0", app_date: today() };
    if (ev.show && ev.episode != null) {
      body.show = { title: ev.show, year: ev.year || undefined };
      body.episode = { season: ev.season || 1, number: ev.episode };
    } else {
      body.movie = { title: ev.title, year: ev.year || undefined };
    }
    try {
      let res = await api(`/scrobble/${action}`, { method: "POST", body });
      if (res.status === 401 && (await refresh())) res = await api(`/scrobble/${action}`, { method: "POST", body });
      gw.log(`scrobble/${action} → ${res.status}`);
    } catch (e) {
      gw.log("scrobble failed:", e);
    }
  });

  // ---- "Up Next" data ----
  async function fetchUpNext() {
    if (!connected()) return [];
    let res = await api("/sync/watched/shows", { auth: true });
    if (res.status === 401 && (await refresh())) res = await api("/sync/watched/shows", { auth: true });
    if (!res.ok) return [];
    const shows = await res.json();
    if (!Array.isArray(shows)) return [];
    shows.sort((a, b) => String(b.last_watched_at || "").localeCompare(String(a.last_watched_at || "")));
    const out = [];
    for (const s of shows.slice(0, 12)) {
      const id = s.show && s.show.ids && (s.show.ids.trakt || s.show.ids.slug);
      if (!id) continue;
      try {
        const pr = await api(`/shows/${id}/progress/watched`, { auth: true });
        if (!pr.ok) continue;
        const p = await pr.json();
        if (p && p.next_episode) {
          out.push({
            title: s.show.title, year: s.show.year,
            season: p.next_episode.season, number: p.next_episode.number, epTitle: p.next_episode.title,
          });
        }
      } catch { /* skip this show */ }
    }
    return out;
  }
  const hue = (str) => { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360; return h; };
  const sxe = (s, e) => `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;

  // ---- Discover "Up Next" row ----
  gw.registerDiscoverRow({
    id: "trakt-up-next",
    title: "Up Next on Trakt",
    render: ({ React, ui, gw }) => {
      const h = React.createElement;
      const [items, setItems] = React.useState(null);
      React.useEffect(() => {
        if (!connected()) { setItems([]); return; }
        let alive = true;
        fetchUpNext().then((r) => { if (alive) setItems(r); }).catch(() => { if (alive) setItems([]); });
        return () => { alive = false; };
      }, []);
      if (!connected()) return null;
      const head = h("div", { className: "prow-head" }, h("h2", { className: "prow-title" },
        h(ui.Icon, { icon: ui.icons.star, size: "sm" }), " Up Next on Trakt"));
      if (items == null) {
        return h("section", { className: "prow" }, head,
          h("div", { className: "prow-scroller" }, h("span", { className: "field-hint" }, "Loading from Trakt…")));
      }
      if (items.length === 0) return null;
      return h("section", { className: "prow" }, head,
        h("div", { className: "prow-scroller" },
          items.map((it, i) => {
            const label = sxe(it.season, it.number);
            const query = `${it.title} ${label}`;
            return h("button", {
              key: i, title: `Find ${query}`, onClick: () => gw.search(query),
              style: { display: "flex", flexDirection: "column", gap: 6, padding: 0, border: "none", background: "none", cursor: "pointer", textAlign: "left" },
            },
              h("div", { style: { aspectRatio: "2 / 3", borderRadius: 10, background: `linear-gradient(150deg, hsl(${hue(it.title)} 36% 26%), hsl(${(hue(it.title) + 40) % 360} 46% 14%))`, display: "grid", placeItems: "center", color: "rgba(255,255,255,.85)" } },
                h(ui.Icon, { icon: ui.icons.star, size: "xl" })),
              h("div", { style: { fontSize: 13, fontWeight: 600, lineHeight: 1.2, color: "var(--gg-text)" }, title: it.title }, it.title),
              h("div", { className: "field-hint", style: { fontSize: 11 } }, `${label}${it.epTitle ? ` · ${it.epTitle}` : ""}`),
            );
          }),
        ),
      );
    },
  });

  // ---- settings: connect / disconnect ----
  gw.registerSettingsSection({
    id: "trakt.config",
    label: "Trakt.tv",
    icon: "star",
    render: ({ React, ui }) => {
      const h = React.createElement;
      const c0 = cfg();
      const [clientId, setClientId] = React.useState(c0.clientId);
      const [clientSecret, setClientSecret] = React.useState(c0.clientSecret);
      const [user, setUser] = React.useState(c0.user);
      const [flow, setFlow] = React.useState(null);   // { code, url }
      const [status, setStatus] = React.useState("");
      const aliveRef = React.useRef(true);
      React.useEffect(() => () => { aliveRef.current = false; }, []);

      const saveId = (v) => { setClientId(v); gw.storage.set("clientId", v.trim()); };
      const saveSecret = (v) => { setClientSecret(v); gw.storage.set("clientSecret", v.trim()); };

      const connect = async () => {
        setStatus("");
        if (!clientId.trim() || !clientSecret.trim()) { setStatus("Enter your Trakt Client ID + Secret first."); return; }
        try {
          const dc = await deviceCode();
          if (!aliveRef.current) return;
          setFlow({ code: dc.user_code, url: dc.verification_url });
          const tok = await pollToken(dc.device_code, dc.interval, dc.expires_in);
          await saveTokens(tok);
          if (!aliveRef.current) return;
          setUser(cfg().user || "Trakt");
          setFlow(null);
          setStatus("Connected!");
          gw.toast("Trakt.tv connected");
        } catch (e) {
          if (aliveRef.current) { setFlow(null); setStatus(`Couldn't connect: ${e && e.message ? e.message : e}`); }
        }
      };
      const disconnectUi = () => { disconnect(); setUser(null); setFlow(null); setStatus("Disconnected."); };

      return h("div", { className: "settings-group", style: { display: "grid", gap: 12, maxWidth: 480 } },
        user
          ? h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
              h(ui.Icon, { icon: ui.icons.check, size: "sm" }),
              h("span", null, "Connected as ", h("b", null, user)),
              h(ui.Button, { variant: "secondary", shape: "pill", size: "sm", onClick: disconnectUi }, "Disconnect"))
          : h(React.Fragment, null,
              h("p", { className: "field-hint", style: { margin: 0 } },
                "Create a Trakt API app at trakt.tv/oauth/applications (redirect URI: urn:ietf:wg:oauth:2.0:oob), then paste its keys:"),
              h("div", null,
                h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Client ID"),
                h(ui.Input, { shape: "pill", value: clientId, placeholder: "Trakt Client ID",
                  onChange: (e) => saveId(e.currentTarget.value), onClear: () => saveId("") })),
              h("div", null,
                h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Client Secret"),
                h(ui.Input, { shape: "pill", type: "password", value: clientSecret, placeholder: "Trakt Client Secret",
                  onChange: (e) => saveSecret(e.currentTarget.value), onClear: () => saveSecret("") })),
              flow
                ? h("div", { style: { display: "grid", gap: 4 } },
                    h("span", { className: "field-hint" }, "Go to ", h("b", null, flow.url), " and enter:"),
                    h("div", { style: { fontSize: 26, fontWeight: 700, letterSpacing: 3, color: "var(--gg-seafoam)" } }, flow.code),
                    h("span", { className: "field-hint" }, "Waiting for you to authorize…"))
                : h(ui.Button, { variant: "primary", shape: "pill", icon: ui.icons.link2, onClick: connect }, "Connect Trakt")),
        status && h("span", { className: "field-hint" }, status),
        connected() && h("p", { className: "field-hint", style: { margin: 0 } },
          "Playback is scrobbled automatically, and your shows' next episodes appear under “Up Next on Trakt” on Discover."),
      );
    },
  });

  gw.log("Trakt.tv Sync activated");
}
