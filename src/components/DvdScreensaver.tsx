import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { ghost, music as musicIcon } from "../lib/icons";
import { usePlayer } from "../ipc/player";
import { MusicVisualizer, analyserSampler, useVizMode } from "./MusicVisualizer";
import { hueFromString } from "../lib/catalog";
import "./DvdScreensaver.css";

// The bounce cycles through a playful set led by the ghostly accent (teal/seafoam), then a few
// bright complements — classic DVD-screensaver energy, on-brand.
const COLORS = ["#2dcdd6", "#6ee7d7", "#a78bfa", "#f472b6", "#fbbf24", "#34d399", "#60a5fa", "#f87171"];

// Feed the embedded visualizer the ghostly accent (it reads these CSS vars off the canvas).
const VIZ_VARS = { "--viz-accent": "#2dcdd6", "--viz-accent-2": "#6ee7d7" } as CSSProperties;

// How long the chromatic-aberration / screen-glitch burst lasts after an edge bounce (ms).
const GLITCH_MS = 340;

/**
 * Returns true once `enabled` and the user has been idle (no mouse/key/scroll/touch) for `timeoutMs`.
 * Resets on any interaction. Avoids per-event re-renders by only flipping state on a real transition.
 */
export function useIdle(timeoutMs: number, enabled: boolean): boolean {
  const [idle, setIdle] = useState(false);
  const idleRef = useRef(false);
  useEffect(() => {
    if (!enabled) {
      idleRef.current = false;
      setIdle(false);
      return;
    }
    let timer = 0;
    const goIdle = () => { idleRef.current = true; setIdle(true); };
    const reset = () => {
      if (idleRef.current) { idleRef.current = false; setIdle(false); }
      window.clearTimeout(timer);
      timer = window.setTimeout(goIdle, timeoutMs);
    };
    const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [timeoutMs, enabled]);
  return idle;
}

/** Full-screen DVD-style bouncing screensaver. The element travels in a straight line, reflects off
 *  every edge, advances to the next colour on each bounce (with a matching glow), and fires a brief
 *  chromatic-aberration + screen-glitch burst on every edge hit.
 *
 *  When a track is loaded it bounces a live "now playing" card — album art, a music visualizer fed
 *  by the shared analyser, and the title/artist — instead of the plain GhostWire logo. */
export function DvdScreensaver() {
  const player = usePlayer();
  const track = player.current;
  const nowPlaying = !!track;

  const wrapRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const blurRef = useRef<HTMLDivElement>(null);
  const glitchTimerRef = useRef(0);
  const [color, setColor] = useState(COLORS[0]);
  const [artError, setArtError] = useState(false);

  // Reset the art-error guard whenever the track changes so a new cover always gets a fresh try.
  useEffect(() => { setArtError(false); }, [track?.id, track?.art]);

  // Live visualizer wiring (reused from the now-playing hero): a sampler over the shared
  // analyser + the user's last-picked visualizer mode.
  const sampler = useMemo(() => analyserSampler(player.analyser), [player.analyser]);
  const [vizMode] = useVizMode();

  // Bounce loop. Re-measures when switching between the compact logo and the larger now-playing
  // card (their dimensions differ), so reflections stay flush to the screen edges.
  useEffect(() => {
    const wrap = wrapRef.current;
    const logo = logoRef.current;
    if (!wrap || !logo) return;

    const blur = blurRef.current;
    const lw = logo.offsetWidth || 180;
    const lh = logo.offsetHeight || 130;
    let W = wrap.clientWidth;
    let H = wrap.clientHeight;
    // Random start + direction so it doesn't begin from the same spot/corner each time.
    let x = Math.random() * Math.max(1, W - lw);
    let y = Math.random() * Math.max(1, H - lh);

    // Size the "de-frost spotlight" to the bouncing element and seed its centre so it doesn't
    // begin in the middle of the screen on the first frame.
    const spotR = Math.round(Math.max(lw, lh) * 0.9 + 110);
    const moveSpot = () => {
      if (!blur) return;
      blur.style.setProperty("--spot-x", `${x + lw / 2}px`);
      blur.style.setProperty("--spot-y", `${y + lh / 2}px`);
    };
    if (blur) blur.style.setProperty("--spot-r", `${spotR}px`);
    moveSpot();
    const speed = 1.7; // px/frame ≈ 100px/s at 60fps — the classic slow drift
    let vx = (Math.random() < 0.5 ? -1 : 1) * speed;
    let vy = (Math.random() < 0.5 ? -1 : 1) * speed;
    let colorIdx = 0;
    let raf = 0;

    // Restart the glitch burst from frame 0 each bounce (remove → reflow → add).
    const fireGlitch = () => {
      wrap.classList.remove("dvd-glitching");
      void wrap.offsetWidth; // force reflow so the CSS animations replay
      wrap.classList.add("dvd-glitching");
      window.clearTimeout(glitchTimerRef.current);
      glitchTimerRef.current = window.setTimeout(() => wrap.classList.remove("dvd-glitching"), GLITCH_MS);
    };

    const step = () => {
      W = wrap.clientWidth;
      H = wrap.clientHeight;
      x += vx;
      y += vy;
      let hit = false;
      if (x <= 0) { x = 0; vx = Math.abs(vx); hit = true; }
      else if (x + lw >= W) { x = W - lw; vx = -Math.abs(vx); hit = true; }
      if (y <= 0) { y = 0; vy = Math.abs(vy); hit = true; }
      else if (y + lh >= H) { y = H - lh; vy = -Math.abs(vy); hit = true; }
      if (hit) {
        colorIdx = (colorIdx + 1) % COLORS.length;
        setColor(COLORS[colorIdx]);
        fireGlitch();
      }
      logo.style.transform = `translate(${x}px, ${y}px)`;
      moveSpot(); // keep the de-frost spotlight centred on the bouncing element
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(glitchTimerRef.current);
      wrap.classList.remove("dvd-glitching");
    };
  }, [nowPlaying]);

  const hue = hueFromString(track?.title || track?.album || "ghostwire");
  const artBg = `linear-gradient(150deg, hsl(${hue} 38% 30%), hsl(${(hue + 40) % 360} 46% 16%))`;
  const showArt = nowPlaying && !!track?.art && !artError;

  return (
    // Any interaction is caught by useIdle's window listeners, which flips idle→false and unmounts
    // this — so the first click/move just dismisses (it never falls through to the app beneath).
    // The glow/colour ride `color` (currentColor); the base glow + glitch live in CSS.
    <div ref={wrapRef} className="dvd-saver" role="presentation" aria-hidden style={VIZ_VARS}>
      {/* Frosted layer, behind the bouncing element. A moving radial mask thins its coverage
          around the logo so the app reads sharper there — a "de-frost spotlight" that follows. */}
      <div ref={blurRef} className="dvd-blur" />
      <div className="dvd-stage">
        {nowPlaying ? (
          <div ref={logoRef} className="dvd-np" style={{ color }}>
            <div className="dvd-np-art" style={showArt ? undefined : { background: artBg }}>
              {showArt
                ? <img src={track!.art} alt="" onError={() => setArtError(true)} />
                : <Icon icon={musicIcon} size="2xl" />}
            </div>
            <MusicVisualizer sampler={sampler} active={player.isPlaying} mode={vizMode} className="dvd-np-viz" />
            <div className="dvd-np-meta">
              <div className="dvd-np-title" title={track!.title}>{track!.title}</div>
              {track!.artist && <div className="dvd-np-artist" title={track!.artist}>{track!.artist}</div>}
            </div>
          </div>
        ) : (
          <div ref={logoRef} className="dvd-logo" style={{ color }}>
            <Icon icon={ghost} size="2xl" />
            <span className="dvd-wordmark">GhostWire<span className="dvd-tld">.TV</span></span>
          </div>
        )}
      </div>
      {/* Screen-glitch overlay: scanlines + colour tear bands that flash on each bounce. */}
      <div className="dvd-glitch-fx" aria-hidden />
    </div>
  );
}
