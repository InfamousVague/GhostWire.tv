// The GhostWire extension SDK — the contract between the app and an extension.
//
// An extension is a single self-contained ES module that exports `activate(gw)`. It never imports
// React or the app's UI kit directly (it can't — it's loaded at runtime with no bundler); instead,
// any UI it contributes is a `render` function that receives the app's React + a curated UI kit +
// the `gw` API. That sidesteps duplicate-React / import-map problems entirely and keeps extensions
// to one dependency-free file.

import type { ReactNode } from "react";

/** Everything a contributed render function is handed: the app's React, a curated Base UI kit, gw. */
export interface ExtRenderCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  React: any;
  ui: ExtUI;
  gw: ExtApi;
}
export type ExtRender = (ctx: ExtRenderCtx) => ReactNode;

/** The Base components + icon set exposed to extension UIs so they look native. */
export interface ExtUI {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Button: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Input: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Toggle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Icon: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Card: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Chip: any;
  /** Named icon SVG strings from the app's icon set (src/lib/icons). */
  icons: Record<string, string>;
}

export interface ExtView {
  /** Must match a registered nav entry id to be reachable from the rail. */
  id: string;
  render: ExtRender;
  /** Optional content rendered into the app's contextual sidebar while this view is active. */
  sidebar?: ExtRender;
}
export interface ExtNavEntry {
  id: string;
  label: string;
  /** Icon name from the app icon set (ui.icons), e.g. "clock". */
  icon?: string;
}
export interface ExtCommand {
  id: string;
  label: string;
  group?: string;
  /** Icon name from the app icon set. */
  icon?: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}
export interface ExtSettingsSection {
  id: string;
  label: string;
  icon?: string;
  render: ExtRender;
}
/** A Discover row contributed into the Search/Discover page (Phase 3). */
export interface ExtDiscoverRow {
  id: string;
  title: string;
  render: ExtRender;
}

/** One result an extension search source returns. Magnet is required (it's the natural key); the
 *  host derives the infohash id + fills sensible defaults for anything omitted. */
export interface ExtSearchResult {
  title: string;
  magnet: string;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  category?: "video" | "audio" | "software" | "books" | "data" | "other";
  poster?: string;
  year?: number;
  description?: string;
}
/** A search source contributed by an extension — its hits are merged into the app's search results,
 *  tagged with `label` so they appear under the "by source" filter. */
export interface ExtSearchSource {
  id: string;
  label: string;
  search: (query: string) => Promise<ExtSearchResult[]> | ExtSearchResult[];
}

/** Playback lifecycle an extension can subscribe to (scrobblers, "continue watching", etc). */
export interface PlaybackEvent {
  kind: "video" | "audio";
  /** What happened: started/resumed, paused, or finished. Progress ticks arrive as "playing". */
  state: "playing" | "paused" | "ended";
  /** Stable-ish id for the media (the player's title, slugged) — handlers should also use the rich fields. */
  id: string;
  title: string;
  position?: number; // seconds into the media
  duration?: number; // total seconds (0/undefined until known)
  progress?: number; // 0–100 percent watched (convenience for scrobblers)
  // Rich context so a scrobbler can resolve the exact movie/episode:
  show?: string;
  season?: number;
  episode?: number;
  year?: number;
  // Music context (kind === "audio") so a presence/scrobbler can show "Listening to … by …".
  artist?: string;
  album?: string;
}

/** A subtitle track an extension subtitle provider returns. Either inline `content` (SRT/VTT text,
 *  converted + served by the host as a track) or a direct `url` to a VTT/SRT file. */
export interface ExtSubtitleResult {
  label: string;
  /** BCP-47 / ISO language (e.g. "en", "eng", "es"). */
  lang: string;
  format?: "srt" | "vtt";
  content?: string;
  url?: string;
}
/** The media identity handed to a subtitle provider so it can search for a match. */
export interface SubtitleQuery {
  title: string;
  season?: number | null;
  episode?: number | null;
  year?: number | null;
  /** Original release/file name when available (helps hash/name matching). */
  release?: string | null;
}
/** A subtitle source contributed by an extension (e.g. OpenSubtitles, Addic7ed). Its results appear
 *  in the player's CC menu alongside the built-in tracks. */
export interface ExtSubtitleProvider {
  id: string;
  label: string;
  fetch: (query: SubtitleQuery) => Promise<ExtSubtitleResult[]> | ExtSubtitleResult[];
}

/** A music-link importer contributed by an extension (e.g. SpotiFLAC). The app routes pasted
 *  music-service links (Spotify/Tidal/Apple Music/Deezer/…) to the first enabled importer; when none
 *  is registered (the providing extension is disabled) the app's import affordances are disabled too. */
export interface ExtMusicImporter {
  id: string;
  label: string;
  /** True when this importer recognizes a pasted link. */
  handles(url: string): boolean;
  /** Queue a link (playlist/album/artist/track) for background import. */
  enqueue(url: string): Promise<void>;
}

/** The extension manifest (extension.json). */
export interface ExtManifest {
  id: string;
  name: string;
  version: string;
  /** Other extension ids this one depends on — it only activates when they're all enabled. */
  requires?: string[];
  author?: string;
  description?: string;
  icon?: string;
  permissions?: {
    network?: string[];
    app?: Array<"search" | "downloads" | "player" | "library" | "discover" | "settings">;
    storage?: boolean;
  };
  contributes?: Record<string, unknown>;
  frontend?: string;
  /** `binName` is the bundled sidecar binary (resolved next to the app); the host starts it on
   *  activation and proxies gw.invoke() to it. */
  backend?: { type: "js" | "sidecar"; entry?: string; binName?: string; bin?: Record<string, string> };
  /** Discovery/marketplace metadata for the browse page (category slug + card copy). */
  discovery?: { category?: ExtCategory; tagline?: string; featured?: boolean };
}

/** Browse categories for the Extensions discovery page (lowercase slugs are the stable keys). */
export type ExtCategory = "sources" | "subtitles" | "player" | "sync" | "social" | "appearance";

/** What the player is currently doing — returned by gw.player.current(). */
export interface PlaybackNow {
  kind: "video" | "audio";
  id: string;
  title: string;
  position: number;
  duration: number;
  playing: boolean;
}

/** The `gw` object an extension's `activate(gw)` receives. */
export interface ExtApi {
  id: string;
  version: string;
  /** Synchronous KV (loaded before activate, persisted async + namespaced per extension). */
  storage: {
    get<T>(key: string, def: T): T;
    set(key: string, val: unknown): void;
  };
  registerNav(entry: ExtNavEntry): void;
  registerView(view: ExtView): void;
  registerCommand(cmd: ExtCommand): void;
  registerSettingsSection(section: ExtSettingsSection): void;
  /** Contribute a search source — its results merge into the app's global search. */
  registerSearchSource(source: ExtSearchSource): void;
  /** Contribute a Discover row (rendered on the Discover home). */
  registerDiscoverRow(row: ExtDiscoverRow): void;
  /** Contribute a subtitle provider — its tracks appear in the player's CC menu. */
  registerSubtitleProvider(provider: ExtSubtitleProvider): void;
  /** Contribute a music-link importer (Spotify/Tidal/… → the background download queue). */
  registerMusicImporter(importer: ExtMusicImporter): void;
  /** Subscribe to player lifecycle (play/pause/progress/ended) — for scrobblers + continue-watching. */
  onPlayback(handler: (ev: PlaybackEvent) => void): void;
  /** Navigate to a contributed view (or any app view id). */
  navigate(viewId: string): void;
  /** Run a global search (jumps to Discover and searches the app's sources). */
  search(query: string): void;
  /** Control the active player (video or audio). No-ops when nothing is playing. */
  player: {
    pause(): void;
    play(): void;
    /** Seek the video to an absolute position in seconds. */
    seek(seconds: number): void;
    /** Pop the video into a floating Picture-in-Picture window. */
    pictureInPicture(): void;
    /** What's playing right now, or null. */
    current(): PlaybackNow | null;
    /** A LAN-reachable URL (with a stream token) for the current video, for casting. Null if none. */
    castUrl(): Promise<string | null>;
  };
  /** Queue a magnet/torrent into the library (existing app download flow). */
  downloads: { add(magnet: string): void };
  /** Transient status toast. */
  toast(msg: string): void;
  /** Call this extension's native sidecar backend: ext_invoke(id, route, payload). */
  invoke<T = unknown>(route: string, payload?: unknown): Promise<T>;
  /** Built-in extensions only: call an in-process native (Tauri) command directly. First-party
   *  builtins ship compiled into the app, so they're as trusted as it is; this throws for
   *  installed / marketplace extensions (they get host-fetch + the sidecar path instead). */
  native<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Built-in extensions only: subscribe to a native app event (Tauri event); returns an
   *  unsubscribe fn. Throws for installed / marketplace extensions. */
  events: { on(event: string, handler: (payload: unknown) => void): Promise<() => void> };
  /** Permissioned host-fetch: a request made server-side via the app, gated by the manifest's
   *  network allowlist (no CORS, the app's IP/VPN). Only http(s) hosts the manifest declared. */
  fetch(url: string, opts?: ExtFetchOpts): Promise<ExtFetchResult>;
  log(...args: unknown[]): void;
}

export interface ExtFetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Request the raw bytes (for binary payloads: gzipped subtitles, images). Use `.bytes()`. */
  binary?: boolean;
}
/** The result of a permissioned host-fetch (a slimmed Response). */
export interface ExtFetchResult {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  /** Raw response bytes (decoded from the host's base64 when `binary` was requested). */
  bytes(): Promise<Uint8Array>;
}

/** A contribution tagged with the extension that registered it. */
export type Tagged<T> = T & { extId: string };

/** The app-wide registry the host accumulates as extensions activate. */
export interface ExtRegistry {
  nav: Tagged<ExtNavEntry>[];
  views: Tagged<ExtView>[];
  commands: Tagged<ExtCommand>[];
  settingsSections: Tagged<ExtSettingsSection>[];
  searchSources: Tagged<ExtSearchSource>[];
  discoverRows: Tagged<ExtDiscoverRow>[];
  subtitleProviders: Tagged<ExtSubtitleProvider>[];
  musicImporters: Tagged<ExtMusicImporter>[];
  playbackHandlers: Tagged<{ handler: (ev: PlaybackEvent) => void }>[];
}

export const emptyRegistry = (): ExtRegistry => ({
  nav: [],
  views: [],
  commands: [],
  settingsSections: [],
  searchSources: [],
  discoverRows: [],
  subtitleProviders: [],
  musicImporters: [],
  playbackHandlers: [],
});
