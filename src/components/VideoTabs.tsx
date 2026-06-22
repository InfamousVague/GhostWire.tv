import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { tv, clapperboard, anime as animeIcon, circlePlay } from "../lib/icons";
import "./VideoTabs.css";

export type VideoTab = "tvshows" | "movies" | "anime" | "youtube";

const TABS: { value: VideoTab; label: string; icon: string }[] = [
  { value: "tvshows", label: "TV Shows", icon: tv },
  { value: "movies", label: "Movies", icon: clapperboard },
  { value: "anime", label: "Anime", icon: animeIcon },
  { value: "youtube", label: "YouTube", icon: circlePlay },
];

/** Icon segmented toggle for the unified Videos section (TV Shows · Movies · Anime). */
export function VideoTabs({ value, onChange }: { value: VideoTab; onChange: (v: VideoTab) => void }) {
  return (
    <div className="vid-tabs" role="tablist" aria-label="Video categories">
      {TABS.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          className={`vid-tab${value === t.value ? " active" : ""}`}
          onClick={() => value !== t.value && onChange(t.value)}
        >
          <Icon icon={t.icon} size="sm" />
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}
