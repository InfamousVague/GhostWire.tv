// Subtitle Fetcher — a GhostWire reference extension.
//
// Proves the SUBTITLE-PROVIDER slot + binary host-fetch. When you open a video, the player asks
// every registered subtitle provider for tracks; this one searches OpenSubtitles' free, keyless
// legacy REST API, downloads the most-popular gzipped .srt via gw.fetch({binary:true}), gunzips it
// in the webview, and hands back plain SRT — the host converts it to a WebVTT <track>.
//
// It imports nothing — the app hands React, a UI kit, and `gw` to every render function.

export function activate(gw) {
  const langPref = () => gw.storage.get("lang", "eng") || "eng";

  // OpenSubtitles serves the .srt gzipped; decompress in the webview. Falls back to treating the
  // bytes as plain text if they aren't actually gzip (some mirrors return raw .srt).
  async function gunzipToText(bytes) {
    try {
      if (typeof DecompressionStream !== "undefined") {
        const ds = new DecompressionStream("gzip");
        const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
        const text = new TextDecoder("utf-8").decode(buf);
        if (text.includes("-->")) return text;
      }
    } catch {
      /* not gzip — fall through */
    }
    return new TextDecoder("utf-8").decode(bytes);
  }

  function searchUrl(q) {
    const enc = (s) => encodeURIComponent(String(s).trim());
    let url = `https://rest.opensubtitles.org/search/query-${enc(q.title)}`;
    if (q.episode != null) url += `/episode-${q.episode}`;
    if (q.season != null) url += `/season-${q.season}`;
    url += `/sublanguageid-${langPref()}`;
    return url;
  }

  gw.registerSubtitleProvider({
    id: "opensubtitles",
    label: "OpenSubtitles",
    fetch: async (q) => {
      if (!q || !q.title) return [];
      const res = await gw.fetch(searchUrl(q));
      if (!res.ok) return [];
      let rows;
      try { rows = await res.json(); } catch { return []; }
      if (!Array.isArray(rows)) return [];
      // Keep downloadable SRTs, prefer the most-downloaded (widely-used → most likely correct).
      const srts = rows.filter((r) => r.SubDownloadLink && (!r.SubFormat || /srt/i.test(r.SubFormat)));
      srts.sort((a, b) => (parseInt(b.SubDownloadsCnt, 10) || 0) - (parseInt(a.SubDownloadsCnt, 10) || 0));
      const out = [];
      for (const r of srts.slice(0, 3)) {
        try {
          const dl = await gw.fetch(r.SubDownloadLink, { binary: true });
          if (!dl.ok) continue;
          const srt = await gunzipToText(await dl.bytes());
          if (!srt || !srt.includes("-->")) continue;
          const downloads = parseInt(r.SubDownloadsCnt, 10) || 0;
          out.push({
            label: `${(r.SubLanguageID || "sub").toUpperCase()} · ${downloads.toLocaleString()}↓`,
            lang: r.SubLanguageID || langPref(),
            format: "srt",
            content: srt,
          });
        } catch (e) {
          gw.log("download failed:", e);
        }
      }
      return out;
    },
  });

  // ---- settings: preferred language ----
  const LANGS = [
    ["eng", "English"], ["spa", "Spanish"], ["fre", "French"], ["ger", "German"],
    ["ita", "Italian"], ["por", "Portuguese"], ["jpn", "Japanese"], ["kor", "Korean"],
    ["chi", "Chinese"], ["rus", "Russian"], ["ara", "Arabic"], ["dut", "Dutch"],
  ];
  gw.registerSettingsSection({
    id: "subtitle-fetcher.config",
    label: "Subtitles",
    icon: "captions",
    render: ({ React, ui }) => {
      const h = React.createElement;
      const [lang, setLang] = React.useState(() => gw.storage.get("lang", "eng"));
      const pick = (v) => { setLang(v); gw.storage.set("lang", v); };
      return h("div", { className: "settings-group", style: { display: "grid", gap: 10, maxWidth: 420 } },
        h("div", { className: "field-hint" }, "Preferred subtitle language"),
        h("div", { className: "chip-row", style: { gap: 6, flexWrap: "wrap" } },
          LANGS.map(([id, name]) => h("button", {
            key: id,
            className: "search-chip",
            style: lang === id
              ? { borderColor: "var(--gg-seafoam)", color: "var(--gg-text)", background: "color-mix(in srgb, var(--gg-seafoam) 14%, transparent)" }
              : undefined,
            onClick: () => pick(id),
          }, name)),
        ),
        h("p", { className: "field-hint", style: { margin: 0 } },
          "Open a video — matching OpenSubtitles tracks appear in the player's subtitles (CC) menu under “OpenSubtitles”."),
      );
    },
  });

  gw.log("Subtitle Fetcher activated");
}
