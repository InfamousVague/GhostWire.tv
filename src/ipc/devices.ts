// IPC for removable-device music sync (MP3 players / SD cards).
// Detects connected volumes and copies the Library's music onto them into one folder,
// so a portable player stays in sync with the app. Desktop-only (iOS has no /Volumes).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IN_TAURI } from "./engine";

export interface SyncDevice {
  /** Volume label (falls back to the mount-point folder name). */
  name: string;
  /** Absolute mount path — the stable id we sync to. */
  mountPath: string;
  totalBytes: number;
  freeBytes: number;
  removable: boolean;
  fileSystem: string;
  /** A sync folder of the requested name already exists on the device… */
  hasSyncFolder: boolean;
  /** …and holds this many audio files. */
  syncedTracks: number;
}

/** Connected removable volumes. `folderName` drives the "already synced" track counts. */
export function listDevices(folderName?: string): Promise<SyncDevice[]> {
  if (!IN_TAURI) return Promise.resolve([]);
  return invoke<SyncDevice[]>("list_devices", { folderName: folderName ?? null });
}

export interface DeviceSyncResult {
  /** Absolute device folder synced into. */
  folder: string;
  copied: number;
  skipped: number;
  deleted: number;
  errors: number;
  bytesCopied: number;
  totalTracks: number;
  /** Playlists written into <device>/Playlists/ (0 unless playlist sync was on). */
  playlistsWritten: number;
  /** Track refs (m3u) or copies (folders mode) written across those playlists. */
  playlistTracks: number;
}

/** How playlists are written onto the device. */
export type PlaylistMode = "m3u8" | "folders";

/** Copy the Library's music onto `mountPath`/`folderName`. When `mirror`, tracks on the
 *  device that are no longer in the Library are removed (non-audio files are never touched).
 *  When `playlists`, the app's playlists are written into <device>/Playlists/ — as `.m3u8`
 *  files (no duplication) or, in "folders" mode, as folders of copied tracks. */
export function syncMusicToDevice(
  mountPath: string,
  folderName: string,
  mirror: boolean,
  playlists: boolean,
  playlistMode: PlaylistMode,
): Promise<DeviceSyncResult> {
  return invoke<DeviceSyncResult>("sync_music_to_device", {
    mountPath,
    folderName: folderName.trim() || "Music",
    mirror,
    playlists,
    playlistMode,
  });
}

export interface DeviceSyncStep {
  /** Which pass this step belongs to — "copy" (transferring), "mirror" (deleting extras),
   *  or "playlists" (writing the Playlists/ folder). */
  phase: "copy" | "mirror" | "playlists";
  done: number;
  total: number;
  file: string;
  /** "copying" is an in-flight announcement (before the transfer); "playlist" is a written
   *  playlist file; the rest are per-track outcomes. */
  action: "copying" | "copied" | "skipped" | "deleted" | "error" | "playlist";
  message: string | null;
}

/** Subscribe to per-file sync progress. Resolves to an unlisten fn. */
export function onDeviceSyncProgress(cb: (step: DeviceSyncStep) => void): Promise<() => void> {
  if (!IN_TAURI) return Promise.resolve(() => {});
  return listen<DeviceSyncStep>("device-sync://progress", (e) => cb(e.payload));
}
