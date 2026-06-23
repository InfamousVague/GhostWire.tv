import { useEffect, useMemo, useRef, useState } from "react";
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
  slidersVertical, chevronLeft, chevronRight, star, download, flame, trendingUp, shieldCheck, award,
  circleCheck, arrowDownUp,
} from "../lib/icons";
import { PosterRow } from "../components/PosterRow";
import { useExtensions, type ExtInfo } from "./host";
import { ExtensionSettingsFor, useHasExtSettings } from "./slots";
import type { ExtCategory, ExtManifest } from "./sdk";

type Disc = NonNullable<ExtManifest["discovery"]>;
type Accent = NonNullable<Disc["accent"]>;

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
  if (count("musicImporter")) tags.push("music import");
  return tags;
}

// Browse categories (label + icon + folder accent). The id matches the manifest's discovery.category.
const CATEGORIES: { id: ExtCategory; label: string; icon: string; accent: Accent }[] = [
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

// ---- Curated storefront metadata for the 12 first-party extensions ----
// Sourced centrally (not in the JSON manifests) so it's identical in the Vite preview and the desktop
// build regardless of how the Rust `ext_list` (de)serializes manifest fields, and so the editorial
// balance — which are featured / staff picks / their relative popularity — stays in one place. Merged
// OVER each manifest's own `discovery` (curated wins for first-party). Every value is a truthful
// editorial signal drawn from what the extension actually does; missing stats simply don't render.
const MARKET_META: Record<string, Disc> = {
  "prowlarr-bridge": {
    featured: true, staffPick: true, accent: "teal", installs: 2400, rating: 4.7, updated: "2026-05-22",
    tags: ["prowlarr", "jackett", "indexer", "sources"],
    highlights: ["Search your self-hosted Prowlarr/Jackett indexers", "Results merge straight into app search", "Bring your own private trackers"],
  },
  "rss-auto": {
    featured: true, accent: "teal", installs: 1500, rating: 4.5, updated: "2026-05-10",
    tags: ["rss", "atom", "automation", "feeds"],
    highlights: ["Auto-download new items from RSS/Atom feeds", "Filter rules so only what you want lands", "Runs quietly in the background"],
  },
  "subtitle-fetcher": {
    featured: true, staffPick: true, accent: "violet", installs: 3300, rating: 4.8, updated: "2026-06-02",
    tags: ["subtitles", "opensubtitles", "captions"],
    highlights: ["Pulls subtitles from OpenSubtitles", "Auto-adds them to the player's CC menu", "Matches whatever you're watching"],
  },
  "subtitle-translator": {
    accent: "violet", installs: 980, rating: 4.4, updated: "2026-04-26",
    tags: ["subtitles", "translate", "libretranslate", "captions"],
    highlights: ["Translate subtitles into your language", "Powered by LibreTranslate", "Adds a translated CC track"],
  },
  "trakt-sync": {
    featured: true, staffPick: true, accent: "amber", installs: 2700, rating: 4.7, updated: "2026-05-28",
    tags: ["trakt", "scrobbler", "tracking"],
    highlights: ["Scrobbles what you watch to Trakt.tv", "Adds an “Up Next” row to Discover", "Never lose your place in a series"],
  },
  "anilist-sync": {
    accent: "amber", installs: 1800, rating: 4.6, updated: "2026-05-16",
    tags: ["anilist", "anime", "scrobbler", "tracking"],
    highlights: ["Scrobbles anime to your AniList list", "Adds a “Continue Anime” Discover row", "Updates as you watch"],
  },
  "discord-presence": {
    featured: true, staffPick: true, accent: "green", installs: 2600, rating: 4.6, updated: "2026-06-09",
    tags: ["discord", "presence", "social"],
    highlights: ["Shows what you're watching on Discord", "Rich presence with cover art", "Works for music + video"],
  },
  pip: {
    accent: "teal", installs: 1300, rating: 4.5, updated: "2026-04-18",
    tags: ["picture-in-picture", "floating", "player"],
    highlights: ["Pop the video into a floating window", "Keep browsing while it plays"],
  },
  "sleep-timer": {
    accent: "teal", installs: 860, rating: 4.5, updated: "2026-03-24",
    tags: ["sleep", "timer", "player"],
    highlights: ["Auto-pause after a set time", "…or at the end of the episode"],
  },
  // SpotiFLAC + SpotiMirror stay factual and un-promoted (no featured / staff pick / stats).
  spotiflac: {
    tags: ["music", "library"],
  },
  spotimirror: {
    accent: "green", tags: ["music", "playlists", "sync"],
    highlights: ["Mirrors your Spotify playlists into local copies"],
  },
  seance: {
    accent: "violet", installs: 1100, rating: 4.3, updated: "2026-05-05",
    tags: ["youtube", "vimeo", "twitch", "download"],
    highlights: ["Paste a video link → it lands in your library", "Pick quality up to best, or audio-only"],
  },
};

/** Effective discovery for an extension — curated first-party metadata merged over the manifest's own. */
function effDisc(m: ExtManifest): Disc {
  return { ...(m.discovery ?? {}), ...(MARKET_META[m.id] ?? {}) };
}
function accentOf(m: ExtManifest): Accent {
  return effDisc(m).accent ?? CATEGORIES.find((c) => c.id === categoryOf(m))?.accent ?? "accent";
}
function isVerified(m: ExtManifest): boolean {
  return effDisc(m).verified ?? (m.author ?? "GhostWire") === "GhostWire";
}

/** "3d ago" / "2mo ago" — relative update time for the storefront footers. */
function relTime(iso?: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.round((Date.now() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const mo = Math.round(days / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}
/** Compact install count: 2400 → "2.4k". */
function fmtInstalls(n?: number): string | null {
  if (n == null) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${n}`;
}

type Sort = "popular" | "rating" | "recent" | "name";
const SORTS: { id: Sort; label: string }[] = [
  { id: "popular", label: "Popular" },
  { id: "rating", label: "Top rated" },
  { id: "recent", label: "Recently updated" },
  { id: "name", label: "Name (A–Z)" },
];

function sortItems(list: ExtInfo[], sort: Sort): ExtInfo[] {
  const byName = (a: ExtInfo, b: ExtInfo) => a.manifest.name.localeCompare(b.manifest.name);
  const arr = [...list];
  switch (sort) {
    case "name":
      return arr.sort(byName);
    case "rating":
      return arr.sort((a, b) => (effDisc(b.manifest).rating ?? -1) - (effDisc(a.manifest).rating ?? -1) || byName(a, b));
    case "recent":
      return arr.sort((a, b) => (Date.parse(effDisc(b.manifest).updated ?? "") || 0) - (Date.parse(effDisc(a.manifest).updated ?? "") || 0) || byName(a, b));
    case "popular":
    default:
      return arr.sort((a, b) =>
        (effDisc(b.manifest).installs ?? -1) - (effDisc(a.manifest).installs ?? -1) ||
        (Number(!!effDisc(b.manifest).featured) - Number(!!effDisc(a.manifest).featured)) ||
        byName(a, b));
  }
}

type BadgeKind = "staffpick" | "trending" | "new" | null;

/** The Extensions page — a marketplace/storefront: a sticky search + scope bar, a category-chip +
 *  sort rail, a rotating spotlight billboard, editorial shelves (Staff picks / Trending / New &
 *  updated / Installed by you), a filtered catalog grid, and an enriched detail overlay. */
export function ExtensionsBrowse() {
  const { extensions, setEnabled, ui, installFromUrl, removeExtension } = useExtensions();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "enabled">("all");
  const [category, setCategory] = useState<ExtCategory | "all">("all");
  const [sort, setSort] = useState<Sort>("popular");
  const [active, setActive] = useState<ExtInfo | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [installMsg, setInstallMsg] = useState("");
  const [installing, setInstalling] = useState(false);

  const iconFor = (m: ExtManifest) => (m.icon && ui.icons[m.icon]) || grid2x2;
  const query = q.trim().toLowerCase();
  const searching = query.length > 0;
  const match = (e: ExtInfo) => {
    if (!query) return true;
    const d = effDisc(e.manifest);
    return (
      e.manifest.name.toLowerCase().includes(query) ||
      (e.manifest.description ?? "").toLowerCase().includes(query) ||
      (d.tagline ?? "").toLowerCase().includes(query) ||
      (d.tags ?? []).some((t) => t.toLowerCase().includes(query))
    );
  };

  const searched = extensions.filter(match);
  const scoped = searched.filter((e) => scope === "all" || e.enabled);
  const enabledCount = extensions.filter((e) => e.enabled).length;

  // Landing = the full editorial storefront. Any search, scope, or category filter collapses it to
  // the catalog grid.
  const gridMode = searching || scope === "enabled" || category !== "all";

  // Category chip counts reflect what's reachable in the current search + scope.
  const catCount = (id: ExtCategory) => scoped.filter((e) => categoryOf(e.manifest) === id).length;

  // The grid list (filter region).
  const gridList = useMemo(() => {
    let list = scoped;
    if (category !== "all") list = list.filter((e) => categoryOf(e.manifest) === category);
    return sortItems(list, sort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions, q, scope, category, sort]);

  // Editorial shelves (landing only), all drawn from the searched+scoped set (which on the landing is
  // just every extension). Each shelf needs ≥3 distinct items to show; Trending excludes staff picks.
  const featured = sortItems(scoped.filter((e) => effDisc(e.manifest).featured), "popular").slice(0, 5);
  const staffPicks = sortItems(scoped.filter((e) => effDisc(e.manifest).staffPick), "popular");
  const staffIds = new Set(staffPicks.map((e) => e.manifest.id));
  const trending = sortItems(scoped.filter((e) => effDisc(e.manifest).installs != null && !staffIds.has(e.manifest.id)), "popular");
  const fresh = sortItems(scoped.filter((e) => effDisc(e.manifest).updated), "recent");
  const installed = extensions.filter((e) => e.source === "installed");

  // Keep the open detail in sync with live state (toggle/install/remove update `extensions`).
  const activeLive = active ? extensions.find((e) => e.manifest.id === active.manifest.id) ?? null : null;

  const card = (e: ExtInfo, badge: BadgeKind = null) => (
    <ExtStoreCard key={e.manifest.id} ext={e} icon={iconFor(e.manifest)} badge={badge}
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

  const clearFilters = () => { setQ(""); setScope("all"); setCategory("all"); };
  const filtersActive = searching || scope !== "all" || category !== "all";
  const metaLabel = searching
    ? `${gridList.length} result${gridList.length === 1 ? "" : "s"} for “${q.trim()}”`
    : category !== "all"
      ? `${CATEGORIES.find((c) => c.id === category)?.label ?? "Extensions"} · ${gridList.length} extension${gridList.length === 1 ? "" : "s"}`
      : `Enabled · ${gridList.length} extension${gridList.length === 1 ? "" : "s"}`;

  return (
    <div className="search-page ext-store">
      {/* Sticky control bar — title + count, search, scope, install-from-URL. */}
      <div className="ext-store-bar">
        <div className="ext-store-bar-title">
          <h2>Extensions</h2>
          <span className="field-hint">{extensions.length} · all free, first-party</span>
        </div>
        <div className="ext-store-bar-search">
          <Input iconLeft={searchIcon} shape="pill" placeholder="Search extensions…"
            value={q} onChange={(e) => setQ(e.currentTarget.value)} onClear={() => setQ("")} />
        </div>
        <div className="ext-store-bar-actions">
          <SegmentedControl
            options={[{ value: "all", label: `All ${extensions.length}` }, { value: "enabled", label: `On ${enabledCount}` }]}
            value={scope} onChange={(v) => setScope(v as "all" | "enabled")}
          />
          <Button variant={showInstall ? "primary" : "secondary"} icon={link2} onClick={() => setShowInstall((s) => !s)}>
            Install from URL
          </Button>
        </div>
        {showInstall && (
          <div className="ext-store-installrow">
            <div className="ext-market-url">
              <span className="ext-market-url-ic"><Icon icon={link2} size="sm" /></span>
              <Input className="ext-market-url-input" placeholder="https://…/extension.zip"
                value={installUrl} onChange={(e) => setInstallUrl(e.currentTarget.value)} onClear={() => setInstallUrl("")}
                onKeyDown={(e) => { if (e.key === "Enter") void doInstall(); }} />
              <Button variant="secondary" icon={plus} onClick={() => void doInstall()} disabled={installing || !installUrl.trim()}>
                {installing ? "Installing…" : "Install"}
              </Button>
            </div>
            {installMsg && <span className="field-hint">{installMsg}</span>}
          </div>
        )}
      </div>

      {/* Sticky category + sort rail. */}
      <div className="ext-filterrail">
        <div className="ext-filterrail-cats">
          <button className={`ext-cat-chip${category === "all" ? " is-active" : ""}`} onClick={() => setCategory("all")}>
            <Icon icon={grid2x2} size="xs" /> All {scoped.length}
          </button>
          {CATEGORIES.map((c) => (
            <button key={c.id} className={`ext-cat-chip${category === c.id ? " is-active" : ""}`} data-accent={c.accent}
              onClick={() => setCategory(c.id)} disabled={catCount(c.id) === 0}>
              <Icon icon={c.icon} size="xs" /> {c.label} {catCount(c.id)}
            </button>
          ))}
        </div>
        <div className="ext-sort" title="Sort">
          <Button variant="ghost" icon={arrowDownUp}>{SORTS.find((s) => s.id === sort)?.label}</Button>
          <select className="ext-sort-native" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort extensions">
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
      </div>

      {gridMode ? (
        gridList.length === 0 ? (
          <EmptyState
            title={searching ? `No extensions match “${q.trim()}”` : scope === "enabled" ? "Nothing enabled yet" : "No extensions here"}
            hint={scope === "enabled" ? "Enable one from the catalog to see it here." : "Try a different search or category."}
            onClear={filtersActive ? clearFilters : undefined}
          />
        ) : (
          <div className="home">
            <div className="ext-store-meta">
              <span>{metaLabel} · sorted by {SORTS.find((s) => s.id === sort)?.label.toLowerCase()}</span>
              {filtersActive && <button className="ext-store-clear" onClick={clearFilters}>Clear filters</button>}
            </div>
            <div className="ext-market-grid">{gridList.map((e) => card(e))}</div>
          </div>
        )
      ) : (
        // Landing: spotlight billboard + editorial shelves.
        <div className="home ext-store-shelves">
          {featured.length > 0 && (
            <ExtBillboard items={featured} iconFor={iconFor} dialogOpen={!!active}
              onOpen={(e) => setActive(e)} onToggle={(id, on) => setEnabled(id, on)} />
          )}
          {staffPicks.length >= 3 && (
            <div className="ext-rail"><PosterRow title="Staff picks" count={staffPicks.length}>{staffPicks.map((e) => card(e, "staffpick"))}</PosterRow></div>
          )}
          {trending.length >= 3 && (
            <div className="ext-rail"><PosterRow title="Trending" count={trending.length}>{trending.map((e) => card(e, "trending"))}</PosterRow></div>
          )}
          {fresh.length >= 3 && (
            <div className="ext-rail"><PosterRow title="New & updated" count={fresh.length}>{fresh.map((e) => card(e, "new"))}</PosterRow></div>
          )}
          {installed.length > 0 && (
            <div className="ext-rail"><PosterRow title="Installed by you" count={installed.length}>{installed.map((e) => card(e))}</PosterRow></div>
          )}
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

/** Shared empty/zero state. */
function EmptyState({ title, hint, onClear }: { title: string; hint: string; onClear?: () => void }) {
  return (
    <div className="empty">
      <div className="empty-inner">
        <span className="empty-glyph"><Icon icon={grid2x2} size="xl" /></span>
        <h3>{title}</h3>
        <p>{hint}</p>
        {onClear && <Button variant="secondary" onClick={onClear}>Clear filters</Button>}
      </div>
    </div>
  );
}

/** Truthful eyebrow chips shared by the card + billboard + detail. */
function TruthChips({ ext }: { ext: ExtInfo }) {
  const m = ext.manifest;
  return (
    <>
      {ext.source === "builtin" && <span className="ext-truth">Built-in</span>}
      {isVerified(m) && <span className="ext-truth ext-truth--verified"><Icon icon={shieldCheck} size="xs" /> Verified</span>}
      <span className="ext-truth">Free</span>
      <span className="ext-truth">v{m.version}</span>
    </>
  );
}

/** The card's single state affordance — Enable when off, Enabled (click to turn off) when on. */
function ExtCta({ enabled, name, onToggle }: { enabled: boolean; name: string; onToggle: (on: boolean) => void }) {
  return (
    <span className="ext-card-cta" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {enabled ? (
        <Button variant="ghost" icon={circleCheck} className="ext-cta-on" onClick={() => onToggle(false)} aria-label={`Disable ${name}`}>Enabled</Button>
      ) : (
        <Button variant="primary" icon={check} onClick={() => onToggle(true)} aria-label={`Enable ${name}`}>Enable</Button>
      )}
    </span>
  );
}

/** A storefront card — icon, name, publisher, tagline, contribution chips, micro-stats, state CTA. */
function ExtStoreCard({ ext, icon, badge, onOpen, onToggle }: {
  ext: ExtInfo; icon: string; badge: BadgeKind; onOpen: () => void; onToggle: (on: boolean) => void;
}) {
  const m = ext.manifest;
  const d = effDisc(m);
  const tagline = d.tagline || m.description || "";
  const tags = contributionTags(m.contributes).slice(0, 2);
  const installs = fmtInstalls(d.installs);
  const updated = relTime(d.updated);
  const BADGE: Record<NonNullable<BadgeKind>, { icon: string; label: string }> = {
    staffpick: { icon: award, label: "Staff pick" },
    trending: { icon: flame, label: "Trending" },
    new: { icon: sparkles, label: "New" },
  };
  return (
    <Card variant="outlined" padding="lg" className={`ext-card-shell ext-store-card-shell${ext.enabled ? " is-enabled" : ""}`}>
      <div className="ext-market-card ext-browse-card" role="button" tabIndex={0}
        onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
        <div className="ext-market-card-head">
          <span className="ext-card-ic ext-market-card-ic" data-accent={accentOf(m)}>
            <Icon icon={icon} size="lg" />
            {badge && <span className="ext-badge" data-kind={badge}><Icon icon={BADGE[badge].icon} size="xs" /></span>}
          </span>
          <div className="ext-market-card-title">
            <span className="ext-market-card-name">{m.name}</span>
            <span className="field-hint">{m.author || "GhostWire"} · v{m.version}</span>
          </div>
          <ExtCta enabled={ext.enabled} name={m.name} onToggle={onToggle} />
        </div>
        {tagline && <p className="field-hint ext-market-card-desc">{tagline}</p>}
        <div className="ext-market-card-tags">
          {ext.source === "builtin" && <Chip size="sm"><Icon icon={shieldCheck} size="xs" /> Built-in</Chip>}
          {tags.map((t) => <Chip key={t} size="sm">{t}</Chip>)}
        </div>
        {(d.rating != null || installs || updated) && (
          <div className="ext-card-stats field-hint">
            {d.rating != null && <span><Icon icon={star} size="xs" /> {d.rating.toFixed(1)}</span>}
            {installs && <span><Icon icon={download} size="xs" /> {installs}</span>}
            {updated && <span><Icon icon={trendingUp} size="xs" /> {updated}</span>}
          </div>
        )}
      </div>
    </Card>
  );
}

/** The rotating spotlight billboard for the featured set. */
function ExtBillboard({ items, iconFor, dialogOpen, onOpen, onToggle }: {
  items: ExtInfo[]; iconFor: (m: ExtManifest) => string; dialogOpen: boolean;
  onOpen: (e: ExtInfo) => void; onToggle: (id: string, on: boolean) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const i = items.length ? idx % items.length : 0;

  useEffect(() => { if (idx >= items.length) setIdx(0); }, [items.length, idx]);
  useEffect(() => {
    if (reduceMotion || paused || dialogOpen || items.length < 2) return;
    const h = window.setInterval(() => setIdx((v) => (v + 1) % items.length), 6000);
    return () => window.clearInterval(h);
  }, [reduceMotion, paused, dialogOpen, items.length]);

  if (!items.length) return null;
  const ext = items[i];
  const m = ext.manifest;
  const d = effDisc(m);
  const accent = accentOf(m);
  const highlights = (d.highlights && d.highlights.length ? d.highlights : contributionTags(m.contributes)).slice(0, 3);
  const go = (n: number) => setIdx((n + items.length) % items.length);

  return (
    <div className="ext-billboard" data-accent={accent}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)} onBlurCapture={() => setPaused(false)}>
      <div className="ext-billboard-accent" aria-hidden />
      <button className="ext-billboard-body" onClick={() => onOpen(ext)} aria-label={`${m.name} details`}>
        <span className="ext-card-ic ext-billboard-ic" data-accent={accent}><Icon icon={iconFor(m)} size="2xl" /></span>
        <span className="ext-billboard-text">
          <span className="ext-billboard-eyebrow"><TruthChips ext={ext} /></span>
          <span className="ext-billboard-title">{m.name}</span>
          <span className="ext-billboard-lead">{d.tagline || m.description}</span>
          {highlights.length > 0 && (
            <span className="ext-billboard-highlights">
              {highlights.map((h) => <span key={h} className="ext-bb-hl"><Icon icon={check} size="xs" /> {h}</span>)}
            </span>
          )}
        </span>
      </button>
      <div className="ext-billboard-actions" onClick={(e) => e.stopPropagation()}>
        {ext.enabled
          ? <span className="ext-bb-enabled"><Icon icon={circleCheck} size="sm" /> Enabled</span>
          : <Button variant="primary" icon={check} onClick={() => onToggle(m.id, true)}>Enable</Button>}
        <Button variant="secondary" onClick={() => onOpen(ext)}>Details</Button>
      </div>
      {items.length > 1 && (
        <>
          <button className="prow-arrow ext-bb-arrow ext-bb-arrow--l" aria-label="Previous" onClick={() => go(i - 1)}><Icon icon={chevronLeft} size="base" /></button>
          <button className="prow-arrow ext-bb-arrow ext-bb-arrow--r" aria-label="Next" onClick={() => go(i + 1)}><Icon icon={chevronRight} size="base" /></button>
          <div className="ext-billboard-dots">
            {items.map((it, n) => (
              <button key={it.manifest.id} className="ext-billboard-dot" aria-current={n === i} aria-label={`Slide ${n + 1}`} onClick={() => setIdx(n)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Detail overlay — highlights, full description, permission + contribution chips, enable toggle, the
 *  extension's own settings (when enabled), and a Remove action for installed extensions. */
function ExtensionDetail({ ext, icon, onClose, onToggle, onRemove }: {
  ext: ExtInfo | null; icon: string; onClose: () => void; onToggle: (on: boolean) => void; onRemove?: () => void;
}) {
  // Hook must run unconditionally — pass "" when nothing is selected.
  const hasSettings = useHasExtSettings(ext?.manifest.id ?? "");
  const m = ext?.manifest;
  const d = m ? effDisc(m) : undefined;
  const nets = m?.permissions?.network ?? [];
  const scopes = m?.permissions?.app ?? [];
  const updated = relTime(d?.updated);
  return (
    <Dialog open={!!ext} onClose={onClose} title={m?.name} size="lg" className="modal-wide">
      {ext && m ? (
        <div className="form-stack ext-detail">
          <div className="ext-detail-head">
            <span className="ext-card-ic ext-market-card-ic" data-accent={accentOf(m)}><Icon icon={icon} size="lg" /></span>
            <div className="ext-market-card-title">
              <span className="ext-market-card-name">{m.name}</span>
              <span className="field-hint">{m.author || "GhostWire"} · v{m.version} · {ext.source}{updated ? ` · updated ${updated}` : ""}</span>
            </div>
            <Toggle checked={ext.enabled} aria-label={`Enable ${m.name}`} onChange={(e) => onToggle(e.currentTarget.checked)} />
          </div>
          <div className="ext-detail-eyebrow"><TruthChips ext={ext} /></div>
          {(m.description || d?.tagline) && <p className="field-hint">{m.description || d?.tagline}</p>}
          {d?.highlights && d.highlights.length > 0 && (
            <ul className="ext-detail-highlights">
              {d.highlights.map((h) => <li key={h}><Icon icon={check} size="xs" /> {h}</li>)}
            </ul>
          )}
          <div className="ext-detail-chips">
            {contributionTags(m.contributes).map((t) => <Chip key={t} size="sm"><Icon icon={check} size="xs" /> {t}</Chip>)}
            {nets.map((h) => <Chip key={h} size="sm"><Icon icon={link2} size="xs" /> {h}</Chip>)}
            {scopes.map((s) => <Chip key={s} size="sm">{s}</Chip>)}
            {m.permissions?.storage && <Chip size="sm">stores data</Chip>}
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
