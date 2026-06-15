import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import { IN_TAURI } from "../ipc/engine";
import { aiStatus, aiScan, getSetting, setSetting, type AiStatus, type ScanResult } from "../ipc/library";
import {
  tagPlan,
  tagApply,
  convertAudio,
  onTagProgress,
  onConvertProgress,
  type TagResult,
  type ConvertResult,
} from "../ipc/automation";
import {
  sparkles,
  cpu,
  tag as tagIcon,
  layers,
  arrowDownUp,
  folderOpen,
  circleCheck,
  music,
} from "../lib/icons";

type Phase = "idle" | "running" | "preview" | "applying" | "done" | "error";

const CONVERT_FORMATS = [
  { value: "alac", label: "ALAC (lossless)" },
  { value: "mp3", label: "MP3 (universal)" },
];

/** Library organization + AI automation: clean, format and tag the on-disk library
 *  so it's tidy here and legible on every other device. All AI work runs on Ollama. */
export function Automation({ onOrganize, onChanged }: { onOrganize: () => void; onChanged?: () => void }) {
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [model, setModel] = useState<string>("");

  // Tag & metadata task.
  const [tagPhase, setTagPhase] = useState<Phase>("idle");
  const [tagProg, setTagProg] = useState({ done: 0, total: 0 });
  const [tagRes, setTagRes] = useState<TagResult | null>(null);
  const [tagErr, setTagErr] = useState<string | null>(null);

  // Index & enrich task.
  const [scanBusy, setScanBusy] = useState(false);
  const [scanRes, setScanRes] = useState<ScanResult | null>(null);

  // Convert task.
  const [fmt, setFmt] = useState<"alac" | "mp3">("alac");
  const [convPhase, setConvPhase] = useState<Phase>("idle");
  const [convProg, setConvProg] = useState({ done: 0, total: 0 });
  const [convRes, setConvRes] = useState<ConvertResult | null>(null);
  const [convErr, setConvErr] = useState<string | null>(null);

  useEffect(() => {
    if (!IN_TAURI) return;
    aiStatus().then(setAi).catch(() => {});
    getSetting("ollama_model").then((m) => m && setModel(m)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!IN_TAURI) return;
    // Hold the listen() promises so cleanup can unlisten even if it runs before they
    // resolve (avoids a leaked listener firing setState after unmount).
    const pT = onTagProgress((p) => setTagProg({ done: p.done, total: p.total }));
    const pC = onConvertProgress((p) => setConvProg({ done: p.done, total: p.total }));
    return () => {
      void pT.then((f) => f());
      void pC.then((f) => f());
    };
  }, []);

  async function chooseModel(m: string) {
    setModel(m);
    try {
      await setSetting("ollama_model", m);
    } catch {
      /* ignore */
    }
  }

  async function runTagScan() {
    if (!IN_TAURI) return;
    setTagPhase("running");
    setTagProg({ done: 0, total: 0 });
    setTagRes(null);
    setTagErr(null);
    try {
      const r = await tagPlan();
      setTagRes(r);
      setTagPhase(r.changes.some((c) => c.status === "plan") ? "preview" : "done");
    } catch (e) {
      setTagErr(String(e));
      setTagPhase("error");
    }
  }

  async function applyTags() {
    if (!tagRes) return;
    const changes = tagRes.changes
      .filter((c) => c.status === "plan")
      .map((c) => ({
        path: c.path,
        newName: c.newName,
        title: c.title,
        artist: c.artist,
        album: c.album,
        track: c.track,
        year: c.year,
        genre: c.genre,
      }));
    if (changes.length === 0) return;
    setTagPhase("applying");
    setTagProg({ done: 0, total: changes.length });
    try {
      const r = await tagApply(changes);
      setTagRes(r);
      setTagPhase("done");
      onChanged?.();
    } catch (e) {
      setTagErr(String(e));
      setTagPhase("error");
    }
  }

  async function runScan() {
    if (!IN_TAURI) return;
    setScanBusy(true);
    try {
      const r = await aiScan(40);
      setScanRes(r);
      onChanged?.();
    } catch {
      /* ignore */
    } finally {
      setScanBusy(false);
    }
  }

  async function runConvert() {
    if (!IN_TAURI) return;
    setConvPhase("applying");
    setConvProg({ done: 0, total: 0 });
    setConvRes(null);
    setConvErr(null);
    try {
      const r = await convertAudio(fmt);
      setConvRes(r);
      setConvPhase("done");
      onChanged?.();
    } catch (e) {
      setConvErr(String(e));
      setConvPhase("error");
    }
  }

  const aiOn = !!ai?.available;
  const tagPlanChanges = tagRes?.changes.filter((c) => c.status === "plan") ?? [];
  const tagBusy = tagPhase === "running" || tagPhase === "applying";

  return (
    <div className="section-stack auto-page">
      <div className="cat-header" style={{ marginBottom: 4 }}>
        <span className="cat-title">
          <Icon icon={sparkles} size="lg" /> Automate
        </span>
      </div>
      <p className="auto-intro">
        Tidy, convert and tag your library with the local AI so every file is clean here — and legible,
        well-named and properly tagged on whatever device you copy it to.
      </p>

      {/* Ollama status + model picker */}
      <Card variant="outlined" padding="lg">
        <div className="auto-ai">
          <span className={`ai-pill ${aiOn ? "on" : "off"}`}>
            <Icon icon={cpu} size="xs" /> {aiOn ? "Ollama" : "Offline"}
          </span>
          {ai === null ? (
            <span className="field-hint">Checking for a local model…</span>
          ) : aiOn ? (
            <>
              <span className="field-hint">
                {ai.models.length > 1 ? "Tasks will use" : "Using"}
              </span>
              <select
                className="auto-select"
                value={model || ai.model || ""}
                onChange={(e) => chooseModel(e.currentTarget.value)}
                aria-label="Ollama model"
              >
                {ai.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span className="field-hint">
              Not running — start Ollama and pull a model (e.g. <code>ollama pull qwen2.5:7b</code>). Tasks
              still run with basic name cleanup until then.
            </span>
          )}
        </div>
      </Card>

      {/* Organize */}
      <TaskCard
        icon={layers}
        title="Organize & rename"
        desc="Move each download into a clean, separate Organized library — Movies / TV Shows / Music with tidy Plex-style names — one file at a time, so if it stops or crashes it just picks up where it left off."
      >
        <Button variant="primary" icon={sparkles} disabled={!IN_TAURI} onClick={onOrganize}>
          Organize library
        </Button>
      </TaskCard>

      {/* Clean tags & metadata */}
      <TaskCard
        icon={tagIcon}
        title="Clean tags & metadata"
        desc="Embed proper title, artist, album, track, year and genre into each track and rename files legibly — so they read correctly in Music, Plex or on a phone, not as messy release names."
      >
        {tagPhase === "idle" && (
          <Button variant="primary" icon={tagIcon} disabled={!IN_TAURI} onClick={runTagScan}>
            Scan music & preview
          </Button>
        )}

        {tagBusy && (
          <div className="auto-run">
            <div className="auto-run-label">
              <Spinner size="sm" />
              <span className="field-hint">
                {tagPhase === "running" ? "Reading tags" : "Writing tags"} · {tagProg.done}/{tagProg.total || "…"}
              </span>
            </div>
            {tagProg.total > 0 && (
              <div className="org-progress">
                <div
                  className="org-progress-fill"
                  style={{ width: `${Math.round((tagProg.done / tagProg.total) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}

        {tagPhase === "preview" && tagRes && (
          <div className="auto-preview-wrap">
            <div className="auto-run-label">
              <span className={`ai-pill ${tagRes.aiUsed ? "on" : "off"}`}>
                <Icon icon={cpu} size="xs" /> {tagRes.aiUsed ? "AI" : "Basic"}
              </span>
              <span className="field-hint">
                {tagPlanChanges.length} track{tagPlanChanges.length === 1 ? "" : "s"} to tag
                {tagRes.model ? ` · ${tagRes.model}` : ""}
              </span>
            </div>
            <div className="auto-preview">
              {tagPlanChanges.slice(0, 250).map((c, i) => (
                <div className="auto-prow" key={`${c.path}-${i}`}>
                  <div className="auto-prow-name">
                    {c.newName ? (
                      <>
                        <span className="auto-from" title={c.fileName}>
                          {c.fileName}
                        </span>
                        <span className="auto-arrow">→</span>
                        <span className="auto-to" title={c.newName}>
                          {c.newName}
                        </span>
                      </>
                    ) : (
                      <span className="auto-to" title={c.fileName}>
                        {c.fileName}
                      </span>
                    )}
                  </div>
                  <div className="auto-tags">
                    <span className="auto-tag">{c.title}</span>
                    {c.artist && <span className="auto-tag dim">{c.artist}</span>}
                    {c.album && <span className="auto-tag dim">{c.album}</span>}
                    {c.track != null && <span className="auto-tag dim">#{c.track}</span>}
                    {c.year != null && <span className="auto-tag dim">{c.year}</span>}
                  </div>
                </div>
              ))}
            </div>
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setTagPhase("idle")}>
                Cancel
              </Button>
              <Button variant="primary" icon={tagIcon} onClick={applyTags}>
                Tag {tagPlanChanges.length} file{tagPlanChanges.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        )}

        {tagPhase === "done" && tagRes && (
          <div className="auto-done">
            <Icon icon={circleCheck} size="sm" />
            <span>
              {tagRes.tagged > 0
                ? `Tagged ${tagRes.tagged} file${tagRes.tagged === 1 ? "" : "s"}.`
                : "Everything is already clean."}
              {tagRes.errors > 0 ? ` ${tagRes.errors} skipped.` : ""}
            </span>
            <Button variant="secondary" onClick={() => setTagPhase("idle")}>
              Run again
            </Button>
          </div>
        )}

        {tagPhase === "error" && (
          <div className="auto-err">
            <span className="field-hint">{tagErr}</span>
            <Button variant="secondary" onClick={() => setTagPhase("idle")}>
              Retry
            </Button>
          </div>
        )}
      </TaskCard>

      {/* Index & enrich */}
      <TaskCard
        icon={music}
        title="Index & enrich"
        desc="Scan new downloads, fetch artwork & ratings and build the fast index that powers browsing. Keeps the library snappy as it grows."
      >
        <div className="auto-run">
          <Button variant="primary" icon={sparkles} disabled={!IN_TAURI || scanBusy} onClick={runScan}>
            {scanBusy ? "Scanning…" : "Scan & enrich"}
          </Button>
          {scanBusy && <Spinner size="sm" />}
          {scanRes && !scanBusy && (
            <span className="field-hint">
              Organized {scanRes.organized} · {scanRes.posters} posters · {scanRes.remaining} remaining
            </span>
          )}
        </div>
      </TaskCard>

      {/* Convert for devices */}
      <TaskCard
        icon={arrowDownUp}
        title="Convert for devices"
        desc="Transcode FLAC / OGG / Opus into a portable format that plays anywhere. Originals are kept untouched (still seeding) — copies land in a Converted/ folder."
      >
        <div className="auto-convert">
          <SegmentedControl
            options={CONVERT_FORMATS}
            value={fmt}
            onChange={(v: string) => setFmt(v as "alac" | "mp3")}
          />
          <Button
            variant="primary"
            icon={arrowDownUp}
            disabled={!IN_TAURI || convPhase === "applying"}
            onClick={runConvert}
          >
            {convPhase === "applying" ? "Converting…" : "Convert"}
          </Button>
          {convPhase === "applying" && (
            <span className="field-hint">
              <Spinner size="sm" /> {convProg.total > 0 ? `${convProg.done}/${convProg.total}` : "…"}
            </span>
          )}
        </div>
        {convPhase === "done" && convRes && (
          <div className="auto-done">
            <Icon icon={folderOpen} size="sm" />
            <span>
              Converted {convRes.converted}
              {convRes.skipped > 0 ? ` · skipped ${convRes.skipped}` : ""}
              {convRes.errors > 0 ? ` · ${convRes.errors} failed` : ""} → {convRes.dest}
            </span>
          </div>
        )}
        {convPhase === "error" && <p className="field-hint auto-err-text">{convErr}</p>}
      </TaskCard>
    </div>
  );
}

function TaskCard({
  icon,
  title,
  desc,
  children,
}: {
  icon: string;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <Card variant="outlined" padding="lg">
      <div className="auto-task">
        <div className="auto-task-head">
          <span className="auto-task-icon">
            <Icon icon={icon} size="base" />
          </span>
          <div className="auto-task-text">
            <div className="auto-task-title">{title}</div>
            <p className="field-hint">{desc}</p>
          </div>
        </div>
        <div className="auto-task-body">{children}</div>
      </div>
    </Card>
  );
}
