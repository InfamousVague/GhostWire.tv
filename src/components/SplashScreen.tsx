import { useEffect, useRef, useState } from "react";

/**
 * Full-screen splash video played over the whole app on launch (desktop + iOS).
 * Muted + playsInline so it can autoplay with no user gesture (browser/WKWebView policy).
 * Dismisses when the clip ends, on tap, or after a safety timeout — so a stalled or
 * un-playable video never traps the user behind it. `/Splash.mp4` is bundled from public/.
 */
export function SplashScreen() {
  const [done, setDone] = useState(false);
  const [fading, setFading] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  function startDismiss() {
    setFading(true);
    window.setTimeout(() => setDone(true), 450); // let the fade finish, then unmount
  }

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.muted = true; // React's `muted` attr is unreliable; set it directly for autoplay
      v.play?.().catch(() => {});
    }
    // Never strand the user if the clip stalls / can't autoplay (max splash ~8s).
    const safety = window.setTimeout(startDismiss, 8000);
    return () => window.clearTimeout(safety);
  }, []);

  if (done) return null;
  return (
    <div
      onClick={startDismiss}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        background: "#000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: fading ? 0 : 1,
        transition: "opacity 450ms ease",
        pointerEvents: fading ? "none" : "auto",
      }}
    >
      <video
        ref={videoRef}
        src="/Splash.mp4"
        autoPlay
        muted
        playsInline
        onEnded={startDismiss}
        onError={startDismiss}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </div>
  );
}
