import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as React from "react";
import { useExtensions, type PlayerControlSet } from "./host";
import type { Command } from "../components/CommandPalette";
import type { ExtApi, ExtMusicImporter, ExtRender, ExtSearchResult, ExtUI, PlaybackEvent, SubtitleQuery, Tagged } from "./sdk";
import type { CatalogItem } from "../lib/types";
import type { SubTrack } from "../ipc/engine";

/** Resolve a contributed icon NAME (e.g. "clock") to its SVG string, or undefined. */
function useIconResolver() {
  const { ui } = useExtensions();
  return (name?: string): string | undefined => (name ? ui.icons[name] : undefined);
}

/** Nav-rail entries contributed by extensions (icon resolved to an SVG string). */
export function useExtNavEntries(): Array<{ id: string; label: string; icon?: string }> {
  const { registry, ui } = useExtensions();
  return useMemo(
    () => registry.nav.map((n) => ({ id: n.id, label: n.label, icon: n.icon ? ui.icons[n.icon] : undefined })),
    [registry.nav, ui],
  );
}

/** Is `viewId` a view contributed by an extension? */
export function useIsExtView(viewId: string): boolean {
  const { registry } = useExtensions();
  return registry.views.some((v) => v.id === viewId);
}

/** ⌘K commands contributed by extensions, mapped to the app's Command shape. */
export function useExtCommands(): Command[] {
  const { registry, ui } = useExtensions();
  return useMemo(
    () =>
      registry.commands.map((c) => ({
        id: `ext:${c.extId}:${c.id}`,
        label: c.label,
        group: c.group || "Extensions",
        icon: c.icon ? ui.icons[c.icon] : undefined,
        hint: c.hint,
        keywords: c.keywords,
        run: c.run,
      })),
    [registry.commands, ui],
  );
}

const INFOHASH_RE = /xt=urn:btih:([0-9a-z]+)/i;

/** Normalize an extension search hit into a full CatalogItem (host derives the id + fills defaults).
 *  Returns null when the magnet has no infohash (can't dedupe it, so we drop it). */
function toCatalogItem(r: ExtSearchResult, sourceLabel: string, now: number): CatalogItem | null {
  const m = INFOHASH_RE.exec(r.magnet);
  if (!m) return null;
  return {
    id: m[1].toLowerCase(),
    title: r.title,
    magnet: r.magnet,
    sizeBytes: r.sizeBytes ?? 0,
    seeders: r.seeders ?? 0,
    leechers: r.leechers ?? 0,
    source: sourceLabel,
    category: r.category ?? "other",
    addedAt: now,
    poster: r.poster,
    description: r.description,
    year: r.year,
  };
}

/** Returns a function that runs every enabled extension search source for a query and returns the
 *  merged, normalized CatalogItems. Each source is isolated — one throwing can't fail the others. */
export function useExtSearch(): (query: string, now: number) => Promise<CatalogItem[]> {
  const { registry } = useExtensions();
  const sources = registry.searchSources;
  return useCallback(
    async (query: string, now: number) => {
      if (sources.length === 0) return [];
      const batches = await Promise.all(
        sources.map(async (s) => {
          try {
            const hits = await s.search(query);
            return hits
              .map((h) => toCatalogItem(h, s.label, now))
              .filter((x): x is CatalogItem => x !== null);
          } catch (e) {
            console.error(`[ext] search source ${s.extId}:${s.id} failed:`, e);
            return [] as CatalogItem[];
          }
        }),
      );
      return batches.flat();
    },
    [sources],
  );
}

/** Lives INSIDE the ExtensionProvider and hands App.tsx (which sits above it) a stable callback for
 *  running the current extension search sources. Renders nothing. */
export function ExtSearchBridge({ onReady }: { onReady: (run: (query: string, now: number) => Promise<CatalogItem[]>) => void }) {
  const run = useExtSearch();
  useEffect(() => { onReady(run); }, [run, onReady]);
  return null;
}

/** The active (first enabled) music-link importer, or null when none is registered (its providing
 *  extension is disabled). */
export function useMusicImporter(): Tagged<ExtMusicImporter> | null {
  const { registry } = useExtensions();
  return registry.musicImporters[0] ?? null;
}

/** Lives INSIDE the ExtensionProvider; hands App.tsx (which sits above it) the current music-link
 *  importer — or null when its extension is disabled, which gates the app's import affordances.
 *  Renders nothing. */
export function ExtMusicImporterBridge({ onChange }: { onChange: (imp: Tagged<ExtMusicImporter> | null) => void }) {
  const importer = useMusicImporter();
  useEffect(() => { onChange(importer); }, [importer, onChange]);
  return null;
}

/** Lives INSIDE the ExtensionProvider; reports the set of extension-contributed view ids to App.tsx
 *  (above it) so it can hide the app's contextual sidebar for full-canvas extension pages (they own
 *  their entire layout), while keeping it for views that contribute their own sidebar. Renders nothing. */
export function ExtViewIdsBridge({ onChange }: { onChange: (info: { ids: string[]; sidebars: string[] }) => void }) {
  const { registry } = useExtensions();
  const ids = registry.views.map((v) => v.id);
  const sidebars = registry.views.filter((v) => v.sidebar).map((v) => v.id);
  const key = ids.join(",") + "|" + sidebars.join(",");
  useEffect(() => { onChange({ ids, sidebars }); }, [key, onChange]);
  return null;
}

// ---- Playback event bus ----

/** Returns emit(ev) that fans a PlaybackEvent out to every extension onPlayback handler, each
 *  isolated so one throwing extension can't break playback. Pass {throttleMs} for progress ticks.
 *  Stable identity (reads handlers via a ref) so it never re-fires the player's effects. */
export function usePlaybackEmit(): (ev: PlaybackEvent, opts?: { throttleMs?: number }) => void {
  const { registry } = useExtensions();
  const handlersRef = useRef(registry.playbackHandlers);
  handlersRef.current = registry.playbackHandlers;
  const lastEmit = useRef(0);
  return useCallback((ev: PlaybackEvent, opts?: { throttleMs?: number }) => {
    if (opts?.throttleMs) {
      const now = Date.now();
      if (now - lastEmit.current < opts.throttleMs) return;
      lastEmit.current = now;
    }
    for (const h of handlersRef.current) {
      try { h.handler(ev); } catch (e) { console.error(`[ext:${h.extId}] onPlayback handler threw:`, e); }
    }
  }, []);
}

/** Register a player's controls with the host so extensions can drive it via gw.player. The latest
 *  control closures are always used (read through a ref); cleared on unmount. */
export function useRegisterPlayerControls(kind: "video" | "audio", controls: PlayerControlSet) {
  const { registerPlayerControls } = useExtensions();
  const ref = useRef(controls);
  ref.current = controls;
  useEffect(() => {
    registerPlayerControls(kind, {
      pause: () => ref.current.pause?.(),
      play: () => ref.current.play?.(),
      seek: (s) => ref.current.seek?.(s),
      pictureInPicture: () => ref.current.pictureInPicture?.(),
      current: () => ref.current.current?.() ?? null,
      castUrl: () => ref.current.castUrl?.() ?? Promise.resolve(null),
    });
    return () => registerPlayerControls(kind, null);
  }, [kind, registerPlayerControls]);
}

// ---- Subtitle provider slot ----

/** Convert SRT text to a WebVTT string (mirrors the Rust srt_to_vtt: strip BOM/CRs, WEBVTT header,
 *  comma→dot only on cue-timing lines so commas in dialogue survive). */
export function srtToVtt(srt: string): string {
  const body = srt.replace(/^﻿/, "").replace(/\r+/g, "");
  const out = body.split("\n").map((l) => (l.includes("-->") ? l.replace(/,(\d{3})/g, ".$1") : l));
  return "WEBVTT\n\n" + out.join("\n");
}

/** Run every enabled extension subtitle provider for the current media and return SubTracks
 *  (blob-URL VTT) to merge into the player's <track> list. Each provider is isolated; blob URLs are
 *  revoked on media change / unmount. Providers may return inline `content` or a plain-text `url`
 *  (downloaded via the extension's host-fetch). */
export function useExtSubtitles(query: SubtitleQuery | null): SubTrack[] {
  const { registry, gwById } = useExtensions();
  const providers = registry.subtitleProviders;
  const [tracks, setTracks] = useState<SubTrack[]>([]);
  const qKey = query ? `${query.title}|${query.season ?? ""}|${query.episode ?? ""}` : "";
  useEffect(() => {
    if (!query || providers.length === 0) { setTracks([]); return; }
    let alive = true;
    const urls: string[] = [];
    (async () => {
      const batches = await Promise.all(
        providers.map(async (p) => {
          try {
            const subs = await p.fetch(query);
            const out: SubTrack[] = [];
            for (const s of subs || []) {
              let text = s.content;
              if (text == null && s.url) {
                const r = await gwById.get(p.extId)?.fetch(s.url);
                if (!r?.ok) continue;
                text = await r.text();
              }
              if (text == null) continue;
              const vtt = s.format === "vtt" ? text : srtToVtt(text);
              const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
              urls.push(url);
              out.push({ label: `${s.label} · ${p.label}`, lang: s.lang || "", url });
            }
            return out;
          } catch (e) {
            console.error(`[ext] subtitle provider ${p.extId}:${p.id} failed:`, e);
            return [] as SubTrack[];
          }
        }),
      );
      if (alive) setTracks(batches.flat());
      else urls.forEach((u) => URL.revokeObjectURL(u));
    })();
    return () => { alive = false; urls.forEach((u) => URL.revokeObjectURL(u)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qKey, providers]);
  return tracks;
}

// A contributed render fn may call hooks (useState/useEffect). It MUST run inside its own component
// so those hooks are isolated — calling render(ctx) inline in a parent's map makes the extension's
// hooks part of the PARENT's hook list, which breaks the Rules of Hooks the moment the list changes.
function ExtRendered({ render, gw, ui }: { render: ExtRender; gw: ExtApi; ui: ExtUI }) {
  return <>{render({ React, ui, gw })}</>;
}
/** Render one extension contribution as its own isolated, error-bounded component. */
function ExtSlot({ extId, render, gw, ui }: { extId: string; render: ExtRender; gw: ExtApi; ui: ExtUI }) {
  return (
    <ExtBoundary extId={extId}>
      <ExtRendered render={render} gw={gw} ui={ui} />
    </ExtBoundary>
  );
}

/** Render an extension-contributed view by id (returns null if none matches). */
export function ExtensionView({ id }: { id: string }) {
  const { registry, gwById, ui } = useExtensions();
  const view = registry.views.find((v) => v.id === id);
  if (!view) return null;
  const gw = gwById.get(view.extId);
  if (!gw) return null;
  // Key by the view id so switching between extension views REMOUNTS (fresh hook scope) instead of
  // reusing one instance across render fns with different hook sequences.
  return <ExtSlot key={view.id} extId={view.extId} render={view.render} gw={gw} ui={ui} />;
}

/** Render an extension view's contextual sidebar content (its optional `sidebar` render), or null. */
export function ExtensionViewSidebar({ id }: { id: string }) {
  const { registry, gwById, ui } = useExtensions();
  const view = registry.views.find((v) => v.id === id);
  if (!view || !view.sidebar) return null;
  const gw = gwById.get(view.extId);
  if (!gw) return null;
  return <ExtSlot key={`${view.id}:sidebar`} extId={view.extId} render={view.sidebar} gw={gw} ui={ui} />;
}

/** Does the extension view `id` contribute a contextual sidebar? */
export function useExtViewHasSidebar(id: string): boolean {
  const { registry } = useExtensions();
  return registry.views.some((v) => v.id === id && !!v.sidebar);
}

/** Render all extension-contributed settings sections (used in the Extensions settings pane). */
export function ExtensionSettingsSections() {
  const { registry, gwById, ui } = useExtensions();
  if (registry.settingsSections.length === 0) return null;
  return (
    <>
      {registry.settingsSections.map((s) => {
        const gw = gwById.get(s.extId);
        if (!gw) return null;
        return <ExtSlot key={`${s.extId}:${s.id}`} extId={s.extId} render={s.render} gw={gw} ui={ui} />;
      })}
    </>
  );
}

/** Does this extension contribute any settings sections? (Gates the "Configure" affordance.) */
export function useHasExtSettings(extId: string): boolean {
  const { registry } = useExtensions();
  return registry.settingsSections.some((s) => s.extId === extId);
}

/** Render just one extension's settings sections (used inline in its manager card). */
export function ExtensionSettingsFor({ extId }: { extId: string }) {
  const { registry, gwById, ui } = useExtensions();
  const gw = gwById.get(extId);
  const sections = registry.settingsSections.filter((s) => s.extId === extId);
  if (!gw || sections.length === 0) return null;
  return (
    <>
      {sections.map((s) => (
        <ExtSlot key={`${s.extId}:${s.id}`} extId={s.extId} render={s.render} gw={gw} ui={ui} />
      ))}
    </>
  );
}

/** Render all extension-contributed Discover rows (Phase 3 slot). */
export function ExtensionDiscoverRows() {
  const { registry, gwById, ui } = useExtensions();
  return (
    <>
      {registry.discoverRows.map((r) => {
        const gw = gwById.get(r.extId);
        if (!gw) return null;
        return <ExtSlot key={`${r.extId}:${r.id}`} extId={r.extId} render={r.render} gw={gw} ui={ui} />;
      })}
    </>
  );
}

/** A crashing extension must never take down the app — isolate its render. */
class ExtBoundary extends React.Component<{ extId: string; children: React.ReactNode }, { failed: boolean }> {
  constructor(props: { extId: string; children: React.ReactNode }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error(`[ext:${this.props.extId}] render error:`, err);
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="empty">
          <div className="empty-inner">
            <h3>Extension error</h3>
            <p>“{this.props.extId}” hit a problem and was disabled for this view.</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
