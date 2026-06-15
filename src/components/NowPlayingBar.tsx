import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { usePlayer } from "../ipc/player";
import { Visualizer } from "./Visualizer";
import { hueFromString } from "../lib/catalog";
import { music, pause, play, repeat, repeat1, shuffle, skipBack, skipForward, volume2, volumeX, x } from "../lib/icons";
import "./NowPlayingBar.css";

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function NowPlayingBar() {
  const p = usePlayer();
  if (!p.current) return null;
  const t = p.current;
  const hue = hueFromString(t.title);
  const artBg = `linear-gradient(150deg, hsl(${hue} 32% 28%), hsl(${(hue + 40) % 360} 42% 16%))`;
  const repeatIcon = p.repeat === "one" ? repeat1 : repeat;

  return (
    <div className="npbar npbar-dock">
      <Visualizer analyser={p.analyser} active={p.isPlaying} className="npbar-viz" />

      <div className="npbar-top">
        <div className="npbar-track">
          <div className="npbar-art" style={t.art ? undefined : { background: artBg }}>
            {t.art ? <img src={t.art} alt="" /> : <Icon icon={music} size="sm" />}
          </div>
          <div className="npbar-meta">
            <div className="npbar-title" title={t.title}>{t.title}</div>
            {t.artist && <div className="npbar-artist" title={t.artist}>{t.artist}</div>}
          </div>
        </div>

        <div className="npbar-controls">
          <button className={`np-btn${p.shuffle ? " on" : ""}`} title="Shuffle" aria-label="Shuffle" onClick={p.toggleShuffle}>
            <Icon icon={shuffle} size="sm" />
          </button>
          <button className="np-btn" title="Previous" aria-label="Previous" onClick={p.prev}>
            <Icon icon={skipBack} size="sm" />
          </button>
          <button className="np-btn np-play" title={p.isPlaying ? "Pause" : "Play"} aria-label={p.isPlaying ? "Pause" : "Play"} onClick={p.toggle}>
            <Icon icon={p.isPlaying ? pause : play} size="base" />
          </button>
          <button className="np-btn" title="Next" aria-label="Next" onClick={p.next}>
            <Icon icon={skipForward} size="sm" />
          </button>
          <button className={`np-btn${p.repeat !== "off" ? " on" : ""}`} title={`Repeat: ${p.repeat}`} aria-label="Repeat" onClick={p.cycleRepeat}>
            <Icon icon={repeatIcon} size="sm" />
          </button>
        </div>

        <div className="npbar-right">
          <Volume value={p.volume} onChange={p.setVolume} />
          <button className="np-btn np-close" title="Close player" aria-label="Close player" onClick={p.stop}>
            <Icon icon={x} size="sm" />
          </button>
        </div>
      </div>

      {/* Full-width scrubber with elapsed (left) and remaining (right) flanking it. */}
      <div className="npbar-scrubrow">
        <span className="np-time np-time-elapsed">{fmt(p.currentTime)}</span>
        <SeekBar className="npbar-scrub" current={p.currentTime} duration={p.duration} buffered={p.buffered} onSeek={p.seek} />
        <span className="np-time np-time-rem">{p.duration > 0 ? `-${fmt(p.duration - p.currentTime)}` : fmt(0)}</span>
      </div>
    </div>
  );
}

function SeekBar({ current, duration, buffered, onSeek, className }: { current: number; duration: number; buffered: number; onSeek: (t: number) => void; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const pct = (v: number) => (duration > 0 ? Math.max(0, Math.min(100, (v / duration) * 100)) : 0);

  function timeAt(clientX: number): number {
    const el = ref.current;
    if (!el || duration <= 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  }
  function onDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(timeAt(e.clientX));
  }
  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (drag !== null) setDrag(timeAt(e.clientX));
  }
  function onUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (drag !== null) {
      onSeek(timeAt(e.clientX));
      setDrag(null);
    }
  }
  const playedPct = pct(drag ?? current);

  return (
    <div
      ref={ref}
      className={`np-seek${className ? ` ${className}` : ""}`}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(drag ?? current)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      <div className="np-seek-track">
        <div className="np-seek-buffered" style={{ width: `${pct(buffered)}%` }} />
        <div className="np-seek-played" style={{ width: `${playedPct}%` }} />
        <div className="np-seek-thumb" style={{ left: `${playedPct}%` }} />
      </div>
    </div>
  );
}

function Volume({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="np-volume">
      <button className="np-btn" title={value === 0 ? "Unmute" : "Mute"} aria-label="Mute" onClick={() => onChange(value === 0 ? 1 : 0)}>
        <Icon icon={value === 0 ? volumeX : volume2} size="sm" />
      </button>
      <input
        className="np-vol-slider"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        aria-label="Volume"
      />
    </div>
  );
}
