// AniList Sync — a GhostWire reference extension.
//
// Trakt-for-anime: scrobbles anime episodes you watch to your AniList list (playback event bus +
// AniList GraphQL) and adds a "Continue Anime" Discover row of your in-progress shows' next episodes.
//
// AniList auth = paste an access token: create an API client at anilist.co/settings/developer with
// redirect URI https://anilist.co/api/v2/oauth/pin, open the authorize URL this shows you, and AniList
// hands you a token to paste in. No client secret, no redirect handling.
//
// It imports nothing — the app hands React, a UI kit, and `gw` to every render function.

const API = "https://graphql.anilist.co";
const scrobbled = new Set();
const listeners = new Set();
const notify = () => listeners.forEach((f) => { try { f(); } catch { /* ignore */ } });

export function activate(gw) {
  const cfg = () => ({
    token: gw.storage.get("token", null),
    user: gw.storage.get("user", null),
  });
  const connected = () => !!cfg().token;

  async function gql(query, variables, auth = true) {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const c = cfg();
    if (auth && c.token) headers.Authorization = `Bearer ${c.token}`;
    const res = await gw.fetch(API, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    if (!res.ok) throw new Error(`AniList ${res.status}`);
    const data = await res.json();
    if (data.errors) throw new Error(data.errors[0]?.message || "AniList error");
    return data.data;
  }

  async function whoAmI() {
    const d = await gql(`query { Viewer { id name } }`, {});
    return d?.Viewer?.name || null;
  }

  // Resolve a title → AniList anime media (id + episode count), then mark progress.
  async function scrobble(title, episode) {
    const search = await gql(
      `query ($s: String) { Media(search: $s, type: ANIME) { id episodes title { romaji english } } }`,
      { s: title },
      true,
    );
    const media = search?.Media;
    if (!media) return; // not an anime AniList knows → ignore (e.g. regular TV)
    const status = media.episodes && episode >= media.episodes ? "COMPLETED" : "CURRENT";
    await gql(
      `mutation ($id: Int, $p: Int, $st: MediaListStatus) { SaveMediaListEntry(mediaId: $id, progress: $p, status: $st) { id progress } }`,
      { id: media.id, p: episode, st: status },
      true,
    );
    gw.log(`AniList: ${media.title.romaji} → ep ${episode}`);
  }

  gw.onPlayback(async (ev) => {
    if (ev.kind !== "video" || !connected() || ev.episode == null) return;
    const pct = ev.progress != null ? ev.progress : 0;
    if (ev.state !== "ended" && pct < 80) return; // count it watched at 80% (or on finish)
    if (scrobbled.has(ev.id)) return;
    scrobbled.add(ev.id);
    try { await scrobble(ev.show || ev.title, ev.episode); }
    catch (e) { gw.log("scrobble failed:", e); }
  });

  async function fetchContinue() {
    const c = cfg();
    if (!c.token || !c.user) return [];
    const d = await gql(
      `query ($u: String) { MediaListCollection(userName: $u, type: ANIME, status: CURRENT) {
        lists { entries { progress updatedAt media { id episodes title { romaji english } coverImage { large } } } } } }`,
      { u: c.user }, true,
    );
    const entries = (d?.MediaListCollection?.lists || []).flatMap((l) => l.entries || []);
    entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return entries
      .filter((e) => !e.media.episodes || e.progress < e.media.episodes)
      .slice(0, 16)
      .map((e) => ({
        title: e.media.title.english || e.media.title.romaji,
        roma: e.media.title.romaji,
        next: (e.progress || 0) + 1,
        total: e.media.episodes || 0,
        poster: e.media.coverImage?.large || null,
      }));
  }

  const hueOf = (str) => { let h = 0; for (let i = 0; i < (str || "").length; i++) h = (h * 31 + str.charCodeAt(i)) % 360; return h; };

  gw.registerDiscoverRow({
    id: "anilist-continue",
    title: "Continue Anime",
    render: ({ React, ui, gw }) => {
      const h = React.createElement;
      const [items, setItems] = React.useState(null);
      React.useEffect(() => {
        if (!connected()) { setItems([]); return; }
        let alive = true;
        const run = () => fetchContinue().then((r) => { if (alive) setItems(r); }).catch(() => { if (alive) setItems([]); });
        run();
        listeners.add(run);
        return () => { alive = false; listeners.delete(run); };
      }, []);
      if (!connected()) return null;
      const head = h("div", { className: "prow-head" }, h("h2", { className: "prow-title" },
        h(ui.Icon, { icon: ui.icons.star, size: "sm" }), " Continue Anime"));
      if (items == null) return h("section", { className: "prow" }, head, h("div", { className: "prow-scroller" }, h("span", { className: "field-hint" }, "Loading from AniList…")));
      if (items.length === 0) return null;
      return h("section", { className: "prow" }, head,
        h("div", { className: "prow-scroller" },
          items.map((it, i) => {
            const query = `${it.roma || it.title} ${it.next}`;
            return h("button", {
              key: i, title: `Find ${it.title} episode ${it.next}`, onClick: () => gw.search(query),
              style: { display: "flex", flexDirection: "column", gap: 6, padding: 0, border: "none", background: "none", cursor: "pointer", textAlign: "left" },
            },
              it.poster
                ? h("div", { style: { aspectRatio: "2 / 3", borderRadius: 10, overflow: "hidden", backgroundImage: `url(${it.poster})`, backgroundSize: "cover", backgroundPosition: "center" } })
                : h("div", { style: { aspectRatio: "2 / 3", borderRadius: 10, background: `linear-gradient(150deg, hsl(${hueOf(it.title)} 36% 26%), hsl(${(hueOf(it.title) + 40) % 360} 46% 14%))`, display: "grid", placeItems: "center", color: "rgba(255,255,255,.85)" } }, h(ui.Icon, { icon: ui.icons.star, size: "xl" })),
              h("div", { style: { fontSize: 13, fontWeight: 600, lineHeight: 1.2, color: "var(--gg-text)" }, title: it.title }, it.title),
              h("div", { className: "field-hint", style: { fontSize: 11 } }, `Episode ${it.next}${it.total ? ` of ${it.total}` : ""}`),
            );
          }),
        ),
      );
    },
  });

  // ---- settings ----
  gw.registerSettingsSection({
    id: "anilist.config",
    label: "AniList",
    icon: "star",
    render: ({ React, ui }) => {
      const h = React.createElement;
      const [clientId, setClientId] = React.useState(() => gw.storage.get("clientId", ""));
      const [token, setToken] = React.useState("");
      const [user, setUser] = React.useState(() => gw.storage.get("user", null));
      const [status, setStatus] = React.useState("");
      const [busy, setBusy] = React.useState(false);

      const authUrl = clientId.trim()
        ? `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(clientId.trim())}&response_type=token`
        : null;

      const connect = async () => {
        if (!token.trim()) { setStatus("Paste the access token AniList gave you."); return; }
        setBusy(true); setStatus("");
        gw.storage.set("token", token.trim());
        try {
          const name = await whoAmI();
          if (!name) throw new Error("token rejected");
          gw.storage.set("user", name);
          setUser(name);
          setToken("");
          setStatus("Connected!");
          gw.toast(`AniList connected as ${name}`);
          notify();
        } catch (e) {
          gw.storage.set("token", null);
          setStatus(`Couldn't connect: ${e && e.message ? e.message : e}`);
        } finally { setBusy(false); }
      };
      const disconnect = () => { gw.storage.set("token", null); gw.storage.set("user", null); setUser(null); setStatus("Disconnected."); notify(); };

      return h("div", { className: "settings-group", style: { display: "grid", gap: 12, maxWidth: 520 } },
        user
          ? h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
              h(ui.Icon, { icon: ui.icons.check, size: "sm" }), h("span", null, "Connected as ", h("b", null, user)),
              h(ui.Button, { variant: "secondary", shape: "pill", size: "sm", onClick: disconnect }, "Disconnect"))
          : h(React.Fragment, null,
              h("p", { className: "field-hint", style: { margin: 0 } },
                "Create an API client at anilist.co/settings/developer (redirect URI: https://anilist.co/api/v2/oauth/pin), paste its Client ID, open the link, and paste the token AniList shows you."),
              h("div", null, h("div", { className: "field-hint", style: { marginBottom: 4 } }, "AniList Client ID"),
                h(ui.Input, { shape: "pill", value: clientId, placeholder: "e.g. 12345",
                  onChange: (e) => { setClientId(e.currentTarget.value); gw.storage.set("clientId", e.currentTarget.value.trim()); }, onClear: () => { setClientId(""); gw.storage.set("clientId", ""); } })),
              authUrl && h("div", { style: { fontSize: 12, wordBreak: "break-all" } },
                h("span", { className: "field-hint" }, "Open this, authorize, copy the token: "),
                h("code", { style: { color: "var(--gg-seafoam)" } }, authUrl)),
              h("div", null, h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Access token"),
                h(ui.Input, { shape: "pill", type: "password", value: token, placeholder: "Paste your AniList token",
                  onChange: (e) => setToken(e.currentTarget.value), onClear: () => setToken("") })),
              h(ui.Button, { variant: "primary", shape: "pill", icon: ui.icons.link2, onClick: connect, disabled: busy },
                busy ? "Connecting…" : "Connect AniList")),
        status && h("span", { className: "field-hint" }, status),
      );
    },
  });

  gw.log("AniList Sync activated");
}
