// Sleep Timer — a GhostWire reference extension.
//
// Auto-pauses playback after a chosen time, or at the end of the current episode. Exercises the
// playback event bus (for end-of-episode) + the gw.player control bridge (to pause). The timer lives
// in module scope so the host's deactivate() tears it down.
//
// It imports nothing — the app hands React, a UI kit, and `gw` to every render function.

let sleepTimer = null;
let sleepUntil = 0;      // epoch ms the timer fires (0 = none)
let endOfEpisode = false;
const listeners = new Set();
const notify = () => listeners.forEach((f) => { try { f(); } catch { /* ignore */ } });

export function activate(gw) {
  function cancel(silent) {
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = null;
    sleepUntil = 0;
    endOfEpisode = false;
    if (!silent) gw.toast("Sleep timer cancelled");
    notify();
  }
  function arm(minutes) {
    if (sleepTimer) clearTimeout(sleepTimer);
    endOfEpisode = false;
    sleepUntil = Date.now() + minutes * 60_000;
    sleepTimer = setTimeout(() => {
      gw.player.pause();
      gw.toast("Sleep timer — paused 😴");
      sleepTimer = null;
      sleepUntil = 0;
      notify();
    }, minutes * 60_000);
    gw.toast(`Sleep timer set: ${minutes} min`);
    notify();
  }
  function armEpisode() {
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = null;
    sleepUntil = 0;
    endOfEpisode = true;
    gw.toast("Sleep timer: pausing at end of episode");
    notify();
  }

  // End-of-episode: when armed, pause when the current item finishes.
  gw.onPlayback((ev) => {
    if (endOfEpisode && ev.state === "ended") {
      gw.player.pause();
      gw.toast("Sleep timer — episode ended 😴");
      endOfEpisode = false;
      notify();
    }
  });

  // ---- commands ----
  gw.registerCommand({ id: "sleep.30", label: "Sleep timer: 30 minutes", group: "Player", icon: "clock", keywords: "sleep timer pause", run: () => arm(30) });
  gw.registerCommand({ id: "sleep.60", label: "Sleep timer: 60 minutes", group: "Player", icon: "clock", keywords: "sleep timer pause", run: () => arm(60) });
  gw.registerCommand({ id: "sleep.episode", label: "Sleep timer: end of episode", group: "Player", icon: "clock", keywords: "sleep timer pause episode", run: () => armEpisode() });
  gw.registerCommand({ id: "sleep.cancel", label: "Sleep timer: cancel", group: "Player", icon: "x", keywords: "sleep timer cancel off", run: () => cancel() });

  // ---- settings ----
  const DURATIONS = [15, 30, 45, 60, 90, 120];
  gw.registerSettingsSection({
    id: "sleep.config",
    label: "Sleep Timer",
    icon: "clock",
    render: ({ React, ui }) => {
      const h = React.createElement;
      const [, force] = React.useReducer((x) => x + 1, 0);
      React.useEffect(() => {
        listeners.add(force);
        const iv = setInterval(force, 1000); // live countdown
        return () => { listeners.delete(force); clearInterval(iv); };
      }, []);

      const active = sleepTimer != null || endOfEpisode;
      let status = "No timer set.";
      if (endOfEpisode) status = "Will pause at the end of the current episode.";
      else if (sleepUntil > 0) {
        const rem = Math.max(0, Math.round((sleepUntil - Date.now()) / 1000));
        status = `Pausing in ${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, "0")}.`;
      }

      return h("div", { className: "settings-group", style: { display: "grid", gap: 12, maxWidth: 460 } },
        h("div", { className: "field-hint" }, "Pause playback after"),
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
          DURATIONS.map((m) => h("button", {
            key: m, className: "search-chip",
            style: (!endOfEpisode && sleepUntil > 0) ? undefined : undefined,
            onClick: () => arm(m),
          }, `${m} min`)),
        ),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
          h(ui.Button, { variant: "secondary", shape: "pill", size: "sm", icon: ui.icons.captions, onClick: () => armEpisode() }, "End of episode"),
          active && h(ui.Button, { variant: "ghost", shape: "pill", size: "sm", icon: ui.icons.x, onClick: () => cancel() }, "Cancel"),
        ),
        h("p", { style: { margin: 0, fontSize: 13, color: active ? "var(--gg-seafoam)" : "var(--gg-text-dim)" } }, status),
      );
    },
  });

  gw.log("Sleep Timer activated");
}

export function deactivate() {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  sleepUntil = 0;
  endOfEpisode = false;
}
