import { useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import type { LibraryItem } from "../ipc/library";
import { hueFromString } from "../lib/catalog";
import { formatBytes } from "../lib/format";
import { award, circleCheck, circlePlay, clapperboard, download as downloadIcon, star } from "../lib/icons";

/** Parse the JSON-encoded tag array the backend stores; tolerant of nulls. */
function parseTags(tags?: string | null): string[] {
  if (!tags) return [];
  try {
    const v = JSON.parse(tags);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function LibraryCard({
  item,
  onPlay,
  glyph = clapperboard,
  square = false,
  onQueue,
}: {
  item: LibraryItem;
  onPlay: () => void;
  glyph?: string;
  /** Square (1:1) art — for albums / music. */
  square?: boolean;
  /** Adds a hover "add to download queue" button. */
  onQueue?: () => void;
}) {
  const [queued, setQueued] = useState(false);
  const hue = hueFromString(item.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  const title = item.cleanTitle?.trim() || item.title;
  const tags = parseTags(item.tags).slice(0, 3);
  const hasRatings = item.imdbRating != null || item.rtRating != null;

  return (
    <div className="lib-card" onClick={onPlay} role="button" tabIndex={0}>
      <div className={`poster${square ? " square" : ""}`} style={item.poster ? undefined : { background: bg }}>
        {item.poster ? (
          <img className="poster-img" src={item.poster} alt="" loading="lazy" />
        ) : (
          <span className="poster-glyph">
            <Icon icon={glyph} size="2xl" />
          </span>
        )}
        {hasRatings && (
          <div className="lib-ratings">
            {item.imdbRating != null && (
              <span className="rating imdb" title="IMDb rating">
                <Icon icon={star} size="xs" />
                {item.imdbRating.toFixed(1)}
              </span>
            )}
            {item.rtRating != null && (
              <span className="rating rt" title="Rotten Tomatoes">
                <Icon icon={award} size="xs" />
                {item.rtRating}%
              </span>
            )}
          </div>
        )}
        {onQueue && (
          <button
            className={`card-queue${queued ? " queued" : ""}`}
            title={queued ? "Queued — downloading" : "Add to download queue"}
            aria-label={queued ? "Queued for download" : "Add to download queue"}
            onClick={(e) => {
              e.stopPropagation();
              if (queued) return;
              onQueue();
              setQueued(true);
            }}
          >
            <Icon icon={queued ? circleCheck : downloadIcon} size="sm" />
          </button>
        )}
        <span className="play-badge lib-play">
          <Icon icon={circlePlay} size="lg" />
        </span>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={title}>{title}</div>
        <div className="poster-info">
          {item.year && <span>{item.year}</span>}
          {item.year && <span className="dot" />}
          <span>{formatBytes(item.sizeBytes)}</span>
        </div>
        {tags.length > 0 && (
          <div className="lib-tags">
            {tags.map((t) => (
              <span key={t} className="lib-tag">{t}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
