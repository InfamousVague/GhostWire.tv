import { useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Toggle } from "@mattmattmattmatt/base/primitives/toggle/Toggle";
import { Card } from "@mattmattmattmatt/base/primitives/card/Card";
import { Chip } from "@mattmattmattmatt/base/primitives/chip/Chip";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { SegmentedControl } from "@mattmattmattmatt/base/primitives/segmented-control/SegmentedControl";
import { Dialog } from "@mattmattmattmatt/base/primitives/dialog/Dialog";
import {
  grid2x2, check, link2, plus, x, search as searchIcon, captions, play, rotateCw, users, sparkles,
  slidersVertical, chevronLeft, chevronRight,
} from "../lib/icons";
import { PosterRow } from "../components/PosterRow";
import { useExtensions, type ExtInfo } from "./host";
import { ExtensionSettingsFor, useHasExtSettings } from "./slots";
import type { ExtCategory, ExtManifest } from "./sdk";

/** A short label for what an extension contributes, from its manifest. */
function contributionTags(contributes?: Record<string, unknown>): string[] {
  if (!contributes) return [];
  const tags: string[] = [];
  const count = (k: string) => (Array.isArray(contributes[k]) ? (contributes[k] as unknown[]).length : 0);
  if (count("views")) tags.push(`${count("views")} view${count("views") === 1 ? "" : "s"}`);
  if (count("nav")) tags.push("nav");
  if (count("commands")) tags.push(`${count("commands")} command${count("commands") === 1 ? "" : "s"}`);
  if (count("discoverRows")) tags.push("discover row");
  if (count("settings")) tags.push("settings");
  if (count("searchSource")) tags.push("search source");
  if (count("subtitleProvider")) tags.push("subtitles");
  return tags;
}

// Browse categories (label + icon + folder accent). The id matches the manifest's discovery.category.
const CATEGORIES: { id: ExtCategory; label: string; icon: string; accent: string }[] = [
  { id: "sources", label: "Sources & search", icon: searchIcon, accent: "teal" },
  { id: "subtitles", label: "Subtitles", icon: captions, accent: "violet" },
  { id: "player", label: "Player", icon: play, accent: "teal" },
  { id: "sync", label: "Sync & tracking", icon: rotateCw, accent: "amber" },
  { id: "social", label: "Social", icon: users, accent: "green" },
  { id: "appearance", label: "Appearance", icon: slidersVertical, accent: "accent" },
];

/** The extension's category — explicit `discovery.category`, else inferred from its contributions. */
function categoryOf(m: ExtManifest): ExtCategory {
  const c = m.discovery?.category;
  if (c && CATEGORIES.some((x) => x.id === c)) return c;
  const ct = (m.contributes ?? {}) as Record<string, unknown>;
  const has = (k: string) => Array.isArray(ct[k]) && (ct[k] as unknown[]).length > 0;
  if (has("searchSource")) return "sources";
  if (has("subtitleProvider")) return "subtitles";
  if (has("discoverRows")) return "sync";
  return "player";
}

/** The Extensions page — a discovery/browse experience: search, a Featured shelf, category rows of
 *  cards, install-from-URL, and a detail overlay (info + permissions + toggle + the ext's settings). */
export function ExtensionsBrowse() {
  const { extensions, setEnabled, ui, installFromUrl, removeExtension } = useExtensions();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "enabled">("all");
  const [folder, setFolder] = useState<ExtCategory | null>(null);
  const [active, setActive] = useState<ExtInfo | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [installMsg, setInstallMsg] = useState("");
  const [installing, setInstalling] = useState(false);

  const iconFor = (m: ExtManifest) => (m.icon && ui.icons[m.icon]) || grid2x2;
  const query = q.trim().toLowerCase();
  const searching = query.length > 0;
  const match = (e: ExtInfo) =>
    !query ||
    e.manifest.name.toLowerCase().includes(query) ||
    (e.manifest.description ?? "").toLowerCase().includes(query) ||
    (e.manifest.discovery?.tagline ?? "").toLowerCase().includes(query);
  const shown = extensions.filter(match).filter((e) => filter === "all" || e.enabled);
  const featured = shown.filter((e) => e.manifest.discovery?.featured);
  const allCats = CATEGORIES.map((c) => ({ ...c, items: shown.filter((e) => categoryOf(e.manifest) === c.id) }));
  const enabledCount = extensions.filter((e) => e.enabled).length;
  // The drilled-in category (ignored while searching, or if it has gone empty after a filter change).
  const curCat = !searching && folder ? allCats.find((c) => c.id === folder && c.items.length > 0) ?? null : null;

  // Keep the open detail in sync with live state (toggle/install/remove update `extensions`).
  const activeLive = active ? extensions.find((e) => e.manifest.id === active.manifest.id) ?? null : null;

  const card = (e: ExtInfo) => (
    <ExtBrowseCard key={e.manifest.id} ext={e} icon={iconFor(e.manifest)}
      onOpen={() => setActive(e)} onToggle={(on) => setEnabled(e.manifest.id, on)} />
  );

  const doInstall = async () => {
    const url = installUrl.trim();
    if (!url) return;
    setInstalling(true);
    setInstallMsg("");
    try {
      await installFromUrl(url);
      setInstallUrl("");
      setInstallMsg("Installed!");
    } catch (e) {
      setInstallMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="search-page ext-browse">
      <div className="search-hero">
        <div className="search-bar-lg">
          <Input
            iconLeft={searchIcon} shape="pill" size="lg" placeholder="Search extensions…"
            value={q} onChange={(e) => setQ(e.currentTarget.value)} onClear={() => setQ("")}
          />
        </div>
      </div>

      <div className="ext-browse-bar">
        <SegmentedControl
          options={[{ value: "all", label: `All ${extensions.length}` }, { value: "enabled", label: `Enabled ${enabledCount}` }]}
          value={filter}
          onChange={(v) => setFilter(v as "all" | "enabled")}
        />
        <div className="ext-market-url">
          <span className="ext-market-url-ic"><Icon icon={link2} size="sm" /></span>
          <Input
            className="ext-market-url-input" placeholder="Install from a URL…"
            value={installUrl} onChange={(e) => setInstallUrl(e.currentTarget.value)} onClear={() => setInstallUrl("")}
            onKeyDown={(e) => { if (e.key === "Enter") void doInstall(); }}
          />
          <Button variant="secondary" icon={plus} onClick={() => void doInstall()} disabled={installing || !installUrl.trim()}>
            {installing ? "Installing…" : "Install"}
          </Button>
          {installMsg && <span className="field-hint">{installMsg}</span>}
        </div>
      </div>

      {searching ? (
        // Search active → flat results (navigation gives way to answers).
        shown.length === 0 ? (
          <div className="empty">
            <div className="empty-inner">
              <span className="empty-glyph"><Icon icon={grid2x2} size="xl" /></span>
              <h3>No extensions match “{q}”</h3><p>Try a different search.</p>
            </div>
          </div>
        ) : (
          <div className="ext-market-grid">{shown.map(card)}</div>
        )
      ) : curCat ? (
        // Drilled into a category folder.
        <div className="home">
          <div className="ext-cat-head">
            <button className="ext-cat-back" onClick={() => setFolder(null)}><Icon icon={chevronLeft} size="sm" /> Extensions</button>
            <h2 className="ext-cat-title">
              <Icon icon={curCat.icon} size="base" /> {curCat.label}
              <span className="ext-folder-count">{curCat.items.length} extension{curCat.items.length === 1 ? "" : "s"}</span>
            </h2>
          </div>
          <div className="ext-market-grid">{curCat.items.map(card)}</div>
        </div>
      ) : (
        // Landing: a Featured carousel + clickable category folders.
        <div className="home">
          {featured.length > 0 && (
            <div className="ext-rail">
              <PosterRow title="Featured" count={featured.length}>{featured.map(card)}</PosterRow>
            </div>
          )}
          <div className="ext-folders">
            {allCats.map((c) => (
              <ExtFolderTile key={c.id} icon={c.icon} label={c.label} count={c.items.length} accent={c.accent}
                onOpen={() => setFolder(c.id)} />
            ))}
          </div>
        </div>
      )}

      <ExtensionDetail
        ext={activeLive}
        icon={activeLive ? iconFor(activeLive.manifest) : grid2x2}
        onClose={() => setActive(null)}
        onToggle={(on) => activeLive && setEnabled(activeLive.manifest.id, on)}
        onRemove={activeLive && activeLive.source === "installed"
          ? async () => { await removeExtension(activeLive.manifest.id); setActive(null); }
          : undefined}
      />
    </div>
  );
}

/** A clickable category "folder" tile — icon chip + label + extension count. */
function ExtFolderTile({ icon, label, count, accent, onOpen }: {
  icon: string; label: string; count: number; accent: string; onOpen: () => void;
}) {
  return (
    <button className="ext-folder" data-accent={accent} onClick={onOpen} disabled={count === 0}
      aria-label={`${label}, ${count} extension${count === 1 ? "" : "s"}`}>
      <span className="ext-folder-ic"><Icon icon={icon} size="lg" /></span>
      <span className="ext-folder-meta">
        <span className="ext-folder-name">{label}</span>
        <span className="ext-folder-count">{count} extension{count === 1 ? "" : "s"}</span>
      </span>
      <span className="ext-folder-chev"><Icon icon={chevronRight} size="sm" /></span>
    </button>
  );
}

/** A storefront card for one extension — icon, name, tagline, contribution chips, enable toggle.
 *  The card body opens the detail; the Toggle enables/disables inline (stops the click from opening). */
function ExtBrowseCard({
  ext, icon, onOpen, onToggle,
}: {
  ext: ExtInfo;
  icon: string;
  onOpen: () => void;
  onToggle: (on: boolean) => void;
}) {
  const m = ext.manifest;
  const tagline = m.discovery?.tagline || m.description || "";
  const tags = contributionTags(m.contributes).slice(0, 3);
  return (
    <Card variant="outlined" padding="lg" className="ext-card-shell">
      <div
        className="ext-market-card ext-browse-card"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      >
        <div className="ext-market-card-head">
          <span className="ext-card-ic ext-market-card-ic"><Icon icon={icon} size="lg" /></span>
          <div className="ext-market-card-title">
            <span className="ext-market-card-name">{m.name}</span>
            <span className="field-hint">{m.author || "GhostWire"} · v{m.version}</span>
          </div>
          {/* Wrap the toggle so its click/keypress can't bubble to the card's onClick (which opens
              the detail modal). Base's Toggle doesn't forward onClick to its clickable element, so
              the stop must live on this wrapper. */}
          <span
            className="ext-card-toggle"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Toggle
              checked={ext.enabled}
              aria-label={`Enable ${m.name}`}
              onChange={(e) => onToggle(e.currentTarget.checked)}
            />
          </span>
        </div>
        {tagline && <p className="field-hint ext-market-card-desc">{tagline}</p>}
        {tags.length > 0 && (
          <div className="ext-market-card-tags">
            {tags.map((t) => <Chip key={t} size="sm"><Icon icon={check} size="xs" /> {t}</Chip>)}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Detail overlay — full description, permission + contribution chips, enable toggle, the extension's
 *  own settings (when enabled), and a Remove action for installed extensions. */
function ExtensionDetail({
  ext, icon, onClose, onToggle, onRemove,
}: {
  ext: ExtInfo | null;
  icon: string;
  onClose: () => void;
  onToggle: (on: boolean) => void;
  onRemove?: () => void;
}) {
  // Hook must run unconditionally — pass "" when nothing is selected.
  const hasSettings = useHasExtSettings(ext?.manifest.id ?? "");
  const m = ext?.manifest;
  const nets = m?.permissions?.network ?? [];
  const scopes = m?.permissions?.app ?? [];
  return (
    <Dialog open={!!ext} onClose={onClose} title={m?.name} size="lg" className="modal-wide">
      {ext && m ? (
        <div className="form-stack ext-detail">
          <div className="ext-detail-head">
            <span className="ext-card-ic ext-market-card-ic"><Icon icon={icon} size="lg" /></span>
            <div className="ext-market-card-title">
              <span className="ext-market-card-name">{m.name}</span>
              <span className="field-hint">{m.author || "GhostWire"} · v{m.version} · {ext.source}</span>
            </div>
            <Toggle checked={ext.enabled} aria-label={`Enable ${m.name}`} onChange={(e) => onToggle(e.currentTarget.checked)} />
          </div>
          {(m.description || m.discovery?.tagline) && <p className="field-hint">{m.description || m.discovery?.tagline}</p>}
          <div className="ext-detail-chips">
            {contributionTags(m.contributes).map((t) => <Chip key={t} size="sm"><Icon icon={check} size="xs" /> {t}</Chip>)}
            {nets.map((h) => <Chip key={h} size="sm"><Icon icon={link2} size="xs" /> {h}</Chip>)}
            {scopes.map((s) => <Chip key={s} size="sm">{s}</Chip>)}
          </div>
          {ext.enabled && hasSettings ? (
            <div className="ext-detail-settings"><ExtensionSettingsFor extId={m.id} /></div>
          ) : !ext.enabled ? (
            <p className="field-hint">Enable this extension to configure it.</p>
          ) : null}
          {onRemove && (
            <div className="ext-detail-foot">
              <Button variant="ghost" icon={x} onClick={onRemove}>Remove extension</Button>
            </div>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
