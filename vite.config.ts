import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Base UI is consumed as `file:../../Libs/base` (TS source), so Vite needs to be
// allowed to read it and must dedupe React to a single instance.
const baseDir = path.resolve(__dirname, "../../Libs/base");

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  //    (1420/1421 are used by a sibling app's preview; Ghosty's dev server lives on 1423)
  server: {
    port: 1423,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1424,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // 4. allow serving the linked Base design-system source from outside the project root
    fs: {
      allow: [path.resolve(__dirname), baseDir],
    },
  },
}));
