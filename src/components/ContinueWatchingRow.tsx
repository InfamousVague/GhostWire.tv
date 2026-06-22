import { useEffect, useReducer } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { play } from "../lib/icons";
import { getContinueWatching, subscribeWatchProgress, type WatchEntry } from "../lib/watchProgress";
import { PosterRow } from "./PosterRow";

const fmtT = (s: number): string => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const hueOf = (str: string): number => { let h = 0; for (let i = 0; i < (str || "").length; i++) h = (h * 31 + str.charCodeAt(i)) % 360; return h; };
const sxe = (s?: number, e?: number): string => (e != null ? `S${String(s || 1).padStart(2, "0")}E${String(e).padStart(2, "0")}` : "");

/** Native "Continue Watching" Discover rail — resumes where you left off (re-searches the title;
 *  the player seeks back automatically when the same release plays). Baked in from the extension. */
export function ContinueWatchingRow({ onSearch }: { onSearch: (q: string) => void }) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribeWatchProgress(force), []);
  const items = getContinueWatching();
  if (items.length === 0) return null;

  const card = (it: WatchEntry) => {
    const label = sxe(it.season, it.episode);
    const query = it.show ? `${it.show} ${label}` : it.title;
    const hue = hueOf(it.title);
    return (
      <button
        key={it.id}
        title={`Resume ${it.title}${label ? ` ${label}` : ""}`}
        onClick={() => onSearch(query)}
        style={{ display: "flex", flexDirection: "column", gap: 6, padding: 0, border: "none", background: "none", cursor: "pointer", textAlign: "left" }}
      >
        <div style={{ position: "relative", aspectRatio: "2 / 3", borderRadius: 10, overflow: "hidden", background: `linear-gradient(150deg, hsl(${hue} 34% 26%), hsl(${(hue + 40) % 360} 44% 14%))`, display: "grid", placeItems: "center", color: "rgba(255,255,255,.85)" }}>
          <Icon icon={play} size="xl" />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 4, background: "rgba(0,0,0,.45)" }}>
            <div style={{ height: "100%", width: `${Math.max(2, Math.min(100, it.pct))}%`, background: "var(--gg-seafoam)" }} />
          </div>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2, color: "var(--gg-text)" }} title={it.title}>{it.title}</div>
        <div className="field-hint" style={{ fontSize: 11 }}>{label ? `${label} · ` : ""}{fmtT(it.position)}{it.duration ? ` / ${fmtT(it.duration)}` : ""}</div>
      </button>
    );
  };

  return <PosterRow title="Continue Watching" count={items.length}>{items.map(card)}</PosterRow>;
}
