// IPC for the AI Automation section: clean metadata tagging (lofty-backed) + audio
// format conversion. Library organization and indexing reuse organize.ts / library.ts.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TagChange {
  path: string;
  fileName: string;
  /** Proposed legible filename in the same folder, or null if already clean. */
  newName: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  track: number | null;
  year: number | null;
  genre: string | null;
  aiUsed: boolean;
  status: "plan" | "tagged" | "error";
  message: string | null;
}

export interface TagResult {
  root: string;
  aiUsed: boolean;
  model: string | null;
  planned: number;
  tagged: number;
  errors: number;
  changes: TagChange[];
}

export interface TagApply {
  path: string;
  newName: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  track: number | null;
  year: number | null;
  genre: string | null;
}

/** Dry-run: parse every audio file with Ollama (regex fallback) into clean tags. */
export function tagPlan(): Promise<TagResult> {
  return invoke<TagResult>("tag_plan");
}

/** Embed the accepted tags into the files and apply legible renames. */
export function tagApply(changes: TagApply[]): Promise<TagResult> {
  return invoke<TagResult>("tag_apply", { changes });
}

export interface ConvertResult {
  converted: number;
  skipped: number;
  errors: number;
  dest: string;
}

/** Transcode non-portable audio to ALAC (.m4a) or MP3 under a Converted/ folder. */
export function convertAudio(format: "alac" | "mp3"): Promise<ConvertResult> {
  return invoke<ConvertResult>("convert_audio", { format });
}

export interface TaskProgress {
  phase: string;
  done: number;
  total: number;
}

/** Live progress while a tag plan/apply runs. Resolves to an unlisten fn. */
export function onTagProgress(cb: (p: TaskProgress) => void): Promise<() => void> {
  return listen<TaskProgress>("tag://progress", (e) => cb(e.payload));
}

/** Live progress while a conversion runs. Resolves to an unlisten fn. */
export function onConvertProgress(cb: (p: TaskProgress) => void): Promise<() => void> {
  return listen<TaskProgress>("convert://progress", (e) => cb(e.payload));
}
