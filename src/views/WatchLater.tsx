import { useEffect, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Input } from "@mattmattmattmatt/base/primitives/input/Input";
import { Button } from "@mattmattmattmatt/base/primitives/button/Button";
import { clock, plus, search as searchIcon, download, x } from "../lib/icons";
import { addToWatchLater, getWatchLater, removeFromWatchLater, subscribeWatchLater } from "../lib/watchLater";

/** Watch Later — a native always-on view (baked in from the former extension): a personal queue of
 *  titles to watch, persisted via the `watch_later` setting. Reads/writes through the shared
 *  watchLater store so the right-click "Add to Watch Later" menu actions and this view agree. */
export function WatchLater({ onAddMagnet, onNavigate }: { onAddMagnet: (m: string) => void; onNavigate: (id: string) => void }) {
  const [items, setItems] = useState(getWatchLater);
  const [draft, setDraft] = useState("");

  useEffect(() => subscribeWatchLater(() => setItems(getWatchLater())), []);

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    setDraft("");
    addToWatchLater({ title: t });
  };
  const remove = (id: string) => removeFromWatchLater(id);

  return (
    <div className="section-stack" style={{ maxWidth: 720, minHeight: "100%", display: "flex", flexDirection: "column" }}>
      <div className="cat-header">
        <span className="cat-title section-title"><Icon icon={clock} size="base" /> Watch Later</span>
        {items.length > 0 && <span className="cat-sub">{items.length} item{items.length === 1 ? "" : "s"}</span>}
      </div>
      <div className="search-bar-lg">
        <Input
          shape="pill" size="lg" value={draft} iconLeft={clock}
          placeholder="Add a title to watch later…"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          onClear={() => setDraft("")}
        />
        <Button variant="primary" shape="pill" size="lg" icon={plus} onClick={add} disabled={!draft.trim()}>Add</Button>
      </div>
      {items.length === 0 ? (
        <div className="empty" style={{ flex: 1 }}>
          <div className="empty-inner">
            <span className="empty-glyph"><Icon icon={clock} size="xl" /></span>
            <h3>Nothing saved yet</h3>
            <p>Add titles here, then find them under Discover when you're ready to watch.</p>
          </div>
        </div>
      ) : (
        <div className="track-list" style={{ width: "100%" }}>
          {items.map((it) => (
            <div key={it.id} className="track-row">
              <span className="track-name" title={it.title}>{it.title}</span>
              {it.magnet && (
                <button className="track-play" title="Download" onClick={() => onAddMagnet(it.magnet!)}>
                  <Icon icon={download} size="sm" />
                </button>
              )}
              <button className="track-play" title="Find it on Discover" onClick={() => onNavigate("discover")}>
                <Icon icon={searchIcon} size="sm" />
              </button>
              <button className="track-like" title="Remove" onClick={() => remove(it.id)}>
                <Icon icon={x} size="sm" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
