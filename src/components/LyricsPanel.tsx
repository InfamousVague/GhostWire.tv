import { useEffect, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { micVocal } from "../lib/icons";
import type { SongLyrics } from "../ipc/lyrics";

/** Last timed line whose timeMs ≤ t (ms), via binary search. -1 before the first line. */
function activeIndex(synced: { timeMs: number }[], t: number): number {
  let lo = 0;
  let hi = synced.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (synced[mid].timeMs <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

/**
 * Beautiful lyrics surface. SYNCED mode (timed lines) highlights + auto-scrolls the active line,
 * driven by a ~250ms loop reading the live playhead (the native timeupdate is ~4/sec, too coarse).
 * Tapping a line seeks. PLAIN mode renders the unsynced text. Empty/loading states are graceful.
 */
export function LyricsPanel({
  lyrics,
  loading,
  getActiveTime,
  onSeek,
}: {
  lyrics: SongLyrics;
  loading?: boolean;
  /** Live playhead in seconds (read imperatively each tick — no re-render). */
  getActiveTime: () => number;
  onSeek: (seconds: number) => void;
}) {
  const synced = lyrics.synced;
  const [active, setActive] = useState(-1);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Suppress auto-scroll briefly after the user scrolls by hand, so we don't fight them.
  const userScrolledAt = useRef(0);
  const getTimeRef = useRef(getActiveTime);
  getTimeRef.current = getActiveTime;

  // Drive the active line from a fixed ~250ms loop (smoother than the native timeupdate tick).
  useEffect(() => {
    if (synced.length === 0) {
      setActive(-1);
      return;
    }
    const tick = () => {
      const idx = activeIndex(synced, getTimeRef.current() * 1000);
      setActive((prev) => (prev === idx ? prev : idx));
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [synced]);

  // Keep the active line centered (unless the user just scrolled).
  useEffect(() => {
    if (active < 0) return;
    if (Date.now() - userScrolledAt.current < 1600) return;
    lineRefs.current[active]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);

  if (loading && synced.length === 0 && !lyrics.plain) {
    return (
      <div className="lyrics-panel lyrics-panel--state">
        <div className="lyrics-shimmer" aria-label="Loading lyrics">
          {Array.from({ length: 6 }).map((_, i) => <span key={i} className="lyrics-shimmer-row" />)}
        </div>
      </div>
    );
  }

  if (synced.length === 0 && !lyrics.plain) {
    return (
      <div className="lyrics-panel lyrics-panel--state">
        <div className="lyrics-empty">
          <Icon icon={micVocal} size="xl" />
          <p>No lyrics found for this track.</p>
        </div>
      </div>
    );
  }

  if (synced.length === 0) {
    // Plain / unsynced fallback.
    return (
      <div className="lyrics-panel" ref={scrollerRef}>
        <div className="lyrics-plain">
          {(lyrics.plain ?? "").split("\n").map((line, i) => (
            <p key={i} className={line.trim() ? "lyrics-pline" : "lyrics-pline lyrics-pline--gap"}>{line || " "}</p>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="lyrics-panel lyrics-panel--synced"
      ref={scrollerRef}
      onWheel={() => { userScrolledAt.current = Date.now(); }}
      onTouchMove={() => { userScrolledAt.current = Date.now(); }}
    >
      <div className="lyrics-lines">
        {synced.map((line, i) => (
          <button
            key={i}
            ref={(el) => { lineRefs.current[i] = el; }}
            className={`lyric-line${i === active ? " is-active" : ""}${i < active ? " is-past" : ""}`}
            onClick={() => onSeek(line.timeMs / 1000)}
            title="Jump to this line"
          >
            {line.text || "♪"}
          </button>
        ))}
      </div>
    </div>
  );
}
