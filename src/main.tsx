import { isTauri } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

/** Set by vite.config.ts under `npm run tauri dev`; empty otherwise. */
declare const __LOGICA_DEBUGGER_URL__: string;

// Under `npm run tauri dev` the app lives in the Tauri window; a browser tab on
// the dev server shows the runtime debugger instead of a second copy of the app.
if (import.meta.env.DEV && __LOGICA_DEBUGGER_URL__ && !isTauri()) {
  void import("./debug/openDebugger").then((m) => m.openDebugger(__LOGICA_DEBUGGER_URL__));
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
