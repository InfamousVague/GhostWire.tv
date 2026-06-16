// IPC for playlist manifests (saved as JSON on disk by the Rust `playlist` module)
// plus export/import to the common player formats and Spotify-link capture.
import { invoke } from "@tauri-apps/api/core";

export interface PlaylistTrack {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  isrc?: string | null;
  /** Absolute local file path, once the song is downloaded + matched. */
  path?: string | null;
  spotifyUrl?: string | null;
  /** Loopback stream URL the player can play (present only when downloaded). */
  url?: string | null;
}

export interface Playlist {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  /** "spotify" | "manual" | "import" */
  source: string;
  tracks: PlaylistTrack[];
}

/** Rockbox uses M3U8; the rest are for other players / portability. */
export type PlaylistFormat = "m3u8" | "m3u" | "pls" | "xspf";

export const FORMAT_LABELS: Record<PlaylistFormat, string> = {
  m3u8: "M3U8 (Rockbox)",
  m3u: "M3U",
  pls: "PLS",
  xspf: "XSPF",
};

export function listPlaylists(): Promise<Playlist[]> {
  return invoke<Playlist[]>("list_playlists");
}

export function getPlaylist(id: string): Promise<Playlist> {
  return invoke<Playlist>("get_playlist", { id });
}

export function createPlaylist(name: string, tracks?: PlaylistTrack[]): Promise<Playlist> {
  return invoke<Playlist>("create_playlist", { name, tracks: tracks ?? null });
}

export function deletePlaylist(id: string): Promise<void> {
  return invoke("delete_playlist", { id }).then(() => undefined);
}

export function renamePlaylist(id: string, name: string): Promise<Playlist> {
  return invoke<Playlist>("rename_playlist", { id, name });
}

export function playlistAddTracks(id: string, tracks: PlaylistTrack[]): Promise<Playlist> {
  return invoke<Playlist>("playlist_add_tracks", { id, tracks });
}

export function playlistRemoveTrack(id: string, index: number): Promise<Playlist> {
  return invoke<Playlist>("playlist_remove_track", { id, index });
}

/** Export to a player format; returns a human summary. `dir` defaults to Music/Playlists. */
export function exportPlaylist(id: string, format: PlaylistFormat, dir?: string | null): Promise<string> {
  return invoke<string>("export_playlist", { id, format, dir: dir ?? null });
}

export function importPlaylist(filePath: string): Promise<Playlist> {
  return invoke<Playlist>("import_playlist", { filePath });
}

/** Link a Spotify playlist → save a real manifest of its songs. */
export function spotifyToPlaylist(link: string): Promise<Playlist> {
  return invoke<Playlist>("spotify_to_playlist", { link });
}
