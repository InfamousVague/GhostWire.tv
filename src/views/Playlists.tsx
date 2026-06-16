import { useEffect, useMemo, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { IN_TAURI } from "../ipc/engine";
import { usePlayer, type PlayerTrack } from "../ipc/player";
import {
  FORMAT_LABELS,
  createPlaylist,
  deletePlaylist,
  exportPlaylist,
  getPlaylist,
  importPlaylist,
  listPlaylists,
  playlistRemoveTrack,
  renamePlaylist,
  spotifyToPlaylist,
  type Playlist,
  type PlaylistFormat,
} from "../ipc/playlists";
import { hueFromString } from "../lib/catalog";
import { check, chevronLeft, download as downloadIcon, folderDown, folderOutput, listMusic, music, play as playIcon, plus, rotateCw, trash2, x } from "../lib/icons";
import "./Playlists.css";

const FORMATS: PlaylistFormat[] = ["m3u8", "m3u", "pls", "xspf"];

function fmtDur(ms: number): string {
  if (!ms || ms < 0) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Playlists() {
  const player = usePlayer();
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const [selected, setSelected] = useState<Playlist | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Header tools.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [spotifyLink, setSpotifyLink] = useState("");
  // Detail tools.
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [format, setFormat] = useState<PlaylistFormat>("m3u8");
  const sortedLists = useMemo(
    () => [...(lists ?? [])].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name)),
    [lists],
  );

  async function refresh() {
    try {
      setLists(await listPlaylists());
    } catch (e) {
      setError(String(e));
      setLists([]);
    }
  }

  useEffect(() => {
    if (IN_TAURI) void refresh();
    else setLists([]);
  }, []);

  async function open(id: string) {
    setError(null);
    setStatus(null);
    try {
      setSelected(await getPlaylist(id));
    } catch (e) {
      setError(String(e));
    }
  }

  async function doCreate() {
    const name = newName.trim();
    if (!name) return;
    setBusy("create");
    setError(null);
    try {
      const p = await createPlaylist(name);
      setNewName("");
      setCreating(false);
      await refresh();
      setSelected(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doSpotify() {
    const link = spotifyLink.trim();
    if (!link) return;
    setBusy("spotify");
    setError(null);
    setStatus(null);
    try {
      const p = await spotifyToPlaylist(link);
      setSpotifyLink("");
      await refresh();
      setSelected(p);
      setStatus(`Saved “${p.name}” — ${p.tracks.length} song${p.tracks.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doImport() {
    setError(null);
    setStatus(null);
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const file = await openDialog({
        multiple: false,
        filters: [{ name: "Playlists", extensions: ["m3u8", "m3u", "pls", "xspf"] }],
      });
      if (typeof file !== "string") return;
      setBusy("import");
      const p = await importPlaylist(file);
      await refresh();
      setSelected(p);
      setStatus(`Imported “${p.name}” — ${p.tracks.length} track${p.tracks.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doDelete(p: Playlist) {
    setBusy("delete");
    try {
      await deletePlaylist(p.id);
      setSelected(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doRename() {
    if (!selected) return;
    const name = renameVal.trim();
    if (!name) return;
    setBusy("rename");
    try {
      const p = await renamePlaylist(selected.id, name);
      setSelected(p);
      setRenaming(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doExport() {
    if (!selected) return;
    setBusy("export");
    setError(null);
    setStatus(null);
    try {
      setStatus(await exportPlaylist(selected.id, format));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function removeTrack(index: number) {
    if (!selected) return;
    try {
      const p = await playlistRemoveTrack(selected.id, index);
      setSelected(p);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  function playablesOf(p: Playlist): { track: PlayerTrack; index: number }[] {
    return p.tracks
      .map((t, index) => ({ t, index }))
      .filter(({ t }) => !!t.url)
      .map(({ t, index }) => ({
        index,
        track: { id: `${p.id}:${index}`, title: t.title, artist: t.artist || undefined, album: t.album || undefined, url: t.url! },
      }));
  }

  function playAll(p: Playlist) {
    const q = playablesOf(p);
    if (q.length) player.play(q.map((x) => x.track), 0);
  }

  function playFrom(p: Playlist, trackIndex: number) {
    const q = playablesOf(p);
    const at = q.findIndex((x) => x.index === trackIndex);
    if (at >= 0) player.play(q.map((x) => x.track), at);
  }

  if (!IN_TAURI) {
    return (
      <div className="section-stack media-wide">
        <div className="cat-header">
          <span className="cat-title section-title"><Icon icon={listMusic} size="base" /> Playlists</span>
        </div>
        <p className="field-hint">Playlists run in the desktop app.</p>
      </div>
    );
  }

  // ----- detail view -----
  if (selected) {
    const downloaded = selected.tracks.filter((t) => t.url).length;
    return (
      <div className="section-stack media-wide">
        <button className="series-back" onClick={() => { setSelected(null); setRenaming(false); setStatus(null); }}>
          <Icon icon={chevronLeft} size="sm" /> Playlists
        </button>

        <div className="cat-header">
          <span className="cat-title section-title"><Icon icon={listMusic} size="base" /> {selected.name}</span>
          <span className="cat-sub">
            {selected.source === "spotify" ? "Spotify" : selected.source === "import" ? "Imported" : "Manual"}
            {" · "}
            {selected.tracks.length} song{selected.tracks.length === 1 ? "" : "s"}
            {" · "}
            {downloaded} downloaded
          </span>
          <div className="cat-controls">
            <Button variant="primary" icon={playIcon} disabled={downloaded === 0} onClick={() => playAll(selected)}>
              Play{downloaded < selected.tracks.length && downloaded > 0 ? ` (${downloaded})` : ""}
            </Button>
            <Button variant="ghost" onClick={() => { setRenameVal(selected.name); setRenaming(true); }}>Rename</Button>
            <Button variant="ghost" icon={trash2} loading={busy === "delete"} onClick={() => doDelete(selected)}>Delete</Button>
          </div>
        </div>

        <div className="settings-group">
          {renaming && (
            <div className="pl-rename-row">
              <Input value={renameVal} onChange={(e) => setRenameVal(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && doRename()} />
              <Button size="sm" variant="primary" icon={check} loading={busy === "rename"} onClick={doRename}>Save</Button>
              <Button size="sm" variant="ghost" icon={x} onClick={() => setRenaming(false)}>Cancel</Button>
            </div>
          )}
          <div className="form-actions">
            <span className="pl-export">
              <select className="pl-format" value={format} onChange={(e) => setFormat(e.currentTarget.value as PlaylistFormat)}>
                {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
              </select>
              <Button variant="secondary" icon={folderOutput} loading={busy === "export"} disabled={downloaded === 0} onClick={doExport}>
                Export
              </Button>
            </span>
          </div>

          {downloaded === 0 && (
            <p className="field-hint pl-hint">
              None of these songs are downloaded yet — replicate the playlist from the search box, or grab the tracks, then they’ll
              light up here and become exportable.
            </p>
          )}
          {status && <p className="settings-status">{status}</p>}
          {error && <p className="settings-status spotify-error">{error}</p>}
        </div>

        <div className="pl-tracks">
          {selected.tracks.map((t, i) => (
            <div className={`pl-track${t.url ? " has-file" : ""}`} key={`${t.title}-${i}`}>
              <button className="pl-track-idx" disabled={!t.url} onClick={() => playFrom(selected, i)} title={t.url ? "Play" : "Not downloaded"}>
                {t.url ? <span className="pl-play-glyph"><Icon icon={playIcon} size="xs" /></span> : <span className="pl-num">{i + 1}</span>}
              </button>
              <div className="pl-track-meta">
                <div className="pl-track-name" title={t.title}>{t.title}</div>
                <div className="pl-track-artist">{[t.artist, t.album].filter(Boolean).join(" · ")}</div>
              </div>
              <span className="pl-track-dur">{fmtDur(t.durationMs)}</span>
              <button className="pl-track-x" title="Remove from playlist" onClick={() => removeTrack(i)}>
                <Icon icon={x} size="xs" />
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ----- master / list view -----
  return (
    <div className="section-stack media-wide">
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={listMusic} size="base" /> Playlists</span>
        {lists && lists.length > 0 && <span className="cat-sub">{lists.length} playlist{lists.length === 1 ? "" : "s"}</span>}
        <div className="cat-controls">
          <Button variant="ghost" icon={rotateCw} onClick={() => void refresh()}>Refresh</Button>
        </div>
      </div>

      <div className="settings-group">
        <div className="search-bar-lg">
          <Input
            iconLeft={music}
            shape="pill"
            size="lg"
            placeholder="Paste a Spotify playlist link to save it as a playlist..."
            value={spotifyLink}
            onChange={(e) => setSpotifyLink(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && doSpotify()}
          />
          <Button variant="primary" shape="pill" size="lg" icon={downloadIcon} loading={busy === "spotify"} disabled={!spotifyLink.trim()} onClick={doSpotify}>
            Save
          </Button>
        </div>

        <div className="form-actions pl-head-actions">
          {creating ? (
            <span className="pl-new-row">
              <Input autoFocus placeholder="Playlist name…" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") void doCreate(); if (e.key === "Escape") setCreating(false); }} />
              <Button size="sm" variant="primary" icon={check} loading={busy === "create"} onClick={doCreate}>Create</Button>
              <Button size="sm" variant="ghost" icon={x} onClick={() => setCreating(false)}>Cancel</Button>
            </span>
          ) : (
            <>
              <Button size="sm" variant="secondary" icon={plus} onClick={() => setCreating(true)}>New</Button>
              <Button size="sm" variant="ghost" icon={folderDown} loading={busy === "import"} onClick={doImport}>Import</Button>
            </>
          )}
        </div>

      {status && <p className="settings-status">{status}</p>}
      {error && <p className="settings-status spotify-error">{error}</p>}
      </div>

      {lists === null ? (
        <div className="spotify-loading"><Spinner size="md" /></div>
      ) : lists.length === 0 ? (
        <div className="pl-empty">
          <Icon icon={listMusic} size="lg" />
          <p>No playlists yet.</p>
          <p className="field-hint">Save one from a Spotify link above, import an existing M3U/PLS/XSPF file, or start a new one.</p>
        </div>
      ) : (
        <div className="pl-grid">
          {sortedLists.map((p) => <PlaylistCard key={p.id} playlist={p} onOpen={() => open(p.id)} />)}
        </div>
      )}
    </div>
  );
}

function PlaylistCard({ playlist, onOpen }: { playlist: Playlist; onOpen: () => void }) {
  const downloaded = playlist.tracks.filter((t) => t.url).length;
  const hue = hueFromString(playlist.name);
  const bg = `linear-gradient(150deg, hsl(${hue} 32% 24%), hsl(${(hue + 40) % 360} 42% 13%))`;

  return (
    <button className="poster-card pl-poster-card" onClick={onOpen}>
      <span className="poster square" style={{ background: bg }}>
        <span className="poster-glyph"><Icon icon={listMusic} size="2xl" /></span>
        <span className="poster-seed">
          <span>{downloaded}/{playlist.tracks.length}</span>
          <span className="play-badge"><Icon icon={playIcon} size="base" /></span>
        </span>
      </span>
      <span className="poster-meta">
        <span className="poster-name" title={playlist.name}>{playlist.name}</span>
        <span className="poster-info">
          <span>{playlist.tracks.length} song{playlist.tracks.length === 1 ? "" : "s"}</span>
          <span className="dot" />
          <span>{downloaded} downloaded</span>
        </span>
        <span className="poster-info pl-source-row">
          {playlist.source === "spotify" ? "Spotify" : playlist.source === "import" ? "Imported" : "Manual"}
        </span>
      </span>
    </button>
  );
}
