import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as React from "react";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Toggle } from "@mattmattmattmatt/base/primitives/toggle/Toggle";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { IN_TAURI } from "../ipc/engine";
import { getSetting, setSetting } from "../ipc/library";
import {
  clock, plus, search, download, settings2, rss, calendar, captions, list, star, link2, x, check,
  airplay, tv, play, pause, globe, rotateCw, sparkles, gauge, users,
  music, disc3, heart, triangleAlert, listMusic, library, folderOpen, shuffle,
} from "../lib/icons";
import {
  emptyRegistry, type ExtApi, type ExtManifest, type ExtRegistry, type ExtUI, type PlaybackEvent, type PlaybackNow,
} from "./sdk";

/** What a player component registers so extensions can control it via gw.player. */
export type PlayerControlSet = {
  pause?: () => void;
  play?: () => void;
  seek?: (s: number) => void;
  pictureInPicture?: () => void;
  current?: () => PlaybackNow | null;
  castUrl?: () => Promise<string | null>;
};
type PlayerControlBank = { video?: PlayerControlSet | null; audio?: PlayerControlSet | null };

// The bundled reference extensions ride a ?raw import so they load in the browser preview AND act
// as the fallback when the backend ext_list is unavailable. In the desktop app the Rust backend
// (ext_list) is the source of truth. (Watch Later, Continue Watching, Theme & Accent, and Cast to TV
// were former extensions, now baked into the app natively.)
import prowlarrManifest from "../../extensions/prowlarr-bridge/extension.json";
import prowlarrSrc from "../../extensions/prowlarr-bridge/index.js?raw";
import rssManifest from "../../extensions/rss-auto/extension.json";
import rssSrc from "../../extensions/rss-auto/index.js?raw";
import subtitleManifest from "../../extensions/subtitle-fetcher/extension.json";
import subtitleSrc from "../../extensions/subtitle-fetcher/index.js?raw";
import traktManifest from "../../extensions/trakt-sync/extension.json";
import traktSrc from "../../extensions/trakt-sync/index.js?raw";
import pipManifest from "../../extensions/pip/extension.json";
import pipSrc from "../../extensions/pip/index.js?raw";
import sleepManifest from "../../extensions/sleep-timer/extension.json";
import sleepSrc from "../../extensions/sleep-timer/index.js?raw";
import translatorManifest from "../../extensions/subtitle-translator/extension.json";
import translatorSrc from "../../extensions/subtitle-translator/index.js?raw";
import anilistManifest from "../../extensions/anilist-sync/extension.json";
import anilistSrc from "../../extensions/anilist-sync/index.js?raw";
import discordManifest from "../../extensions/discord-presence/extension.json";
import discordSrc from "../../extensions/discord-presence/index.js?raw";
import spotiflacManifest from "../../extensions/spotiflac/extension.json";
import spotiflacSrc from "../../extensions/spotiflac/index.js?raw";
import spotimirrorManifest from "../../extensions/spotimirror/extension.json";
import spotimirrorSrc from "../../extensions/spotimirror/index.js?raw";
import seanceManifest from "../../extensions/seance/extension.json";
import seanceSrc from "../../extensions/seance/index.js?raw";

interface BuiltinExtension { manifest: ExtManifest; source: string }
const BUILTIN_EXTENSIONS: BuiltinExtension[] = [
  { manifest: prowlarrManifest as ExtManifest, source: prowlarrSrc },
  { manifest: rssManifest as ExtManifest, source: rssSrc },
  { manifest: subtitleManifest as ExtManifest, source: subtitleSrc },
  { manifest: traktManifest as ExtManifest, source: traktSrc },
  { manifest: pipManifest as ExtManifest, source: pipSrc },
  { manifest: sleepManifest as ExtManifest, source: sleepSrc },
  { manifest: translatorManifest as ExtManifest, source: translatorSrc },
  { manifest: anilistManifest as ExtManifest, source: anilistSrc },
  { manifest: discordManifest as ExtManifest, source: discordSrc },
  { manifest: spotiflacManifest as ExtManifest, source: spotiflacSrc },
  { manifest: spotimirrorManifest as ExtManifest, source: spotimirrorSrc },
  { manifest: seanceManifest as ExtManifest, source: seanceSrc },
];

/** The curated UI kit + icon set handed to every extension render function. */
const EXT_UI: ExtUI = {
  Button, Input, Toggle, Icon, Card, Chip,
  icons: {
    clock, plus, search, download, settings2, rss, calendar, captions, list, star, link2, x, check,
    airplay, tv, play, pause, globe, rotateCw, sparkles, gauge, users,
    music, disc3, heart, triangleAlert, listMusic, library, folderOpen, shuffle,
  },
};

const DISABLED_KEY = "ext:disabled";

/** One extension known to the host, for the manager UI. */
export interface ExtInfo {
  manifest: ExtManifest;
  enabled: boolean;
  source: "builtin" | "installed";
}

interface ExtHostValue {
  registry: ExtRegistry;
  gwById: Map<string, ExtApi>;
  ui: ExtUI;
  ready: boolean;
  extensions: ExtInfo[];
  setEnabled: (id: string, enabled: boolean) => void;
  /** Install an extension from a marketplace bundle URL (desktop only). */
  installFromUrl: (url: string) => Promise<void>;
  /** Remove an installed extension (builtins can't be removed). */
  removeExtension: (id: string) => Promise<void>;
  /** A player component registers its controls here so gw.player can drive it. */
  registerPlayerControls: (kind: "video" | "audio", controls: PlayerControlSet | null) => void;
}
const ExtContext = createContext<ExtHostValue>({
  registry: emptyRegistry(), gwById: new Map(), ui: EXT_UI, ready: false, extensions: [], setEnabled: () => {},
  installFromUrl: async () => {}, removeExtension: async () => {},
  registerPlayerControls: () => {},
});

export function useExtensions(): ExtHostValue {
  return useContext(ExtContext);
}

interface ExtensionProviderProps {
  children: ReactNode;
  onNavigate: (viewId: string) => void;
  onAddMagnet: (magnet: string) => void;
  onToast: (msg: string) => void;
  onSearch: (query: string) => void;
}

async function loadDisabled(): Promise<string[]> {
  try {
    const raw = IN_TAURI ? await getSetting(DISABLED_KEY) : localStorage.getItem(DISABLED_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function persistDisabled(ids: string[]) {
  const raw = JSON.stringify(ids);
  if (IN_TAURI) void setSetting(DISABLED_KEY, raw).catch(() => {});
  else { try { localStorage.setItem(DISABLED_KEY, raw); } catch { /* ignore */ } }
}

/** One extension resolved for loading: backend is the source of truth in Tauri, bundled set in preview. */
type LoadedExt = { id: string; manifest: ExtManifest; source: string; origin: "builtin" | "installed"; enabled: boolean };

/** Fetch the extension catalog. In Tauri the Rust `ext_list` is the source of truth (builtins +
 *  installed); in the browser preview we fall back to the bundled `?raw` set. Either way `enabled`
 *  is computed from the frontend's disabled mirror so optimistic toggles are instant + consistent. */
async function loadExtensions(disabled: string[]): Promise<LoadedExt[]> {
  if (IN_TAURI) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const rows = await invoke<LoadedExt[]>("ext_list");
      return rows.map((r) => ({ id: r.id, manifest: r.manifest, source: r.source, origin: r.origin, enabled: !disabled.includes(r.id) }));
    } catch (e) {
      console.error("[ext] ext_list failed; falling back to bundled builtins:", e);
    }
  }
  return BUILTIN_EXTENSIONS.map((e) => ({
    id: e.manifest.id, manifest: e.manifest, source: e.source, origin: "builtin" as const,
    enabled: !disabled.includes(e.manifest.id),
  }));
}

/** Load + activate ENABLED extensions, then expose their contributions + the manager list. */
export function ExtensionProvider({ children, onNavigate, onAddMagnet, onToast, onSearch }: ExtensionProviderProps) {
  const [registry, setRegistry] = useState<ExtRegistry>(emptyRegistry);
  const [ready, setReady] = useState(false);
  const [disabled, setDisabled] = useState<string[] | null>(null); // null = not loaded yet
  const gwById = useRef(new Map<string, ExtApi>());
  const handlers = useRef({ onNavigate, onAddMagnet, onToast, onSearch });
  handlers.current = { onNavigate, onAddMagnet, onToast, onSearch };
  // The active player(s) register their controls here so gw.player can drive them.
  const playerControls = useRef<PlayerControlBank>({});
  const registerPlayerControls = useCallback((kind: "video" | "audio", controls: PlayerControlSet | null) => {
    playerControls.current[kind] = controls;
  }, []);

  // The resolved extension catalog (backend in Tauri, bundled in preview) + a key to force re-fetch
  // after an install/remove.
  const [loaded, setLoaded] = useState<LoadedExt[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Load the disabled set once before activating anything.
  useEffect(() => { void loadDisabled().then(setDisabled); }, []);

  // (Re)fetch the catalog whenever the disabled set changes or an install/remove bumps reloadKey.
  const disabledKey = (disabled ?? []).slice().sort().join(",");
  useEffect(() => {
    if (disabled === null) return;
    let alive = true;
    void loadExtensions(disabled).then((l) => { if (alive) setLoaded(l); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabledKey, reloadKey, disabled === null]);

  // (Re)build the registry whenever the loaded catalog's enabled set changes.
  const loadedSig = (loaded ?? []).map((e) => `${e.id}:${e.enabled ? 1 : 0}:${e.origin}`).join(",");
  useEffect(() => {
    if (loaded === null) return;
    let cancelled = false;
    // Modules activated this pass — their deactivate() runs on rebuild/unmount so timers and
    // listeners (RSS poller, scrobblers) are torn down instead of leaking across toggles.
    const built: Array<{ id: string; deactivate?: () => void }> = [];
    (async () => {
      const reg = emptyRegistry();
      const map = new Map<string, ExtApi>();
      // Ids of every enabled extension — used to enforce manifest `requires`: an extension that
      // depends on another only activates when that dependency is enabled too.
      const enabledIds = new Set((loaded ?? []).filter((e) => e.enabled).map((e) => e.id));
      for (const ext of loaded) {
        if (!ext.enabled) continue;
        const missing = (ext.manifest.requires ?? []).filter((r) => !enabledIds.has(r));
        if (missing.length > 0) {
          console.warn(`[ext] ${ext.id} requires ${missing.join(", ")} — skipping activation (dependency disabled)`);
          continue;
        }
        try {
          const gw = await buildGw(ext.manifest, ext.origin, reg, handlers, playerControls);
          map.set(ext.id, gw);
          await registerPerms(ext.manifest);
          await startSidecarIfDeclared(ext.manifest);
          const mod = await importModule(ext.source);
          if (typeof mod.activate === "function") mod.activate(gw);
          built.push({ id: ext.id, deactivate: mod.deactivate });
        } catch (e) {
          console.error(`[ext] failed to activate ${ext.id}:`, e);
        }
      }
      if (cancelled) return;
      gwById.current = map;
      setRegistry(reg);
      setReady(true);
    })();
    return () => {
      cancelled = true;
      for (const m of built) {
        try { m.deactivate?.(); } catch (e) { console.error(`[ext] deactivate ${m.id} failed:`, e); }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedSig]);

  const setEnabled = useCallback((id: string, enabled: boolean) => {
    setDisabled((prev) => {
      const cur = prev ?? [];
      const next = enabled ? cur.filter((x) => x !== id) : Array.from(new Set([...cur, id]));
      persistDisabled(next);
      return next;
    });
  }, []);

  const installFromUrl = useCallback(async (url: string) => {
    if (!IN_TAURI) throw new Error("installing extensions requires the desktop app");
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ext_install_from_url", { url });
    setReloadKey((k) => k + 1);
  }, []);
  const removeExtension = useCallback(async (id: string) => {
    if (IN_TAURI) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("ext_remove", { id });
    }
    setReloadKey((k) => k + 1);
  }, []);

  const extensions = useMemo<ExtInfo[]>(
    () => (loaded ?? []).map((e) => ({ manifest: e.manifest, enabled: e.enabled, source: e.origin })),
    [loaded],
  );

  const value = useMemo<ExtHostValue>(
    () => ({ registry, gwById: gwById.current, ui: EXT_UI, ready, extensions, setEnabled, installFromUrl, removeExtension, registerPlayerControls }),
    [registry, ready, extensions, setEnabled, installFromUrl, removeExtension, registerPlayerControls],
  );
  return <ExtContext.Provider value={value}>{children}</ExtContext.Provider>;
}

/** Tell the Rust host which hosts this extension may reach (enforced by ext_fetch). Desktop only. */
async function registerPerms(manifest: ExtManifest): Promise<void> {
  if (!IN_TAURI) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ext_set_perms", { id: manifest.id, hosts: manifest.permissions?.network ?? [] });
  } catch (e) {
    console.error(`[ext] failed to register perms for ${manifest.id}:`, e);
  }
}

/** Start a native sidecar for an extension whose manifest declares one (resolves the bundled binary
 *  by name + spawns it; gw.invoke then proxies to it). Desktop only; best-effort. */
async function startSidecarIfDeclared(manifest: ExtManifest): Promise<void> {
  if (!IN_TAURI || manifest.backend?.type !== "sidecar" || !manifest.backend.binName) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ext_start_bundled_sidecar", { id: manifest.id, name: manifest.backend.binName });
  } catch (e) {
    console.error(`[ext] failed to start sidecar for ${manifest.id}:`, e);
  }
}

interface ExtModule { activate?: (gw: ExtApi) => void; deactivate?: () => void }

/** Import an extension's source string as an ES module via a blob URL (no bundler at runtime). */
async function importModule(source: string): Promise<ExtModule> {
  const blob = new Blob([source], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return (await import(/* @vite-ignore */ url)) as ExtModule;
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Handlers = React.MutableRefObject<{ onNavigate: (v: string) => void; onAddMagnet: (m: string) => void; onToast: (m: string) => void; onSearch: (q: string) => void }>;
type PlayerControlsRef = React.MutableRefObject<PlayerControlBank>;

/** Build the per-extension `gw` API: storage, registration (into `reg`), and app bridges. */
async function buildGw(manifest: ExtManifest, origin: "builtin" | "installed", reg: ExtRegistry, handlers: Handlers, playerControls: PlayerControlsRef): Promise<ExtApi> {
  const id = manifest.id;
  const storeKey = `ext:${id}:store`;
  let blob: Record<string, unknown> = {};
  try {
    const raw = IN_TAURI ? await getSetting(storeKey) : localStorage.getItem(storeKey);
    if (raw) blob = JSON.parse(raw);
  } catch { /* fresh */ }

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const raw = JSON.stringify(blob);
      if (IN_TAURI) void setSetting(storeKey, raw).catch(() => {});
      else { try { localStorage.setItem(storeKey, raw); } catch { /* ignore */ } }
    }, 200);
  };

  return {
    id,
    version: manifest.version,
    storage: {
      get<T>(key: string, def: T): T { const v = blob[key]; return v === undefined ? def : (v as T); },
      set(key: string, val: unknown) { blob[key] = val; persist(); },
    },
    registerNav: (entry) => reg.nav.push({ ...entry, extId: id }),
    registerView: (view) => reg.views.push({ ...view, extId: id }),
    registerCommand: (cmd) => reg.commands.push({ ...cmd, extId: id }),
    registerSettingsSection: (section) => reg.settingsSections.push({ ...section, extId: id }),
    registerSearchSource: (source) => reg.searchSources.push({ ...source, extId: id }),
    registerDiscoverRow: (row) => reg.discoverRows.push({ ...row, extId: id }),
    registerSubtitleProvider: (provider) => reg.subtitleProviders.push({ ...provider, extId: id }),
    registerMusicImporter: (importer) => reg.musicImporters.push({ ...importer, extId: id }),
    onPlayback: (handler: (ev: PlaybackEvent) => void) => reg.playbackHandlers.push({ handler, extId: id }),
    navigate: (viewId) => handlers.current.onNavigate(viewId),
    search: (query) => handlers.current.onSearch(query),
    player: {
      pause: () => { const b = playerControls.current; (b.video?.pause ?? b.audio?.pause)?.(); },
      play: () => { const b = playerControls.current; (b.video?.play ?? b.audio?.play)?.(); },
      seek: (s) => playerControls.current.video?.seek?.(s),
      pictureInPicture: () => playerControls.current.video?.pictureInPicture?.(),
      current: () => playerControls.current.video?.current?.() ?? playerControls.current.audio?.current?.() ?? null,
      castUrl: () => playerControls.current.video?.castUrl?.() ?? Promise.resolve(null),
    },
    downloads: { add: (magnet) => handlers.current.onAddMagnet(magnet) },
    toast: (msg) => handlers.current.onToast(msg),
    // Permissioned host-fetch — the request is made server-side via the app, gated by the
    // manifest's network allowlist (registered as the extension activates).
    fetch: async (url, opts) => {
      if (!IN_TAURI) throw new Error("host-fetch is only available in the desktop app");
      const { invoke } = await import("@tauri-apps/api/core");
      const r = await invoke<{ ok: boolean; status: number; body: string; base64: boolean }>("ext_fetch", {
        id,
        req: { url, method: opts?.method, headers: opts?.headers, body: opts?.body, binary: opts?.binary },
      });
      const bytes = async (): Promise<Uint8Array> => {
        if (r.base64) {
          const bin = atob(r.body);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        }
        return new TextEncoder().encode(r.body);
      };
      const text = async (): Promise<string> =>
        r.base64 ? new TextDecoder().decode(await bytes()) : r.body;
      return { ok: r.ok, status: r.status, bytes, text, json: async <T = unknown>() => JSON.parse(await text()) as T };
    },
    // Native sidecar backends are proxied via ext_invoke (the sidecar manager).
    invoke: async <T = unknown>(route: string, payload?: unknown): Promise<T> => {
      if (!IN_TAURI) throw new Error("extension backends are only available in the desktop app");
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<T>("ext_invoke", { id, route, payload });
    },
    // Built-in (first-party) extensions may call in-process native commands + subscribe to app
    // events directly — they ship compiled into the app, so they're as trusted as it is. Installed /
    // marketplace extensions are denied (they only get the sandboxed host-fetch + sidecar paths).
    native: async <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (origin !== "builtin") throw new Error("native commands are restricted to built-in extensions");
      if (!IN_TAURI) throw new Error("native commands are only available in the desktop app");
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<T>(command, args ?? {});
    },
    events: {
      on: async (event: string, handler: (payload: unknown) => void): Promise<() => void> => {
        if (origin !== "builtin") throw new Error("native events are restricted to built-in extensions");
        if (!IN_TAURI) return () => {};
        const { listen } = await import("@tauri-apps/api/event");
        return listen(event, (e) => handler(e.payload));
      },
    },
    log: (...args) => console.log(`[ext:${id}]`, ...args),
  };
}
