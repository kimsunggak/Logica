/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// `npm run tauri dev` starts this server with TAURI_ENV_* set. The app then runs
// in the Tauri window, and a browser tab on this server opens the runtime
// debugger the Rust app serves (src-tauri/src/debug_trace.rs).
const debuggerUrl = process.env.TAURI_ENV_PLATFORM ? `http://127.0.0.1:${process.env.LOGICA_DEBUG_PORT || 1430}` : "";

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  define: { __LOGICA_DEBUGGER_URL__: JSON.stringify(debuggerUrl) },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4096,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
});
