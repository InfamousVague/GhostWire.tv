import { useEffect, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { IN_TAURI } from "../ipc/engine";
import {
  aiStatus,
  appInfo,
  clearCatalog,
  getSetting,
  pickFolder,
  restartApp,
  setSetting,
  setStorageDir,
  type AiStatus,
  type AppInfo,
} from "../ipc/library";
import { cpu, film, folderDown, folderOpen, hardDrive, rotateCw } from "../lib/icons";

export function Settings({ onCatalogChanged }: { onCatalogChanged: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tmdbKey, setTmdbKey] = useState("");
  const [omdbKey, setOmdbKey] = useState("");
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  // Storage-folder change flow.
  const [chosenDir, setChosenDir] = useState<string | null>(null);
  const [migrate, setMigrate] = useState(true);
  const [needsRestart, setNeedsRestart] = useState(false);

  async function chooseFolder() {
    const dir = await pickFolder().catch(() => null);
    if (dir) setChosenDir(dir);
  }
  async function applyFolder() {
    if (!chosenDir) return;
    setBusy("storage");
    setStatus("");
    try {
      const msg = await setStorageDir(chosenDir, migrate);
      setStatus(msg);
      setNeedsRestart(true);
      setChosenDir(null);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!IN_TAURI) return;
    appInfo().then(setInfo).catch(() => {});
    getSetting("tmdb_key").then((k) => setTmdbKey(k ?? "")).catch(() => {});
    getSetting("omdb_key").then((k) => setOmdbKey(k ?? "")).catch(() => {});
    aiStatus().then(setAi).catch(() => {});
  }, []);

  async function saveKeys() {
    if (!IN_TAURI) return;
    setBusy("save");
    try {
      await setSetting("tmdb_key", tmdbKey.trim());
      await setSetting("omdb_key", omdbKey.trim());
      setStatus("API keys saved. Run an AI scan from the Library to match posters and ratings.");
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(null);
    }
  }
  async function doClear() {
    setBusy("clear");
    setStatus("");
    try {
      const n = await clearCatalog();
      setStatus(`Cleared ${n} indexed item${n === 1 ? "" : "s"}.`);
      onCatalogChanged();
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="section-stack">
      <div className="cat-header" style={{ marginBottom: 4 }}>
        <span className="cat-title">Settings</span>
      </div>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Storage</h4>
          <div className="settings-row">
            <span className="settings-label"><Icon icon={folderDown} size="sm" /> Save folder</span>
            <code className="mono-path">{info?.downloadDir ?? "—"}</code>
          </div>
          <p className="field-hint">Where downloads are saved. Move it to an external drive and (optionally) bring your existing files along.</p>
          <div className="form-actions settings-actions">
            <Button variant="secondary" icon={folderOpen} disabled={!IN_TAURI} onClick={chooseFolder}>Change folder…</Button>
            {needsRestart && (
              <Button variant="primary" icon={rotateCw} onClick={() => void restartApp()}>Restart now</Button>
            )}
          </div>
          {chosenDir && (
            <div className="storage-confirm">
              <div className="settings-row">
                <span className="settings-label">New folder</span>
                <code className="mono-path">{chosenDir}</code>
              </div>
              <label className="settings-check">
                <input type="checkbox" checked={migrate} onChange={(e) => setMigrate(e.currentTarget.checked)} />
                Move existing downloads into the new folder
              </label>
              <div className="form-actions">
                <Button variant="ghost" onClick={() => setChosenDir(null)}>Cancel</Button>
                <Button variant="primary" loading={busy === "storage"} onClick={applyFolder}>Apply</Button>
              </div>
            </div>
          )}
          <div className="settings-row">
            <span className="settings-label"><Icon icon={hardDrive} size="sm" /> App data</span>
            <code className="mono-path">{info?.dataDir ?? "—"}</code>
          </div>
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Playback</h4>
          <div className="settings-row">
            <span className="settings-label"><Icon icon={film} size="sm" /> Format support</span>
            <span className="settings-val">
              {info?.ffmpegAvailable
                ? "FFmpeg detected — MKV, HEVC, AC-3, XviD and more are transcoded on the fly"
                : "Install FFmpeg (brew install ffmpeg) to play MKV and other non-MP4 formats"}
            </span>
          </div>
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Local AI</h4>
          <div className="settings-row">
            <span className="settings-label"><Icon icon={cpu} size="sm" /> Ollama</span>
            <span className="settings-val">
              {ai === null
                ? "—"
                : ai.available
                  ? `Connected — scans will use ${ai.model ?? "the installed model"}${
                      ai.models.length > 1 ? ` (${ai.models.length} models installed)` : ""
                    }`
                  : "Not running. Install Ollama and pull a model (e.g. `ollama pull qwen2.5:7b`) to organize titles. Posters still work without it."}
            </span>
          </div>
          <p className="field-hint">
            The local model parses messy release names into clean titles, types and tags — then
            posters and ratings are matched. Run scans from the Library tab.
          </p>
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Posters &amp; ratings</h4>
          <p className="field-hint">
            Optional API keys. OMDb adds IMDb and Rotten Tomatoes scores plus posters; TMDB is a
            poster fallback. Both have free tiers.
          </p>
          <div className="field">
            <label className="field-label">OMDb API key — IMDb + Rotten Tomatoes</label>
            <Input
              type="password"
              placeholder="OMDb API key"
              value={omdbKey}
              onChange={(e) => setOmdbKey(e.currentTarget.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">TMDB API key — poster fallback</label>
            <Input
              type="password"
              placeholder="TMDB API key"
              value={tmdbKey}
              onChange={(e) => setTmdbKey(e.currentTarget.value)}
            />
          </div>
          <div className="form-actions settings-actions">
            <Button
              variant="primary"
              loading={busy === "save"}
              disabled={!IN_TAURI}
              onClick={saveKeys}
            >
              Save keys
            </Button>
          </div>
        </div>
      </Card>

      <Card variant="outlined" padding="lg">
        <div className="settings-group">
          <h4 className="settings-h">Catalog</h4>
          <p className="field-hint">Remove all indexed items (configured sources are kept).</p>
          <div className="form-actions settings-actions">
            <Button
              variant="secondary"
              intent="error"
              appearance="subtle"
              loading={busy === "clear"}
              disabled={!IN_TAURI}
              onClick={doClear}
            >
              Clear indexed catalog
            </Button>
          </div>
        </div>
      </Card>

      {status && <p className="settings-status">{status}</p>}
      {!IN_TAURI && <p className="field-hint">Settings actions run in the desktop app.</p>}
    </div>
  );
}
