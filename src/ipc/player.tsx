import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** A playable audio track for the global player/queue. */
export interface PlayerTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  url: string;
  art?: string;
}

export type RepeatMode = "off" | "all" | "one";

interface PlayerApi {
  current: PlayerTrack | null;
  queue: PlayerTrack[];
  index: number;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  currentTime: number;
  duration: number;
  /** Furthest buffered position in seconds (for the seek-bar overlay). */
  buffered: number;
  /** The shared AnalyserNode for the visualizer (created once playback starts). */
  analyser: AnalyserNode | null;
  play: (tracks: PlayerTrack[], index?: number) => void;
  toggle: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  seek: (t: number) => void;
  setVolume: (v: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  stop: () => void;
}

const Ctx = createContext<PlayerApi | null>(null);

export function usePlayer(): PlayerApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePlayer must be used within <PlayerProvider>");
  return c;
}

// FLAC (and OGG/Opus) play SILENT through WebKit's Web Audio graph — once an
// <audio> is wired to a MediaElementAudioSourceNode, WebKit decodes FLAC to silence
// (bug 198583 + createMediaElementSource quirks) even though a plain element plays it.
// So only these formats go through the analyser; the rest play on a plain element.
const GRAPH_OK = /\.(mp3|m4a|m4b|aac|mp4|mov|wav|aiff?|caf)(\?|#|$)/i;
const graphOk = (url?: string | null) => !!url && GRAPH_OK.test(url);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const plainRef = useRef<HTMLAudioElement | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<MediaElementAudioSourceNode | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [volume, setVol] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);

  const current = queue[index] ?? null;

  // The element that should be playing the current track (graph element for
  // visualizer-friendly formats, plain element for FLAC/OGG/Opus), and the other.
  const elFor = (url?: string | null) => (graphOk(url) ? audioRef.current : plainRef.current);
  const idleFor = (url?: string | null) => (graphOk(url) ? plainRef.current : audioRef.current);

  // Build the Web Audio graph once, lazily — must happen inside a user gesture so
  // WKWebView's autoplay policy lets the AudioContext run. createMediaElementSource
  // is once-per-element, so we guard it and reuse the node forever after.
  const ensureGraph = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!acRef.current) {
      const AC: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ac = new AC();
      acRef.current = ac;
      try {
        const src = ac.createMediaElementSource(el);
        const an = ac.createAnalyser();
        an.fftSize = 2048;
        an.smoothingTimeConstant = 0.82;
        src.connect(an);
        an.connect(ac.destination);
        srcRef.current = src;
        setAnalyser(an);
      } catch {
        /* already created for this element — fine */
      }
    }
    if (acRef.current && acRef.current.state === "suspended") void acRef.current.resume();
  }, []);

  const play = useCallback(
    (tracks: PlayerTrack[], start = 0) => {
      if (tracks.length === 0) return;
      ensureGraph();
      setQueue(tracks);
      setIndex(Math.max(0, Math.min(start, tracks.length - 1)));
    },
    [ensureGraph],
  );

  const stop = useCallback(() => {
    for (const el of [audioRef.current, plainRef.current]) {
      if (el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
    }
    setQueue([]);
    setIndex(0);
    setIsPlaying(false);
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    plainRef.current?.pause();
  }, []);

  const toggle = useCallback(() => {
    if (!current) return;
    const el = elFor(current.url);
    if (!el) return;
    if (graphOk(current.url)) ensureGraph();
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, ensureGraph]);

  const next = useCallback(() => {
    setIndex((i) => {
      if (queue.length === 0) return i;
      if (shuffle) return Math.floor(Math.random() * queue.length);
      if (i + 1 < queue.length) return i + 1;
      return repeat === "all" ? 0 : i;
    });
  }, [queue.length, shuffle, repeat]);

  const prev = useCallback(() => {
    const el = elFor(current?.url);
    // Mirror iTunes/Spotify: >3s in, restart the track; otherwise go to previous.
    if (el && el.currentTime > 3) {
      el.currentTime = 0;
      return;
    }
    setIndex((i) => (i > 0 ? i - 1 : repeat === "all" ? queue.length - 1 : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.length, repeat, current]);

  const seek = useCallback((t: number) => {
    const el = elFor(current?.url);
    if (el && Number.isFinite(t)) el.currentTime = t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const setVolume = useCallback((v: number) => {
    const vol = Math.max(0, Math.min(1, v));
    setVol(vol);
    if (audioRef.current) audioRef.current.volume = vol;
    if (plainRef.current) plainRef.current.volume = vol;
  }, []);

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);
  const cycleRepeat = useCallback(
    () => setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off")),
    [],
  );

  // Load + play whenever the current track changes — onto the element that suits
  // its format, pausing the other so two tracks never play at once.
  useEffect(() => {
    if (!current) return;
    const el = elFor(current.url);
    idleFor(current.url)?.pause();
    if (!el) return;
    if (graphOk(current.url)) ensureGraph();
    if (!el.src.endsWith(encodeURI(current.url)) && el.src !== current.url) {
      el.src = current.url;
    }
    el.volume = volume;
    void el.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Wire transport events on BOTH audio elements (graph + plain) so the controls
  // work whichever one is playing the current track.
  useEffect(() => {
    const els = [audioRef.current, plainRef.current].filter(Boolean) as HTMLAudioElement[];
    const cleanups: Array<() => void> = [];
    for (const el of els) {
      const onTime = () => setCurrentTime(el.currentTime);
      const onDur = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0);
      const onPlay = () => setIsPlaying(true);
      const onPause = () => setIsPlaying(false);
      const onProgress = () => {
        try {
          const b = el.buffered;
          setBuffered(b.length ? b.end(b.length - 1) : 0);
        } catch {
          /* ignore */
        }
      };
      const onEnded = () => {
        if (repeat === "one") {
          el.currentTime = 0;
          void el.play().catch(() => {});
          return;
        }
        setIndex((i) => {
          if (shuffle && queue.length > 1) return Math.floor(Math.random() * queue.length);
          if (i + 1 < queue.length) return i + 1;
          if (repeat === "all") return 0;
          setIsPlaying(false);
          return i;
        });
      };
      el.addEventListener("timeupdate", onTime);
      el.addEventListener("durationchange", onDur);
      el.addEventListener("play", onPlay);
      el.addEventListener("pause", onPause);
      el.addEventListener("progress", onProgress);
      el.addEventListener("ended", onEnded);
      cleanups.push(() => {
        el.removeEventListener("timeupdate", onTime);
        el.removeEventListener("durationchange", onDur);
        el.removeEventListener("play", onPlay);
        el.removeEventListener("pause", onPause);
        el.removeEventListener("progress", onProgress);
        el.removeEventListener("ended", onEnded);
      });
    }
    return () => cleanups.forEach((c) => c());
  }, [repeat, shuffle, queue.length]);

  // macOS media keys / Now Playing via the Media Session API (feature-detected;
  // may not reach an embedded WKWebView — harmless if it doesn't).
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    if (current) {
      try {
        ms.metadata = new MediaMetadata({
          title: current.title,
          artist: current.artist ?? "",
          album: current.album ?? "",
          artwork: current.art ? [{ src: current.art, sizes: "512x512" }] : [],
        });
      } catch {
        /* ignore */
      }
    }
    const set = (a: MediaSessionAction, h: (() => void) | null) => {
      try {
        ms.setActionHandler(a, h as MediaSessionActionHandler | null);
      } catch {
        /* unsupported action — ignore */
      }
    };
    set("play", () => toggle());
    set("pause", () => toggle());
    set("previoustrack", () => prev());
    set("nexttrack", () => next());
    set("seekto", null);
    return () => {
      (["play", "pause", "previoustrack", "nexttrack"] as MediaSessionAction[]).forEach((a) => set(a, null));
    };
  }, [current, toggle, next, prev]);

  // Keep the OS scrubber position in sync.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!duration) return;
    try {
      navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: Math.min(currentTime, duration) });
    } catch {
      /* ignore */
    }
  }, [currentTime, duration]);

  const api: PlayerApi = {
    current, queue, index, isPlaying, shuffle, repeat, volume, currentTime, duration, buffered, analyser,
    play, toggle, pause, next, prev, seek, setVolume, toggleShuffle, cycleRepeat, stop,
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* Two persistent audio elements (never unmount → playback survives navigation):
          the graph element (visualizer) for Web-Audio-friendly formats, and a plain
          one that bypasses the analyser so FLAC/OGG/Opus actually play in WebKit. */}
      <audio ref={audioRef} crossOrigin="anonymous" preload="auto" />
      <audio ref={plainRef} preload="auto" />
    </Ctx.Provider>
  );
}
