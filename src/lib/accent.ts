// Native accent theming (baked in from the former Theme & Accent extension). The accent recolors
// --gg-teal / --gg-seafoam (and the derived --gg-btn-white) on :root; the chosen colors are mirrored
// to localStorage so main.tsx can apply them synchronously at boot (no accent flash), with the
// Tauri setting (accent_preset / accent_custom) as the source of truth re-read by the settings pane.

export interface AccentPreset {
  id: string;
  name: string;
  teal: string;
  seafoam: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "ghostly", name: "Ghostly", teal: "#2dcdd6", seafoam: "#5fe9da" },
  { id: "ocean", name: "Ocean", teal: "#3b82f6", seafoam: "#60a5fa" },
  { id: "grape", name: "Grape", teal: "#a855f7", seafoam: "#c084fc" },
  { id: "rose", name: "Rose", teal: "#ec4899", seafoam: "#f472b6" },
  { id: "crimson", name: "Crimson", teal: "#ef4444", seafoam: "#f87171" },
  { id: "sunset", name: "Sunset", teal: "#f97316", seafoam: "#fbbf24" },
  { id: "mint", name: "Mint", teal: "#10b981", seafoam: "#34d399" },
  { id: "gold", name: "Gold", teal: "#d4a017", seafoam: "#f5d36b" },
  { id: "mono", name: "Mono", teal: "#9ca3af", seafoam: "#e5e7eb" },
];

const LS_KEY = "gw.accent";

/** Set the accent CSS custom properties on :root. */
export function applyAccent(teal: string, seafoam: string): void {
  const r = document.documentElement.style;
  r.setProperty("--gg-teal", teal);
  r.setProperty("--gg-seafoam", seafoam);
  r.setProperty("--gg-btn-white", `color-mix(in srgb, ${seafoam} 14%, #ffffff)`);
}

/** Synchronously apply the accent saved in localStorage — call at boot before first paint. */
export function applySavedAccentSync(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const a = JSON.parse(raw);
    if (a && typeof a.teal === "string" && typeof a.seafoam === "string") applyAccent(a.teal, a.seafoam);
  } catch {
    /* ignore */
  }
}

/** Mirror the chosen accent to localStorage so the next boot applies it instantly. */
export function mirrorAccent(teal: string, seafoam: string): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ teal, seafoam })); } catch { /* ignore */ }
}

/** Revert to the default Ghostly accent (clears the overrides + the boot mirror). */
export function resetAccent(): void {
  const r = document.documentElement.style;
  r.removeProperty("--gg-teal");
  r.removeProperty("--gg-seafoam");
  r.removeProperty("--gg-btn-white");
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}
