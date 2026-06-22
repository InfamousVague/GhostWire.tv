// Subtitle Translator — a GhostWire reference extension.
//
// Subtitle-provider that fetches an English subtitle (OpenSubtitles, keyless) and translates every
// cue into your language with a LibreTranslate instance (its /translate endpoint accepts an array of
// strings, so cue alignment is exact). The translated track shows up in the player's CC menu.
//
// LibreTranslate's public host needs an API key; most users point this at a self-hosted or public
// instance. Set the instance + key (if any) + target language in the extension's settings.
//
// It imports nothing — the app hands React, a UI kit, and `gw` to every render function.

const TARGETS = [
  ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"],
  ["pt", "Portuguese"], ["nl", "Dutch"], ["ru", "Russian"], ["pl", "Polish"], ["tr", "Turkish"],
  ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["ar", "Arabic"], ["hi", "Hindi"],
];

export function activate(gw) {
  const cfg = () => ({
    instance: (gw.storage.get("instance", "https://libretranslate.com") || "").trim().replace(/\/+$/, ""),
    apiKey: (gw.storage.get("apiKey", "") || "").trim(),
    target: gw.storage.get("target", "es"),
  });

  async function gunzipToText(bytes) {
    try {
      if (typeof DecompressionStream !== "undefined") {
        const ds = new DecompressionStream("gzip");
        const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
        const text = new TextDecoder("utf-8").decode(buf);
        if (text.includes("-->")) return text;
      }
    } catch { /* not gzip */ }
    return new TextDecoder("utf-8").decode(bytes);
  }

  // Grab the most-downloaded English .srt for this media from OpenSubtitles' keyless REST API.
  async function fetchSourceSrt(q) {
    const enc = (s) => encodeURIComponent(String(s).trim());
    let url = `https://rest.opensubtitles.org/search/query-${enc(q.title)}`;
    if (q.episode != null) url += `/episode-${q.episode}`;
    if (q.season != null) url += `/season-${q.season}`;
    url += "/sublanguageid-eng";
    const res = await gw.fetch(url);
    if (!res.ok) return null;
    let rows;
    try { rows = await res.json(); } catch { return null; }
    if (!Array.isArray(rows)) return null;
    const srts = rows.filter((r) => r.SubDownloadLink && (!r.SubFormat || /srt/i.test(r.SubFormat)));
    srts.sort((a, b) => (parseInt(b.SubDownloadsCnt, 10) || 0) - (parseInt(a.SubDownloadsCnt, 10) || 0));
    for (const r of srts.slice(0, 3)) {
      try {
        const dl = await gw.fetch(r.SubDownloadLink, { binary: true });
        if (!dl.ok) continue;
        const srt = await gunzipToText(await dl.bytes());
        if (srt && srt.includes("-->")) return srt;
      } catch { /* try next */ }
    }
    return null;
  }

  function parseSrt(srt) {
    const cues = [];
    for (const block of srt.replace(/\r/g, "").split(/\n\n+/)) {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      const ti = lines.findIndex((l) => l.includes("-->"));
      if (ti < 0) continue;
      cues.push({ timing: lines[ti].replace(/,(\d{3})/g, ".$1"), text: lines.slice(ti + 1).join("\n") });
    }
    return cues;
  }
  const cuesToVtt = (cues) => "WEBVTT\n\n" + cues.map((c, i) => `${i + 1}\n${c.timing}\n${c.text}`).join("\n\n");

  async function translate(texts, target, instance, apiKey) {
    const out = [];
    const BATCH = 60;
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH);
      const body = { q: chunk, source: "auto", target, format: "text" };
      if (apiKey) body.api_key = apiKey;
      const res = await gw.fetch(`${instance}/translate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`LibreTranslate ${res.status}`);
      const data = await res.json();
      const t = data.translatedText;
      if (Array.isArray(t) && t.length === chunk.length) out.push(...t);
      else if (typeof t === "string" && chunk.length === 1) out.push(t);
      else out.push(...chunk); // alignment mismatch → keep originals for this batch
    }
    return out;
  }

  gw.registerSubtitleProvider({
    id: "translate",
    label: "Translated",
    fetch: async (q) => {
      const { instance, apiKey, target } = cfg();
      if (!q || !q.title || !instance || !target) return [];
      try {
        const srt = await fetchSourceSrt(q);
        if (!srt) return [];
        const cues = parseSrt(srt);
        if (cues.length === 0) return [];
        const translated = await translate(cues.map((c) => c.text), target, instance, apiKey);
        const outCues = cues.map((c, i) => ({ timing: c.timing, text: translated[i] || c.text }));
        const name = (TARGETS.find(([id]) => id === target) || [target, target])[1];
        return [{ label: `${name} (translated)`, lang: target, format: "vtt", content: cuesToVtt(outCues) }];
      } catch (e) {
        gw.log("translate provider failed:", e);
        return [];
      }
    },
  });

  // ---- settings ----
  gw.registerSettingsSection({
    id: "translator.config",
    label: "Subtitle Translator",
    icon: "globe",
    render: ({ React, ui }) => {
      const h = React.createElement;
      const [instance, setInstance] = React.useState(() => gw.storage.get("instance", "https://libretranslate.com"));
      const [apiKey, setApiKey] = React.useState(() => gw.storage.get("apiKey", ""));
      const [target, setTarget] = React.useState(() => gw.storage.get("target", "es"));
      const save = (k, v, set) => { set(v); gw.storage.set(k, typeof v === "string" ? v.trim() : v); };

      return h("div", { className: "settings-group", style: { display: "grid", gap: 12, maxWidth: 480 } },
        h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Translate subtitles into"),
          h("div", { className: "chip-row", style: { gap: 6, flexWrap: "wrap" } },
            TARGETS.map(([id, name]) => h("button", {
              key: id, className: "search-chip",
              style: target === id ? { borderColor: "var(--gg-seafoam)", color: "var(--gg-text)", background: "color-mix(in srgb, var(--gg-seafoam) 14%, transparent)" } : undefined,
              onClick: () => save("target", id, setTarget),
            }, name)),
          ),
        ),
        h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, "LibreTranslate instance"),
          h(ui.Input, { shape: "pill", value: instance, iconLeft: ui.icons.globe, placeholder: "https://libretranslate.com",
            onChange: (e) => save("instance", e.currentTarget.value, setInstance), onClear: () => save("instance", "", setInstance) }),
        ),
        h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, "API key (if the instance needs one)"),
          h(ui.Input, { shape: "pill", type: "password", value: apiKey, placeholder: "optional",
            onChange: (e) => save("apiKey", e.currentTarget.value, setApiKey), onClear: () => save("apiKey", "", setApiKey) }),
        ),
        h("p", { className: "field-hint", style: { margin: 0 } },
          "Open a video — a translated track appears in the subtitles (CC) menu under “Translated”. libretranslate.com needs an API key; or point this at a self-hosted/public instance."),
      );
    },
  });

  gw.log("Subtitle Translator activated");
}
