import { useEffect, useRef } from "react";

// Size-graded halftone, drawn on a <canvas> instead of CSS masks. Each dot's
// radius is computed directly from its distance to the top-left corner — LARGE
// at the corner, shrinking to small, then nothing past the falloff radius.
// Engine-independent (WKWebView renders multi-layer CSS `mask-composite`
// inconsistently, which flattened the mask-based gradient to uniform dots).
// Cool white -> brand-blue fill, matching GhostWire's halftone palette.

function draw(
  canvas: HTMLCanvasElement,
  maxR: number,
  minR: number,
  spacing: number,
) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const maxDist = Math.hypot(w, h) * 0.72; // falloff radius (no dots beyond)

  const grad = ctx.createLinearGradient(0, 0, w * 0.9, h * 0.9);
  grad.addColorStop(0, "rgba(226, 238, 255, 0.95)");
  grad.addColorStop(0.45, "rgba(165, 198, 255, 0.9)");
  grad.addColorStop(1, "rgba(140, 172, 248, 0.82)");
  ctx.fillStyle = grad;

  for (let y = spacing / 2; y < h; y += spacing) {
    for (let x = spacing / 2; x < w; x += spacing) {
      const d = Math.hypot(x, y);
      if (d >= maxDist) continue;
      const t = d / maxDist; // 0 at corner -> 1 at the edge
      // Power falloff (not linear): the radius drops FAST in the first stretch from the corner, so
      // the large→small change is obvious right where the splash is visible, then eases to minR.
      const r = minR + (maxR - minR) * Math.pow(1 - t, 2.2); // big at corner, small at edge
      ctx.globalAlpha = 1 - t * 0.35; // thin out toward the edge so the splash fades
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

export default function HalftoneCanvas({
  className,
  maxR = 1.8,
  minR = 0.22,
  spacing = 13,
}: {
  className?: string;
  maxR?: number;
  minR?: number;
  spacing?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let timer = 0;
    let tries = 0;
    // Draw SYNCHRONOUSLY (not via requestAnimationFrame, which a backgrounded /
    // occluded webview can throttle to a halt). Retry on a short timer until the
    // canvas is laid out (clientWidth 0 -> sized).
    const render = () => {
      if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
        if (tries++ < 30) timer = window.setTimeout(render, 16);
        return;
      }
      tries = 0;
      draw(canvas, maxR, minR, spacing);
    };
    render();
    const ro = new ResizeObserver(() => {
      tries = 0;
      render();
    });
    ro.observe(canvas);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [maxR, minR, spacing]);
  return <canvas ref={ref} className={className} aria-hidden />;
}
