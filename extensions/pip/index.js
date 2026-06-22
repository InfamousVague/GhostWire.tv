// Picture-in-Picture — a GhostWire reference extension.
//
// Proves the gw.player control bridge: a single ⌘K command pops the playing video into a floating
// PiP window. It imports nothing — the app hands React, a UI kit, and `gw` to every render function.

export function activate(gw) {
  gw.registerCommand({
    id: "pip.toggle",
    label: "Picture-in-Picture",
    group: "Player",
    icon: "airplay",
    keywords: "pip mini player float pop out popout floating",
    run: () => {
      const now = gw.player.current();
      if (!now || now.kind !== "video") {
        gw.toast("Start a video first to pop it out");
        return;
      }
      gw.player.pictureInPicture();
    },
  });
  gw.log("Picture-in-Picture activated");
}
