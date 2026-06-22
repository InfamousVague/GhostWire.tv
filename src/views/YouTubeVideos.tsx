import { useEffect, useMemo } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { useDownloaded } from "../ipc/libraryCache";
import type { DownloadedItem } from "../ipc/library";
import { formatBytes } from "../lib/format";
import { circlePlay, rotateCw, sparkles } from "../lib/icons";
import "./YouTubeVideos.css";

// Séance saves summoned videos under <download_dir>/Library/Videos/, so they surface in the local
// library scan as `kind: "video"` items whose relpath (the item id) lives under that folder.
const SEANCE_DIR_RE = /(^|\/)Library\/Videos\//;
function isSeanceVideo(it: DownloadedItem): boolean {
  return it.kind === "video" && SEANCE_DIR_RE.test(it.id.replace(/\\/g, "/"));
}

function timeAgo(epochSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / 604800)}w ago`;
}

interface YouTubeVideosProps {
  /** Play a saved video file (routes through the app's local player). */
  onPlayLocal: (item: DownloadedItem) => void;
  /** Jump to the Séance page to summon more. */
  onSummon?: () => void;
  onReady?: () => void;
}

/** The "YouTube" section of the Videos page — every clip summoned with the Séance extension. */
export function YouTubeVideos({ onPlayLocal, onSummon, onReady }: YouTubeVideosProps) {
  const { items, refresh } = useDownloaded();
  const videos = useMemo(
    () => items.filter(isSeanceVideo).sort((a, b) => b.addedAt - a.addedAt),
    [items],
  );
  useEffect(() => { onReady?.(); }, [onReady]);

  return (
    <div className="section-stack media-wide">
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={circlePlay} size="base" /> YouTube</span>
        <span className="cat-sub">Videos you&rsquo;ve summoned with Séance.</span>
        <div className="cat-controls">
          {onSummon && <Button variant="primary" shape="pill" icon={sparkles} onClick={onSummon}>Summon</Button>}
          <Button variant="secondary" shape="pill" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      {videos.length === 0 ? (
        <div className="yt-empty">
          <img src="/hero-youtube.png" alt="" style={{ width: 320, height: "auto", marginBottom: 4 }} />
          <div className="yt-empty-title">No summoned videos yet</div>
          <p>Use Séance to pull videos from YouTube, Vimeo, Twitch and more — they&rsquo;ll appear here, ready to play.</p>
          {onSummon && <Button variant="primary" shape="pill" icon={sparkles} onClick={onSummon}>Open Séance</Button>}
        </div>
      ) : (
        <div className="yt-grid">
          {videos.map((v) => (
            <button key={v.id} className="yt-card" onClick={() => onPlayLocal(v)} title={v.cleanTitle || v.title}>
              <div className="yt-thumb">
                {v.artworkUrl ? <img src={v.artworkUrl} alt="" loading="lazy" /> : <Icon icon={circlePlay} size="2xl" />}
                <span className="yt-play"><Icon icon={circlePlay} size="lg" /></span>
              </div>
              <div className="yt-info">
                <div className="yt-title">{v.cleanTitle || v.title}</div>
                <div className="yt-meta">{formatBytes(v.sizeBytes)} &middot; {timeAgo(v.addedAt)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
