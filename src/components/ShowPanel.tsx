import { useEffect, useMemo, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { movieDigest, type MovieDigest, type TvEpisode, type TvShow } from "../ipc/library";
import { IN_TAURI } from "../ipc/engine";
import { circlePlay, star, tv } from "../lib/icons";

const pad = (n: number) => String(n).padStart(2, "0");

interface ShowPanelProps {
  show: TvShow;
  episodes: TvEpisode[];
  /** The season/episode currently playing (highlighted, drives "up next"). */
  season: number;
  episode: number;
  /** Start a different episode — finds a source (or a local copy) and plays it.
   *  Resolves false when nothing could be found, so the row can say so. */
  onPlayEpisode: (show: string, season: number, episode: number) => Promise<boolean>;
  /** Anime numbers episodes absolutely (no S/E) — label them "Episode N" and show an
   *  episode count instead of a season count. */
  absolute?: boolean;
}

/**
 * Prime/Netflix-style detail rail under the video: clean show metadata (poster,
 * synopsis, network, genres) plus an "Up next" button and a season-tabbed episode
 * browser. Every other episode is one click to play.
 */
export function ShowPanel({ show, episodes, season, episode, onPlayEpisode, absolute }: ShowPanelProps) {
  const seasons = useMemo(() => {
    const map = new Map<number, TvEpisode[]>();
    for (const e of episodes) {
      if (!map.has(e.season)) map.set(e.season, []);
      map.get(e.season)!.push(e);
    }
    for (const list of map.values()) list.sort((a, b) => a.number - b.number);
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [episodes]);

  // The episode browser defaults to the playing season, but follow along when the
  // user starts an episode from another season.
  const [selected, setSelected] = useState(season);
  useEffect(() => setSelected(season), [season]);

  // Pull the show's rich details (cast, ratings, director) from the relay digest so the
  // player page matches the main show page. Skipped for anime (absolute), whose fansub
  // titles don't match TMDB reliably.
  const [digest, setDigest] = useState<MovieDigest | null>(null);
  useEffect(() => {
    setDigest(null);
    if (!IN_TAURI || absolute || !show.name) return;
    let alive = true;
    movieDigest("show", show.name, show.year ?? null)
      .then((d) => { if (alive) setDigest(d); })
      .catch(() => { /* no digest — cast section just won't render */ });
    return () => { alive = false; };
  }, [show.name, show.year, absolute]);

  // Per-episode "finding a source" feedback so a click is never silent.
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  async function play(name: string, se: number, e: number) {
    const key = `${se}-${e}`;
    setPending(key);
    setFailed((f) => {
      const n = new Set(f);
      n.delete(key);
      return n;
    });
    const ok = await onPlayEpisode(name, se, e);
    setPending(null);
    if (!ok) setFailed((f) => new Set(f).add(key));
  }

  const current = episodes.find((e) => e.season === season && e.number === episode);
  const ordered = useMemo(
    () => [...episodes].sort((a, b) => a.season - b.season || a.number - b.number),
    [episodes],
  );
  const curIdx = ordered.findIndex((e) => e.season === season && e.number === episode);
  const next = curIdx >= 0 ? ordered[curIdx + 1] : undefined;

  const seasonEps = seasons.find(([n]) => n === selected)?.[1] ?? [];

  return (
    <div className="show-panel">
      <div className="show-meta">
        <div className="show-meta-art">
          {show.poster ? <img src={show.poster} alt="" /> : <Icon icon={tv} size="2xl" />}
        </div>
        <div className="show-meta-body">
          <h2 className="show-meta-name">{show.name}{show.year ? ` (${show.year})` : ""}</h2>
          <div className="show-meta-line">
            {(digest?.imdbRating != null || digest?.rating != null) && (
              <span className="show-rating">
                <Icon icon={star} size="xs" /> {(digest.imdbRating ?? digest.rating)!.toFixed(1)}
              </span>
            )}
            <span>
              {[
                show.network,
                absolute ? `${episodes.length} episodes` : `${seasons.length} season${seasons.length === 1 ? "" : "s"}`,
                (digest?.genres.length ? digest.genres : show.genres).slice(0, 3).join(" · "),
                digest?.runtimeMinutes ? `${digest.runtimeMinutes} min` : null,
              ]
                .filter(Boolean)
                .join("  ·  ")}
            </span>
          </div>
          {digest?.director && <div className="show-credit">Director · {digest.director}</div>}
          {current && (
            <div className="show-now">
              Now playing — {absolute ? `Episode ${episode}` : `S${pad(season)}E${pad(episode)}`}{current.name ? ` · ${current.name}` : ""}
              {current.airdate ? ` · ${current.airdate}` : ""}
            </div>
          )}
          {show.summary && <p className="show-meta-summary">{show.summary}</p>}
          {next && (
            <Button
              variant="primary"
              icon={circlePlay}
              loading={pending === `${next.season}-${next.number}`}
              onClick={() => play(show.name, next.season, next.number)}
            >
              Up next · {absolute ? `Episode ${next.number}` : `S${pad(next.season)}E${pad(next.number)}`}{next.name ? ` · ${next.name}` : ""}
            </Button>
          )}
        </div>
      </div>

      <div className="show-eps">
        <div className="show-eps-head">
          <span className="show-eps-title">Episodes</span>
          {seasons.length > 1 && (
            <div className="season-tabs">
              {seasons.map(([n]) => (
                <button key={n} className={`season-tab${n === selected ? " active" : ""}`} onClick={() => setSelected(n)}>
                  S{n}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="show-eps-list" key={selected}>
          {seasonEps.map((e) => {
            const key = `${e.season}-${e.number}`;
            const isCurrent = e.season === season && e.number === episode;
            const isPending = pending === key;
            const noSource = failed.has(key);
            return (
              <button
                key={key}
                className={`show-ep${isCurrent ? " is-current" : ""}`}
                onClick={() => !isCurrent && !isPending && play(show.name, e.season, e.number)}
                title={e.name}
                disabled={isCurrent || isPending}
              >
                <span className="show-ep-no">E{pad(e.number)}</span>
                <span className="show-ep-name">{e.name || "—"}</span>
                {e.airdate && <span className="show-ep-date">{e.airdate}</span>}
                {isCurrent ? (
                  <span className="show-ep-tag">Now playing</span>
                ) : isPending ? (
                  <Spinner size="sm" />
                ) : noSource ? (
                  <span className="show-ep-tag muted">No source</span>
                ) : (
                  <Icon icon={circlePlay} size="sm" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {digest && digest.cast.length > 0 && (
        <div className="show-cast">
          <span className="show-eps-title">Cast</span>
          <div className="digest-cast">
            {digest.cast.slice(0, 12).map((c, i) => (
              <div className="digest-castcard" key={`${c.name}-${i}`}>
                <div className="digest-castimg">
                  {c.profile ? <img src={c.profile} alt="" loading="lazy" /> : null}
                </div>
                <div className="digest-castname" title={c.name}>{c.name}</div>
                {c.character && <div className="digest-castrole" title={c.character}>{c.character}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
