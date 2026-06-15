import { useEffect, useMemo, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { PosterGridSkeleton } from "../components/Skeletons";
import { useContextMenu, type MenuAction } from "../components/ContextMenu";
import { IN_TAURI } from "../ipc/engine";
import { removeFromLibrary, revealPath, trashDownloaded, type DownloadedItem } from "../ipc/library";
import { useDownloaded } from "../ipc/libraryCache";
import { spotifyAlbumArt } from "../ipc/spotify";
import { hueFromString } from "../lib/catalog";
import { formatBytes } from "../lib/format";
import { chevronLeft, circlePlay, disc3, folderOpen, library, micVocal, music, rotateCw, trash2 } from "../lib/icons";

interface MusicProps {
  /** Play a local audio file (single track). */
  onPlayLocal: (item: DownloadedItem) => void;
  /** Open the "replace poster" picker for an artist/album title. */
  onReplacePoster?: (title: string) => void;
}

interface ParsedTrack {
  item: DownloadedItem;
  artist: string;
  album: string;
  track: string;
  trackNo: number;
}

interface AlbumGroup {
  key: string;
  album: string;
  artist: string;
  tracks: ParsedTrack[];
  addedAt: number;
}

interface ArtistGroup {
  name: string;
  albums: AlbumGroup[];
  trackCount: number;
  addedAt: number;
}

const SPLIT = /\s+[-–—]\s+/;

/** Trim release cruft (trailing year, bracketed tags) off a folder/title for display. */
function tidy(s: string): string {
  return s
    .replace(/[\(\[][^)\]]*[\)\]]/g, " ") // (2001), [FLAC], …
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(flac|mp3|alac|320|256|kbps|web|cd|vinyl|remaster(ed)?|deluxe)\b/gi, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Derive artist / album / track from a downloaded music file. The id is the file's
 * relative path (e.g. "Music/Daft Punk - Discovery/01 One More Time.flac"), so the
 * folder structure carries most of the signal; we fall back to the file name.
 */
function parseMusic(it: DownloadedItem): ParsedTrack {
  const rel = it.id.replace(/\\/g, "/").replace(/^Music\//i, "");
  const segs = rel.split("/").filter(Boolean);
  const fileSeg = segs.length ? segs[segs.length - 1] : it.fileName;
  const folders = segs.slice(0, -1);

  let artist = "";
  let album = "";
  if (folders.length >= 2) {
    artist = folders[folders.length - 2];
    album = folders[folders.length - 1];
  } else if (folders.length === 1) {
    const parts = folders[0].split(SPLIT);
    if (parts.length >= 2) {
      artist = parts[0];
      album = parts.slice(1).join(" - ");
    } else {
      album = folders[0];
    }
  }

  const stem = fileSeg.replace(/\.[^.]+$/, "");
  const tn = stem.match(/^\s*(\d{1,3})[\s.\-_]+/);
  const trackNo = tn ? parseInt(tn[1], 10) : 0;
  let track = stem.replace(/^\s*\d{1,3}[\s.\-_]+/, "");
  // "Artist - Track" inside the file name → keep the track half, learn the artist.
  const fp = track.split(SPLIT);
  if (fp.length >= 2) {
    if (!artist) artist = fp[0];
    track = fp.slice(1).join(" - ");
  }
  track = tidy(track) || tidy(it.title) || stem;

  return {
    item: it,
    artist: tidy(artist) || "Unknown Artist",
    album: tidy(album) || "Singles",
    track,
    trackNo,
  };
}

export function Music({ onPlayLocal, onReplacePoster }: MusicProps) {
  const { items: all, refresh } = useDownloaded();
  const [artistName, setArtistName] = useState<string | null>(null);
  const [albumKey, setAlbumKey] = useState<string | null>(null);
  // Spotify cover art, keyed by `${artist}|${album}` lowercased. null = looked up, none found.
  const [covers, setCovers] = useState<Record<string, string | null>>({});
  const ctx = useContextMenu();

  // Revalidate on mount; the cached list paints instantly so there's no spinner on revisit.
  useEffect(() => { void refresh(); }, [refresh]);
  const loading = all === null;
  const items = useMemo(() => (all ?? []).filter((i) => i.mediaType === "music" && i.inLibrary), [all]);

  // Build the Artist → Album → Track tree from the flat file list.
  const artists = useMemo(() => {
    const albumMap = new Map<string, AlbumGroup>();
    for (const it of items) {
      const p = parseMusic(it);
      const key = `${p.artist.toLowerCase()}|${p.album.toLowerCase()}`;
      let g = albumMap.get(key);
      if (!g) {
        g = { key, album: p.album, artist: p.artist, tracks: [], addedAt: 0 };
        albumMap.set(key, g);
      }
      g.tracks.push(p);
      g.addedAt = Math.max(g.addedAt, it.addedAt);
    }
    const artistMap = new Map<string, ArtistGroup>();
    for (const al of albumMap.values()) {
      al.tracks.sort((a, b) => a.trackNo - b.trackNo || a.track.localeCompare(b.track));
      const ak = al.artist.toLowerCase();
      let ar = artistMap.get(ak);
      if (!ar) {
        ar = { name: al.artist, albums: [], trackCount: 0, addedAt: 0 };
        artistMap.set(ak, ar);
      }
      ar.albums.push(al);
      ar.trackCount += al.tracks.length;
      ar.addedAt = Math.max(ar.addedAt, al.addedAt);
    }
    const list = [...artistMap.values()];
    for (const ar of list) ar.albums.sort((a, b) => b.addedAt - a.addedAt);
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [items]);

  const allAlbums = useMemo(() => artists.flatMap((a) => a.albums), [artists]);

  // Scrub album covers from Spotify (covers only — legitimate catalog metadata).
  // One batched lookup whenever the set of albums changes; missing creds fail quietly.
  useEffect(() => {
    if (!IN_TAURI || allAlbums.length === 0) return;
    const want = allAlbums
      .filter((al) => covers[al.key] === undefined)
      .map((al) => ({ artist: al.artist, album: al.album, key: al.key }));
    if (want.length === 0) return;
    let alive = true;
    spotifyAlbumArt(want.map(({ artist, album }) => ({ artist, album })))
      .then((res) => {
        if (!alive) return;
        const next: Record<string, string | null> = {};
        for (const w of want) {
          const hit = res.find((r) => r.artist === w.artist && r.album === w.album);
          next[w.key] = hit?.art ?? null;
        }
        setCovers((c) => ({ ...c, ...next }));
      })
      .catch(() => {
        if (!alive) return;
        // No Spotify creds / offline — mark these as "looked up, none" so we don't retry.
        setCovers((c) => {
          const next = { ...c };
          for (const w of want) if (next[w.key] === undefined) next[w.key] = null;
          return next;
        });
      });
    return () => { alive = false; };
  }, [allAlbums, covers]);

  const artist = artistName ? artists.find((a) => a.name.toLowerCase() === artistName.toLowerCase()) ?? null : null;
  const album = albumKey ? allAlbums.find((a) => a.key === albumKey) ?? null : null;

  function artistArt(a: ArtistGroup): string | undefined {
    for (const al of a.albums) {
      const c = covers[al.key];
      if (c) return c;
    }
    return undefined;
  }

  function trackActions(p: ParsedTrack): MenuAction[] {
    return [
      { label: "Play", icon: circlePlay, onSelect: () => onPlayLocal(p.item) },
      { label: "Reveal in Finder", icon: folderOpen, onSelect: () => void revealPath(p.item.id) },
      { label: "Remove from library", icon: library, divider: true, onSelect: () => void removeFromLibrary(p.item.id).then(() => refresh()) },
      { label: "Move to Trash", icon: trash2, danger: true, onSelect: () => void trashDownloaded(p.item.id).then(() => refresh()) },
    ];
  }

  // ---- album detail (track list) ----
  if (album) {
    const cover = covers[album.key];
    return (
      <div className="section-stack media-wide">
        <button className="series-back" onClick={() => setAlbumKey(null)}><Icon icon={chevronLeft} size="sm" /> {album.artist}</button>
        <div className="series-head">
          <div className="series-art series-art-sq">{cover ? <img src={cover} alt="" /> : <Icon icon={disc3} size="2xl" />}</div>
          <div className="series-info">
            <h2 className="series-name">{album.album}</h2>
            <div className="series-meta">{[album.artist, `${album.tracks.length} track${album.tracks.length === 1 ? "" : "s"}`].join(" · ")}</div>
            <div className="form-actions" style={{ marginTop: 16 }}>
              <Button variant="primary" icon={circlePlay} onClick={() => onPlayLocal(album.tracks[0].item)}>Play</Button>
              {onReplacePoster && <Button variant="ghost" onClick={() => onReplacePoster(album.album)}>Replace cover…</Button>}
            </div>
          </div>
        </div>
        <div className="track-list">
          {album.tracks.map((p) => (
            <div key={p.item.id} className="track-row" onContextMenu={(e) => ctx.open(e, trackActions(p))} onDoubleClick={() => onPlayLocal(p.item)}>
              <span className="track-no">{p.trackNo || "—"}</span>
              <span className="track-name" title={p.track}>{p.track}</span>
              <span className="track-size">{formatBytes(p.item.sizeBytes)}</span>
              <button className="track-play" title="Play" onClick={() => onPlayLocal(p.item)}><Icon icon={circlePlay} size="sm" /></button>
            </div>
          ))}
        </div>
        {ctx.menu}
      </div>
    );
  }

  // ---- artist detail (albums grid) ----
  if (artist) {
    return (
      <div className="section-stack media-wide">
        <button className="series-back" onClick={() => setArtistName(null)}><Icon icon={chevronLeft} size="sm" /> All artists</button>
        <div className="cat-header">
          <span className="cat-title section-title"><Icon icon={micVocal} size="base" /> {artist.name}</span>
          <span className="cat-sub">{artist.albums.length} album{artist.albums.length === 1 ? "" : "s"}</span>
        </div>
        <div className="cat-grid">
          {artist.albums.map((al) => (
            <AlbumCard key={al.key} album={al} cover={covers[al.key]} onClick={() => setAlbumKey(al.key)} />
          ))}
        </div>
        {ctx.menu}
      </div>
    );
  }

  // ---- artists grid (top level) ----
  return (
    <div className="section-stack media-wide">
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={music} size="base" /> Music</span>
        {artists.length > 0 && <span className="cat-sub">{artists.length} artist{artists.length === 1 ? "" : "s"}</span>}
        <div className="cat-controls">
          <Button variant="ghost" icon={rotateCw} onClick={refresh}>Refresh</Button>
        </div>
      </div>

      {loading ? (
        <PosterGridSkeleton square />
      ) : artists.length === 0 ? (
        <div className="empty">
          <div className="empty-inner">
            <span className="empty-glyph"><Icon icon={music} size="xl" /></span>
            <h3>No music in your library yet</h3>
            <p>Find albums under <b>Discover</b> and download them — they'll show up here, grouped by artist, with covers from Spotify.</p>
          </div>
        </div>
      ) : (
        <div className="cat-grid">
          {artists.map((a) => (
            <ArtistCard key={a.name} artist={a} cover={artistArt(a)} onClick={() => setArtistName(a.name)} />
          ))}
        </div>
      )}
      {ctx.menu}
    </div>
  );
}

function ArtistCard({ artist, cover, onClick }: { artist: ArtistGroup; cover?: string; onClick: () => void }) {
  const hue = hueFromString(artist.name);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} role="button" tabIndex={0}>
      <div className="poster square round" style={cover ? undefined : { background: bg }}>
        {cover ? <img className="poster-img" src={cover} alt="" loading="lazy" /> : <span className="poster-glyph"><Icon icon={micVocal} size="2xl" /></span>}
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={artist.name}>{artist.name}</div>
        <div className="poster-info"><span>{artist.albums.length} album{artist.albums.length === 1 ? "" : "s"} · {artist.trackCount} track{artist.trackCount === 1 ? "" : "s"}</span></div>
      </div>
    </div>
  );
}

function AlbumCard({ album, cover, onClick }: { album: AlbumGroup; cover?: string | null; onClick: () => void }) {
  const hue = hueFromString(album.album);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;
  return (
    <div className="poster-card" onClick={onClick} role="button" tabIndex={0}>
      <div className="poster square" style={cover ? undefined : { background: bg }}>
        {cover ? <img className="poster-img" src={cover} alt="" loading="lazy" /> : <span className="poster-glyph"><Icon icon={disc3} size="2xl" /></span>}
        <div className="poster-seed"><span className="play-badge"><Icon icon={circlePlay} size="base" /></span></div>
      </div>
      <div className="poster-meta">
        <div className="poster-name" title={album.album}>{album.album}</div>
        <div className="poster-info"><span>{album.tracks.length} track{album.tracks.length === 1 ? "" : "s"}</span></div>
      </div>
    </div>
  );
}
