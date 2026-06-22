// RSS Auto-Downloader — a GhostWire reference extension.
//
// Watches RSS/Atom torrent feeds on a timer and auto-queues new items whose title matches a filter.
// Exercises: a background poller (module-scoped so the host's deactivate() tears it down on toggle),
// gw.fetch (permissioned host-fetch), gw.downloads.add, a nav view, commands, and storage.
//
// It imports nothing — the app hands React, a UI kit, and `gw` to every render function.

// Module-scoped so deactivate() can stop it. A fresh module instance is created per (re)activation,
// so each instance owns exactly one timer.
let pollTimer = null;

export function activate(gw) {
  const MIN_INTERVAL = 5;
  const loadFeeds = () => gw.storage.get("feeds", []);
  const saveFeeds = (f) => gw.storage.set("feeds", f);
  const loadSeen = () => gw.storage.get("seen", {}); // feedId -> [guids]
  const saveSeen = (s) => gw.storage.set("seen", s);
  const loadLog = () => gw.storage.get("log", []); // [{title, feed, at}]
  const intervalMin = () => Math.max(MIN_INTERVAL, Number(gw.storage.get("intervalMin", 15)) || 15);

  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());

  // Pull the first magnet link out of a parsed feed <item>/<entry>. Reads parsed DOM values (entities
  // already decoded), covering enclosure URLs, <link>, namespaced <torrent:magnetURI>, and Torznab attrs.
  function magnetFrom(item) {
    const cands = [];
    const enc = item.querySelector("enclosure");
    if (enc) cands.push(enc.getAttribute("url"));
    const link = item.querySelector("link");
    if (link) cands.push(link.getAttribute("href") || link.textContent);
    const guid = item.querySelector("guid");
    if (guid) cands.push(guid.textContent);
    for (const el of item.getElementsByTagName("*")) {
      const ln = (el.localName || el.nodeName || "").toLowerCase();
      if (ln === "magneturi" || ln === "magneturl") cands.push(el.textContent);
      if (ln === "attr" && el.getAttribute && el.getAttribute("name") === "magneturl") cands.push(el.getAttribute("value"));
    }
    return cands.find((v) => v && v.trim().toLowerCase().startsWith("magnet:")) || null;
  }

  // A STABLE per-item key for the seen-set. Prefer the torrent's btih infohash parsed from the
  // magnet — it's identical across every poll, unlike Jackett/Prowlarr Torznab <guid>/<link> values
  // which carry a rotating apikey/token/timestamp per request (so keying on those re-grabbed the same
  // release on every poll). Falls back to guid/link/magnet for feeds without a btih magnet.
  function infohashOf(magnet) {
    const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet || "");
    return m ? m[1].toLowerCase() : null;
  }
  function itemKey(item, magnet) {
    return (
      infohashOf(magnet) ||
      (item.querySelector("guid")?.textContent || item.querySelector("link")?.textContent || magnet || "").trim()
    );
  }

  function titleMatches(title, filter) {
    const f = (filter || "").trim();
    if (!f) return true;
    try { return new RegExp(f, "i").test(title); }
    catch { return title.toLowerCase().includes(f.toLowerCase()); }
  }

  async function pollFeed(feed) {
    if (!feed.enabled || !feed.url) return 0;
    const res = await gw.fetch(feed.url, { headers: { Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml" } });
    if (!res.ok) throw new Error(`feed ${res.status}`);
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("invalid feed XML");

    const seen = loadSeen();
    const feedSeen = new Set(seen[feed.id] || []);
    const items = [...doc.querySelectorAll("item"), ...doc.querySelectorAll("entry")];
    let grabbed = 0;
    const presentKeys = []; // every item key in THIS feed window — kept "seen" so nothing re-grabs
    for (const item of items) {
      const title = (item.querySelector("title")?.textContent || "").trim() || "Untitled";
      const magnet = magnetFrom(item);
      if (!magnet) continue;
      const key = itemKey(item, magnet);
      presentKeys.push(key);
      if (feedSeen.has(key)) continue; // already handled on a previous poll
      feedSeen.add(key); // mark seen the instant we consider it (dedupes within a single poll too)
      if (!titleMatches(title, feed.filter)) continue; // seen, but not a match → never grab
      gw.downloads.add(magnet);
      grabbed++;
      const log = loadLog();
      gw.storage.set("log", [{ title, feed: feed.title || feed.url, at: Date.now() }, ...log].slice(0, 60));
    }
    // Persist EVERY key still present in the feed window (so an item the feed keeps serving is never
    // forgotten and re-grabbed — the old code capped at the 300 newest GRABBED guids, which evicted
    // still-listed items on busy feeds), unioned with prior seen keys, capped generously.
    seen[feed.id] = [...new Set([...presentKeys, ...(seen[feed.id] || [])])].slice(0, 1000);
    saveSeen(seen);
    return grabbed;
  }

  async function pollAll(announce) {
    const feeds = loadFeeds();
    let total = 0;
    for (const feed of feeds) {
      try { total += await pollFeed(feed); }
      catch (e) { gw.log(`poll ${feed.url} failed:`, e); }
    }
    gw.storage.set("lastChecked", Date.now());
    if (announce) gw.toast(total ? `RSS: queued ${total} new item${total === 1 ? "" : "s"}` : "RSS: no new items");
    emit();
    return total;
  }

  function schedule() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { void pollAll(false); }, intervalMin() * 60 * 1000);
  }
  // Kick off: an initial poll shortly after activation, then on the interval.
  schedule();
  setTimeout(() => { void pollAll(false); }, 4000);

  // ---- feed mutations ----
  function addFeed(url, filter) {
    const u = (url || "").trim();
    if (!u) return;
    const feeds = loadFeeds();
    if (feeds.some((f) => f.url === u)) return;
    saveFeeds([...feeds, { id: `feed-${Date.now()}`, url: u, title: hostOf(u), filter: (filter || "").trim(), enabled: true }]);
    emit();
  }
  function removeFeed(id) { saveFeeds(loadFeeds().filter((f) => f.id !== id)); emit(); }
  function toggleFeed(id, on) { saveFeeds(loadFeeds().map((f) => (f.id === id ? { ...f, enabled: on } : f))); emit(); }
  function hostOf(u) { try { return new URL(u).host; } catch { return u; } }

  // ---- nav + view ----
  gw.registerNav({ id: "rss-auto", label: "RSS", icon: "rss" });
  gw.registerView({
    id: "rss-auto",
    render: ({ React, ui }) => {
      const h = React.createElement;
      const [, force] = React.useReducer((x) => x + 1, 0);
      React.useEffect(() => { listeners.add(force); return () => listeners.delete(force); }, []);
      const [url, setUrl] = React.useState("");
      const [filter, setFilter] = React.useState("");
      const [mins, setMins] = React.useState(() => String(intervalMin()));
      const feeds = loadFeeds();
      const log = loadLog();
      const lastChecked = gw.storage.get("lastChecked", 0);

      const add = () => { addFeed(url, filter); setUrl(""); setFilter(""); };
      const saveMins = (v) => {
        setMins(v);
        const n = Math.max(MIN_INTERVAL, Number(v) || 15);
        gw.storage.set("intervalMin", n);
        schedule();
      };

      return h("div", { className: "section-stack", style: { maxWidth: 760 } },
        h("div", { className: "cat-header" },
          h("span", { className: "cat-title section-title" },
            h(ui.Icon, { icon: ui.icons.rss, size: "base" }), " RSS Auto-Downloader"),
          h("span", { className: "cat-sub" },
            lastChecked ? `last checked ${timeAgo(lastChecked)}` : "not checked yet"),
        ),
        // Add-feed bar
        h("div", { className: "settings-group", style: { display: "grid", gap: 8, width: "100%" } },
          h(ui.Input, {
            shape: "pill", value: url, iconLeft: ui.icons.rss,
            placeholder: "Feed URL (RSS/Atom with magnets)…",
            onChange: (e) => setUrl(e.currentTarget.value), onClear: () => setUrl(""),
            onKeyDown: (e) => { if (e.key === "Enter") add(); },
          }),
          h("div", { style: { display: "flex", gap: 8 } },
            h(ui.Input, {
              shape: "pill", value: filter, iconLeft: ui.icons.search,
              placeholder: "Title filter (regex, optional)",
              onChange: (e) => setFilter(e.currentTarget.value), onClear: () => setFilter(""),
              onKeyDown: (e) => { if (e.key === "Enter") add(); },
            }),
            h(ui.Button, { variant: "primary", shape: "pill", icon: ui.icons.plus, onClick: add, disabled: !url.trim() }, "Add feed"),
          ),
          h("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
            h("span", { className: "field-hint" }, "Check every"),
            h("input", {
              type: "number", min: MIN_INTERVAL, value: mins,
              onChange: (e) => saveMins(e.currentTarget.value),
              style: { width: 64, padding: "4px 8px", borderRadius: 8, border: "1px solid var(--gg-border)", background: "var(--gg-surface-2)", color: "inherit" },
            }),
            h("span", { className: "field-hint" }, "min"),
            h(ui.Button, { variant: "secondary", shape: "pill", icon: ui.icons.download, onClick: () => pollAll(true) }, "Check now"),
          ),
        ),
        // Feeds
        feeds.length === 0
          ? h("div", { className: "empty" }, h("div", { className: "empty-inner" },
              h("span", { className: "empty-glyph" }, h(ui.Icon, { icon: ui.icons.rss, size: "xl" })),
              h("h3", null, "No feeds yet"),
              h("p", null, "Add a torrent RSS feed above — matching items download automatically."),
            ))
          : h("div", { className: "track-list", style: { width: "100%" } },
              feeds.map((f) => h("div", { key: f.id, className: "track-row" },
                h("div", { style: { minWidth: 0, flex: 1 } },
                  h("div", { className: "track-name", title: f.url }, f.title || f.url),
                  h("div", { className: "field-hint", style: { fontSize: 11 } },
                    f.filter ? `filter: ${f.filter}` : "no filter (all items)"),
                ),
                h(ui.Toggle, { checked: f.enabled, onChange: (e) => toggleFeed(f.id, e.currentTarget.checked), "aria-label": "Enable feed" }),
                h("button", { className: "track-like", title: "Remove", onClick: () => removeFeed(f.id) },
                  h(ui.Icon, { icon: ui.icons.x, size: "sm" })),
              )),
            ),
        // Activity log
        log.length > 0 && h("div", { style: { width: "100%" } },
          h("div", { className: "search-sec-head" }, h("span", { className: "search-sec-title" },
            h(ui.Icon, { icon: ui.icons.download, size: "sm" }), " Recently grabbed")),
          h("div", { className: "track-list" },
            log.slice(0, 12).map((e, i) => h("div", { key: i, className: "track-row" },
              h("span", { className: "track-name", title: e.title }, e.title),
              h("span", { className: "field-hint", style: { fontSize: 11 } }, `${e.feed} · ${timeAgo(e.at)}`),
            ))),
        ),
      );
    },
  });

  // ---- commands ----
  gw.registerCommand({ id: "rss-auto.open", label: "Open RSS Auto-Downloader", group: "Go to", icon: "rss", keywords: "feed subscribe", run: () => gw.navigate("rss-auto") });
  gw.registerCommand({ id: "rss-auto.poll", label: "Check RSS feeds now", group: "Actions", icon: "rss", keywords: "poll refresh feed", run: () => pollAll(true) });

  gw.log("RSS Auto-Downloader activated");
}

export function deactivate() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
