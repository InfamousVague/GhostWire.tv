// IPC for the "clean up the library folder" task (backed by src-tauri/src/organize.rs).
// Runs incrementally: each download is moved into a separate Organized/ library one file
// at a time, so a crash or stop resumes without redoing finished files.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface OrganizeMove {
  from: string;
  fromName: string;
  toRel: string;
  mediaType: string; // movie | show | music
  status: "moved" | "skipped" | "error";
  message: string | null;
}

export interface OrganizeResult {
  root: string;
  aiUsed: boolean;
  model: string | null;
  moved: number;
  skipped: number;
  errors: number;
  moves: OrganizeMove[];
}

/** A single file's outcome, streamed live as the incremental run progresses. */
export interface OrganizeStep {
  done: number;
  total: number;
  file: string;
  toRel: string;
  mediaType: string;
  status: "moved" | "skipped" | "error";
  message: string | null;
}

/** Incrementally organize the downloads into a separate Organized/ library, one file at
 *  a time. Resumable — already-organized files are skipped on the next run. */
export function organizeRun(): Promise<OrganizeResult> {
  return invoke<OrganizeResult>("organize_run");
}

/** Subscribe to per-file progress while the incremental organize runs. */
export function onOrganizeProgress(cb: (s: OrganizeStep) => void): Promise<() => void> {
  return listen<OrganizeStep>("organize://progress", (e) => cb(e.payload));
}
