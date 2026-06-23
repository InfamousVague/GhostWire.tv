import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { musicSearch, type MusicSong } from "../ipc/library";
import { IN_TAURI } from "../ipc/engine";
import { circlePlay, pause as pauseIcon, download, sparkles, disc3, check } from "../lib/icons";
import "./MusicDiscovery.css";

interface MusicDiscoveryProps {
  query: string;
  /** Queue a discovered song for lossless download (via the SpotiFLAC import flow). */
  onImport: (song: MusicSong) => void;
  /** Local library already has matches → show a tighter strip of suggestions. */
  compact?: boolean;
}

/** "Find new music" — a keyless catalog search (iTunes) appended to the Music page's search, with
 *  30-second previews and one-click lossless download through SpotiFLAC. */
export function MusicDiscovery({ query, onImport, compact }: MusicDiscoveryProps) {
  const [songs, setSongs] = useState<MusicSong[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [imported, setImported] = useState<Set<number>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const q = query.trim();

  useEffect(() => {
    if (!IN_TAURI || q.length < 2) { setSongs([]); setError(false); setLoading(false); return; }
    let alive = true;
    setLoading(true); setError(false);
    const t = setTimeout(() => {
      musicSearch(q)
        .then((res) => { if (alive) setSongs(res); })
        .catch(() => { if (alive) { setSongs([]); setError(true); } })
        .finally(() => { if (alive) setLoading(false); });
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  // Stop any preview when the query changes or the section unmounts.
  useEffect(() => () => { audioRef.current?.pause(); }, []);
  useEffect(() => { audioRef.current?.pause(); setPlayingId(null); }, [q]);

  const togglePreview = (song: MusicSong) => {
    const a = audioRef.current;
    if (!a || !song.previewUrl) return;
    if (playingId === song.id) { a.pause(); setPlayingId(null); return; }
    a.src = song.previewUrl;
    void a.play().then(() => setPlayingId(song.id)).catch(() => setPlayingId(null));
  };

  const doImport = (song: MusicSong) => {
    onImport(song);
    setImported((s) => new Set(s).add(song.id));
  };

  const shown = useMemo(() => (compact ? songs.slice(0, 8) : songs), [songs, compact]);

  if (!IN_TAURI || q.length < 2) return null;
  if (!loading && songs.length === 0 && !error) return null; // nothing worth appending

  return (
    <section className="mdisc">
      <div className="mdisc-head">
        <span className="mdisc-title"><Icon icon={sparkles} size="sm" /> Find new music</span>
        <span className="mdisc-sub">{loading ? "Searching the catalog…" : error ? "Catalog unavailable" : `From the music catalog · “${q}”`}</span>
      </div>
      {error ? (
        <div className="mdisc-empty">Couldn’t reach the music catalog. Check your connection and try again.</div>
      ) : (
        <div className="mdisc-grid">
          {loading && songs.length === 0
            ? Array.from({ length: 6 }).map((_, i) => <div key={`s${i}`} className="mdisc-card mdisc-skel" />)
            : shown.map((song) => {
                const isPlaying = playingId === song.id;
                const done = imported.has(song.id);
                return (
                  <div key={song.id} className="mdisc-card">
                    <div className="mdisc-art">
                      {song.artwork
                        ? <img src={song.artwork} alt="" loading="lazy" />
                        : <Icon icon={disc3} size="2xl" />}
                      {song.previewUrl && (
                        <button
                          className={`mdisc-play${isPlaying ? " on" : ""}`}
                          onClick={() => togglePreview(song)}
                          aria-label={isPlaying ? "Pause preview" : "Play preview"}
                        >
                          <Icon icon={isPlaying ? pauseIcon : circlePlay} size="lg" />
                        </button>
                      )}
                    </div>
                    <div className="mdisc-info">
                      <div className="mdisc-name" title={song.title}>{song.title}</div>
                      <div className="mdisc-artist" title={`${song.artist}${song.album ? ` · ${song.album}` : ""}`}>
                        {song.artist}{song.year ? ` · ${song.year}` : ""}
                      </div>
                    </div>
                    <Button
                      className="mdisc-dl"
                      variant={done ? "ghost" : "secondary"}
                      shape="pill"
                      size="sm"
                      icon={done ? check : download}
                      disabled={done}
                      onClick={() => doImport(song)}
                    >
                      {done ? "Queued" : "Download"}
                    </Button>
                  </div>
                );
              })}
        </div>
      )}
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} preload="none" />
    </section>
  );
}
