// Discord Presence — a GhostWire reference extension (native-sidecar showcase).
//
// Drives the gw_discord_sidecar (declared in this manifest's backend) via gw.invoke: as you watch,
// it pushes "Watching <title>" to your Discord Rich Presence. You supply your own Discord application
// Client ID (discord.com/developers/applications → your app → Application ID).
//
// It imports nothing — the app hands React, a UI kit, and `gw` to every render function.

let _gw = null;

export function activate(gw) {
  _gw = gw;
  const cfg = () => ({
    clientId: (gw.storage.get("clientId", "") || "").trim(),
    enabled: gw.storage.get("enabled", true),
    // Rich-presence art is an asset KEY you upload in the Discord Dev Portal (your app → Rich Presence
    // → Art Assets). Defaults to "ghostwire" — upload the GhostWire logo under that exact key to show
    // it. Leave blank for a text-only presence. (An unknown key just shows no image; it won't break it.)
    imageKey: (gw.storage.get("imageKey", "ghostwire") || "").trim(),
  });

  // Build the { details, state } presence lines for the current media. Video → "Watching <title>";
  // music → "🎵 <track>" / "by <artist>". Both fire because the music dock emits audio events too.
  function lines(ev) {
    if (ev.kind === "audio") {
      const paused = ev.state === "paused";
      const title = ev.title || "Unknown track";
      return {
        details: `${paused ? "⏸ " : "🎵 "}${title}`,
        state: ev.artist ? `by ${ev.artist}` : (ev.album || "Listening on GhostWire"),
      };
    }
    const paused = ev.state === "paused";
    const details = `${paused ? "Paused — " : "Watching "}${ev.show || ev.title}`;
    let state;
    if (ev.show && ev.episode != null) state = `S${String(ev.season || 1).padStart(2, "0")}E${String(ev.episode).padStart(2, "0")}`;
    else if (ev.year) state = `(${ev.year})`;
    else state = "via GhostWire";
    return { details, state };
  }

  async function setPresence(ev) {
    const { clientId, enabled, imageKey } = cfg();
    if (!enabled || !clientId) return;
    const { details, state } = lines(ev);
    try {
      await gw.invoke("set", {
        clientId,
        details: details.slice(0, 128),
        state: state.slice(0, 128),
        largeImage: imageKey || undefined,
        largeText: "GhostWire",
      });
    } catch (e) {
      gw.log("presence set failed (is Discord running?):", e);
    }
  }
  async function clearPresence() {
    try { await gw.invoke("clear", {}); } catch { /* ignore */ }
  }

  // Drive presence for BOTH video and music playback.
  gw.onPlayback((ev) => {
    if (ev.state === "ended") void clearPresence();
    else void setPresence(ev);
  });

  gw.registerSettingsSection({
    id: "discord.config",
    label: "Discord Presence",
    icon: "users",
    render: ({ React, ui }) => {
      const h = React.createElement;
      const [clientId, setClientId] = React.useState(() => gw.storage.get("clientId", ""));
      const [enabled, setEnabled] = React.useState(() => gw.storage.get("enabled", true));
      const [imageKey, setImageKey] = React.useState(() => gw.storage.get("imageKey", "ghostwire"));
      const [status, setStatus] = React.useState("");

      const saveId = (v) => { setClientId(v); gw.storage.set("clientId", v.trim()); };
      const saveImg = (v) => { setImageKey(v); gw.storage.set("imageKey", v.trim()); };
      const toggle = (v) => { setEnabled(v); gw.storage.set("enabled", v); if (!v) void clearPresence(); };
      const test = async () => {
        if (!clientId.trim()) { setStatus("Enter your Discord Application ID first."); return; }
        try {
          await gw.invoke("set", {
            clientId: clientId.trim(),
            details: "Browsing GhostWire",
            state: "Testing Rich Presence",
            largeImage: imageKey.trim() || undefined,
            largeText: "GhostWire",
          });
          setStatus("Sent! Check your Discord profile.");
        } catch (e) {
          setStatus(`Couldn't reach Discord: ${e && e.message ? e.message : e}. Is the Discord app running, and is the Application ID correct?`);
        }
      };

      return h("div", { className: "settings-group", style: { display: "grid", gap: 12, maxWidth: 480 } },
        h("label", { className: "settings-row", style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 } },
          h("div", null,
            h("div", { style: { fontWeight: 600, fontSize: 13 } }, "Show what I'm watching"),
            h("div", { className: "field-hint" }, "Updates your Discord status as you play.")),
          h(ui.Toggle, { checked: enabled, onChange: (e) => toggle(e.currentTarget.checked) })),
        h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Discord Application (Client) ID"),
          h(ui.Input, { shape: "pill", value: clientId, iconLeft: ui.icons.users, placeholder: "From discord.com/developers/applications",
            onChange: (e) => saveId(e.currentTarget.value), onClear: () => saveId("") })),
        h("div", null,
          h("div", { className: "field-hint", style: { marginBottom: 4 } }, "Logo image key (optional)"),
          h(ui.Input, { shape: "pill", value: imageKey, placeholder: "ghostwire",
            onChange: (e) => saveImg(e.currentTarget.value), onClear: () => saveImg("") })),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
          h(ui.Button, { variant: "secondary", shape: "pill", size: "sm", onClick: test }, "Test presence"),
          status && h("span", { className: "field-hint" }, status)),
        h("p", { className: "field-hint", style: { margin: 0 } },
          "Create an app at discord.com/developers/applications and copy its Application ID here (no secret needed). " +
          "Shows what you're watching AND the music you're playing. For the logo, upload the GhostWire image in your app's " +
          "Rich Presence → Art Assets with the key above (\"ghostwire\"). The Discord desktop app must be running, and " +
          "Discord → Settings → Activity Privacy → \"Share your detected activities\" must be on."),
      );
    },
  });

  gw.log("Discord Presence activated");
}

export function deactivate() {
  try { _gw?.invoke("clear", {}).catch(() => {}); } catch { /* ignore */ }
  _gw = null;
}
