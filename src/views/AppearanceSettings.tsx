import { useEffect, useState } from "react";
import { getSetting, setSetting } from "../ipc/library";
import { ACCENT_PRESETS, applyAccent, mirrorAccent, resetAccent } from "../lib/accent";

/** Appearance settings — the accent picker (baked in from the former Theme & Accent extension).
 *  Persists `accent_preset` / `accent_custom` and recolors --gg-teal/--gg-seafoam live. */
export function AppearanceSettings() {
  const [presetId, setPresetId] = useState<string>("ghostly");
  const [custom, setCustom] = useState<{ teal: string; seafoam: string } | null>(null);

  // Hydrate the current selection from the saved settings.
  // (Visuals already hydrate from the localStorage mirror at boot; this just
  //  syncs the picker's selected swatch. Swallow errors so a missing IPC/setting
  //  never surfaces as an unhandled rejection.)
  useEffect(() => {
    void getSetting("accent_custom").then((raw) => {
      if (raw) { try { const c = JSON.parse(raw); if (c?.teal) { setCustom(c); return; } } catch { /* ignore */ } }
      void getSetting("accent_preset").then((p) => setPresetId(p || "ghostly")).catch(() => {});
    }).catch(() => {});
  }, []);

  const choosePreset = (p: typeof ACCENT_PRESETS[number]) => {
    setPresetId(p.id);
    setCustom(null);
    applyAccent(p.teal, p.seafoam);
    mirrorAccent(p.teal, p.seafoam);
    void setSetting("accent_preset", p.id).catch(() => {});
    void setSetting("accent_custom", "").catch(() => {});
  };
  const chooseCustom = (hex: string) => {
    const teal = hex;
    const seafoam = `color-mix(in srgb, ${hex} 70%, #ffffff)`;
    const c = { teal, seafoam };
    setCustom(c);
    applyAccent(teal, seafoam);
    mirrorAccent(teal, seafoam);
    void setSetting("accent_custom", JSON.stringify(c)).catch(() => {});
  };
  const reset = () => {
    setPresetId("ghostly");
    setCustom(null);
    resetAccent();
    void setSetting("accent_preset", "ghostly").catch(() => {});
    void setSetting("accent_custom", "").catch(() => {});
  };

  return (
    <div className="settings-group" style={{ display: "grid", gap: 14, maxWidth: 460 }}>
      <div>
        <div className="field-label">Accent</div>
        <div className="field-hint" style={{ marginBottom: 8 }}>Recolors buttons, the visualizer, highlights and more.</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {ACCENT_PRESETS.map((p) => {
            const selected = !custom && presetId === p.id;
            return (
              <button
                key={p.id}
                title={p.name}
                aria-label={p.name}
                onClick={() => choosePreset(p)}
                style={{
                  width: 34, height: 34, borderRadius: 9, cursor: "pointer", flex: "none",
                  background: `linear-gradient(135deg, ${p.teal}, ${p.seafoam})`,
                  border: selected ? "2px solid var(--gg-text)" : "2px solid var(--gg-border)",
                  boxShadow: selected ? "0 0 0 2px var(--gg-bg)" : "none",
                }}
              />
            );
          })}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="field-hint">Custom color</span>
        <input
          type="color"
          value={custom && /^#[0-9a-f]{6}$/i.test(custom.teal) ? custom.teal : "#2dcdd6"}
          onChange={(e) => chooseCustom(e.currentTarget.value)}
          style={{ width: 40, height: 34, border: "1px solid var(--gg-border)", borderRadius: 8, background: "var(--gg-surface-2)", cursor: "pointer", padding: 2 }}
        />
        {custom && <span className="field-hint">Using a custom accent</span>}
        <button className="link-btn" onClick={reset} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--gg-seafoam)", cursor: "pointer", font: "inherit", fontSize: 13 }}>
          Reset
        </button>
      </div>
    </div>
  );
}
