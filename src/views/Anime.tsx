import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { PosterGridSkeleton } from "../components/Skeletons";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { IN_TAURI } from "../ipc/engine";
import { classifyAnime, removeFromLibrary, revealPath, trashDownloaded, type DownloadedItem } from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { hueFromString } from "../lib/catalog";
import { formatBytes } from "../lib/format";
import { isAnime, parseAnimeEpisode, parseEpisode } from "../lib/media";
import { anime as animeIcon, chevronLeft, circlePlay, folderOpen, images, library, rotateCw, trash2, tv } from "../lib/icons";

interface AnimeProps {
  onPlayLocal: (item: DownloadedItem) => void;
  posterFor?: (title: string, kind?: string) => string | undefined;
  onReplacePoster?: (title: string) => void;
  /** Run a source search (jumps to Discover results) — used by "Find anime". */
  onBrowse: (q: string) => void;
}

// Grouping key for a show title — mirrors the TV tab so seasons/episodes collapse to one card
// ("&"→"and", apostrophes dropped, punctuation flattened).
const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const pad = (n: number) => String(n).padStart(2, "0");

/** One resolved episode: the on-disk file plus the season/episode we'll lay it out under. */
interface AnimeEp {
  item: DownloadedItem;
  season: number;
  episode: number | null;
}

/** One library title — a series with its episodes, or a single film. */
interface AnimeGroup {
  title: string;
  kind: "show" | "movie";
  eps: AnimeEp[];
  addedAt: number;
  /** True if the local heuristic already classified this as anime (instant, no network). */
  local: boolean;
}

/**
 * Resolve a downloaded file to a {show, season, episode}. For organized files the backend
 * already split the show name from S/E, so the title IS the show. For fansub releases it
 * couldn't (the name starts with "[Group]" / uses absolute numbering), so the title is the
 * whole release name — re-parse it here so "[SubsPlease] Frieren - 12" and "… - 13" both
 * collapse to the "Frieren" series instead of becoming two cards.
 */
function resolve(it: DownloadedItem): { show: string; season: number; episode: number | null; isEpisode: boolean } {
  const e = parseEpisode(it.title); // SxxExx / 1x02 still embedded in the title
  if (e) return { show: e.show, season: e.season, episode: e.episode, isEpisode: true };
  const a = parseAnimeEpisode(it.title); // fansub tags + absolute episode number
  if (a) return { show: a.show, season: it.season ?? 1, episode: a.episode, isEpisode: true };
  if (it.season != null || it.episode != null || it.mediaType === "show") {
    return { show: it.title, season: it.season ?? 1, episode: it.episode, isEpisode: it.mediaType === "show" };
  }
  return { show: it.title, season: 1, episode: null, isEpisode: false };
}

/** Anime tab = the user's locally installed anime, grouped by series (like the TV tab) and
 *  filtered to anime. Discovery of popular/trending/seasonal anime lives on the Discover home. */
export function Anime({ onPlayLocal, posterFor, onReplacePoster, onBrowse }: AnimeProps) {
  const { items: all, refresh } = useDownloaded();
  const [openTitle, setOpenTitle] = useState<string | null>(null);
  const [film, setFilm] = useState<DownloadedItem | null>(null);
  // Titles TVMaze confirms are anime (normalized) — the authoritative fallback for shows the
  // local heuristic can't judge (an organized file has no fansub tag; the genre is on TVMaze).
  const [tvAnime, setTvAnime] = useState<Set<string>>(new Set());
  const ctx = useContextMenu();

  useEffect(() => { void refresh(); }, [refresh]);
  const loading = all === null;

  // Group every in-library video (anime crosses Movies + TV) by series, re-parsing fansub
  // names so episodes of one show collapse to a single card.
  const groups = useMemo<AnimeGroup[]>(() => {
    const map = new Map<string, AnimeGroup>();
    for (const it of all ?? []) {
      if (!it.inLibrary) continue;
      if (it.mediaType !== "movie" && it.mediaType !== "show") continue;
      const r = resolve(it);
      const key = norm(r.show);
      if (!key) continue;
      const ep: AnimeEp = { item: it, season: r.season, episode: r.episode };
      const g = map.get(key);
      if (!g) {
        map.set(key, { title: r.show, kind: r.isEpisode ? "show" : "movie", eps: [ep], addedAt: it.addedAt, local: isAnime(it) });
      } else {
        g.eps.push(ep);
        g.addedAt = Math.max(g.addedAt, it.addedAt);
        // Multiple files (or a parsed episode) means it's a series, not a one-off film.
        if (r.isEpisode || g.eps.length > 1) g.kind = "show";
        g.local = g.local || isAnime(it);
      }
    }
    return [...map.values()];
  }, [all]);

  // Ask TVMaze about the show groups the local heuristic didn't already catch. Cached
  // server-side, so this only hits the network the first time a new show appears.
  const pending = useMemo(
    () => groups.filter((g) => g.kind === "show" && !g.local).map((g) => g.title).sort().join("\n"),
    [groups],
  );
  useEffect(() => {
    if (!IN_TAURI || !pending) return;
    let alive = true;
    classifyAnime(pending.split("\n"))
      .then((hits) => { if (alive) setTvAnime((prev) => new Set([...prev, ...hits.map(norm)])); })
      .catch(() => {});
    return () => { alive = false; };
  }, [pending]);

  const anime = useMemo(
    () => groups.filter((g) => g.local || tvAnime.has(norm(g.title))).sort((a, b) => a.title.localeCompare(b.title)),
    [groups, tvAnime],
  );

  const open = openTitle ? anime.find((g) => g.title === openTitle) ?? null : null;

  function showActions(g: AnimeGroup): MenuAction[] {
    return [
      { label: "Open", icon: g.kind === "show" ? tv : circlePlay, onSelect: () => (g.kind === "show" ? setOpenTitle(g.title) : setFilm(g.eps[0].item)) },
      { label: "Replace poster…", icon: images, onSelect: () => onReplacePoster?.(g.title) },
      {
        label: g.kind === "show" ? "Remove show from library" : "Remove from library",
        icon: library,
        divider: true,
        onSelect: () => void Promise.all(g.eps.map((e) => removeFromLibrary(e.item.id))).then(() => refresh()),
      },
    ];
  }

  // ---- single film detail ----
  if (film) {
    const fmt = film.fileName.split(".").pop()?.toUpperCase();
    return (
      <div className="series media-wide">
        <button className="series-back" onClick={() => setFilm(null)}><Icon icon={chevronLeft} size="sm" /> Anime</button>
        <div className="series-head">
          <div className="series-art">{posterFor?.(film.title, "anime") ? <img src={posterFor(film.title, "anime")} alt="" /> : <Icon icon={animeIcon} size="2xl" />}</div>
          <div className="series-info">
            <h2 className="series-name">{film.title}</h2>
            <div className="series-meta">{["Anime", "Film", fmt, formatBytes(film.sizeBytes)].filter(Boolean).join(" · ")}</div>
            <div className="form-actions" style={{ marginTop: 16 }}>
              <Button variant="primary" icon={circlePlay} onClick={() => onPlayLocal(film)}>Play</Button>
              {onReplacePoster && <Button variant="ghost" onClick={() => onReplacePoster(film.title)}>Replace poster…</Button>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- series detail (local seasons/episodes) ----
  if (open) {
    return (
      <AnimeSeries
        group={open}
        poster={posterFor?.(open.title, "anime")}
        onPlayLocal={onPlayLocal}
        onReplacePoster={onReplacePoster}
        onBack={() => { setOpenTitle(null); void refresh(); }}
      />
    );
  }

  return (
    <div className="section-stack media-wide">
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={animeIcon} size="base" /> Anime</span>
        {anime.length > 0 && <span className="cat-sub">{anime.length}</span>}
        <div className="cat-controls">
          <Button variant="secondary" icon={animeIcon} onClick={() => onBrowse("anime")}>Find anime</Button>
          <Button variant="ghost" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      {loading ? (
        <PosterGridSkeleton />
      ) : anime.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <span className="empty-glyph"><Icon icon={animeIcon} size="xl" /></span>
            <h3>No anime in your library yet</h3>
            <p>Browse <b>Discover</b> for trending and seasonal anime, or tap <b>Find anime</b> to search your sources — anything tagged anime (or from a known fansub group) lands here.</p>
            <div className="form-actions" style={{ marginTop: 14, justifyContent: "center" }}>
              <Button variant="primary" icon={animeIcon} onClick={() => onBrowse("anime")}>Find anime</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="cat-grid">
          {anime.map((g) => (
            <Card
              key={g.title}
              group={g}
              poster={posterFor?.(g.title, "anime")}
              onClick={() => (g.kind === "show" ? setOpenTitle(g.title) : setFilm(g.eps[0].item))}
              onContextMenu={(e) => ctx.open(e, showActions(g))}
            />
          ))}
        </div>
      )}
      {ctx.menu}
    </div>
  );
}

/** A library series: lays out the downloaded episodes by season so you can play what you have.
 *  (Filling in missing episodes lives on the TV Shows tab, which shares this grouping.) */
function AnimeSeries({
  group, poster, onPlayLocal, onReplacePoster, onBack,
}: {
  group: AnimeGroup;
  poster?: string;
  onPlayLocal: (item: DownloadedItem) => void;
  onReplacePoster?: (title: string) => void;
  onBack: () => void;
}) {
  const seasons = useMemo(() => {
    const map = new Map<number, AnimeEp[]>();
    for (const e of group.eps) {
      if (!map.has(e.season)) map.set(e.season, []);
      map.get(e.season)!.push(e);
    }
    for (const list of map.values()) list.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [group]);

  return (
    <div className="series media-wide">
      <button className="series-back" onClick={onBack}><Icon icon={chevronLeft} size="sm" /> Anime</button>
      <div className="series-head">
        <div className="series-art">{poster ? <img src={poster} alt="" /> : <Icon icon={animeIcon} size="2xl" />}</div>
        <div className="series-info">
          <h2 className="series-name">{group.title}</h2>
          <div className="series-meta">{["Anime", "Series", `${group.eps.length} episode${group.eps.length === 1 ? "" : "s"}`].join(" · ")}</div>
          {onReplacePoster && (
            <div className="form-actions" style={{ marginTop: 16 }}>
              <Button variant="ghost" icon={images} onClick={() => onReplacePoster(group.title)}>Replace poster…</Button>
            </div>
          )}
        </div>
      </div>

      <div className="seasons">
        {seasons.map(([n, eps]) => (
          <div key={n} className="season">
            <div className="season-head">
              <span className="season-toggle" style={{ cursor: "default" }}><Icon icon={tv} size="sm" /><span>Season {n}</span><span className="season-count">{eps.length} eps</span></span>
            </div>
            <div className="episodes">
              {eps.map((e) => (
                <div key={e.item.id} className="episode">
                  <div className="episode-row">
                    <span className="episode-no">{e.episode != null ? `S${pad(n)}E${pad(e.episode)}` : "—"}</span>
                    <span className="episode-name" title={e.item.fileName}>{e.item.fileName}</span>
                    <Button variant="ghost" size="sm" icon={circlePlay} onClick={() => onPlayLocal(e.item)}>Play</Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Card({ group, poster, onClick, onContextMenu }: { group: AnimeGroup; poster?: string; onClick: () => void; onContextMenu?: (e: MouseEvent) => void }) {
  const hue = hueFromString(group.title);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  const sub = group.kind === "show"
    ? `${group.eps.length} episode${group.eps.length === 1 ? "" : "s"}`
    : `Film · ${formatBytes(group.eps[0].item.sizeBytes)}`;
  return (
    <div className="poster-card" onClick={onClick} onContextMenu={onContextMenu} role="button" tabIndex={0}>
      <div className="poster" style={poster ? undefined : { background: bg }}>
        {poster ? <img className="poster-img" src={poster} alt="" loading="lazy" /> : <span className="poster-glyph"><Icon icon={group.kind === "show" ? tv : animeIcon} size="2xl" /></span>}
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={group.title}>{group.title}</div>
        <div className="poster-info"><span>{sub}</span></div>
      </div>
    </div>
  );
}
