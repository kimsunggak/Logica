import { useEffect, useState } from "react";
import { clearChat } from "./chat/chatStore";
import { Notices } from "./components/Notices";
import { TopBar, chooseAndOpenProject } from "./components/TopBar";
import { openSettings } from "./components/uiStore";
import { Welcome } from "./components/Welcome";
import { Workspace } from "./components/Workspace";
import { editorSession } from "./editor/editorSession";
import { rejectInlineEdit, useInlineEdit } from "./editor/inlineEdit/inlineEditStore";
import { installEditorExtensions } from "./editor/setupEditor";
import { confirmDialog, isDesktop } from "./lib/backend";
import {
  checkExternalChanges,
  connectEditorSession,
  openProject,
  rebuildDocumentNow,
  refreshFileList,
  saveActive,
  saveAll,
} from "./project/projectActions";
import { useProject } from "./project/projectStore";
import { refreshAllConnections } from "./settings/connectionStore";
import { SettingsDialog } from "./settings/SettingsDialog";
import { useSettings } from "./settings/settingsStore";
import { loadPersistedState, startPersistence } from "./storage/persistence";
import { useWorkspace } from "./storage/workspaceStore";
import { t } from "./i18n";

const EXTERNAL_CHECK_INTERVAL_MS = 3000;

function useDarkMode(): boolean {
  const theme = useSettings((s) => s.editor.theme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return theme === "dark" || (theme === "system" && systemDark);
}

export default function App() {
  const [ready, setReady] = useState(false);
  const root = useProject((s) => s.root);
  const editorSettings = useSettings((s) => s.editor);
  const dark = useDarkMode();

  // Startup: restore state, wire the editor, reopen the last project.
  useEffect(() => {
    let stopPersistence: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      installEditorExtensions();
      connectEditorSession();
      await loadPersistedState();
      if (cancelled) return;
      stopPersistence = startPersistence();
      setReady(true);
      void refreshAllConnections();
      const last = useWorkspace.getState().lastProject;
      if (last) await openProject(last);
    })();
    return () => {
      cancelled = true;
      stopPersistence?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    editorSession.setConfig({ dark, ...editorSettings });
  }, [dark, editorSettings]);

  const language = useSettings((s) => s.ui.language);
  useEffect(() => {
    document.documentElement.lang = language;
    // Outline warnings are produced while parsing; parse again in the new language.
    rebuildDocumentNow();
  }, [language]);

  // A new project starts with a clean AI state.
  useEffect(() => {
    if (useInlineEdit.getState().open) rejectInlineEdit();
    clearChat();
  }, [root]);

  // Pick up changes made by other programs (Git, another editor, ...).
  useEffect(() => {
    if (!root) return;
    const onFocus = () => {
      void refreshFileList();
      void checkExternalChanges();
    };
    const timer = setInterval(() => {
      if (document.hasFocus()) void checkExternalChanges();
    }, EXTERNAL_CHECK_INTERVAL_MS);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [root]);

  // Shortcuts that work outside the editor too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "o" && !e.shiftKey) {
        e.preventDefault();
        void chooseAndOpenProject();
      } else if (e.key === ",") {
        e.preventDefault();
        openSettings();
      } else if (e.key.toLowerCase() === "l" && e.shiftKey) {
        e.preventDefault();
        const { showChat } = useWorkspace.getState().layout;
        useWorkspace.getState().updateLayout({ showChat: !showChat });
      } else if (e.key.toLowerCase() === "s" && !editorSession.getView()?.hasFocus) {
        // The editor has its own binding; elsewhere (buttons, panels) save too.
        e.preventDefault();
        void (e.shiftKey ? saveAll() : saveActive());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ask before closing the window with unsaved edits.
  useEffect(() => {
    const hasDirty = () => useProject.getState().openFiles.some((f) => f.dirty);
    if (!isDesktop()) {
      const onBeforeUnload = (e: BeforeUnloadEvent) => {
        if (hasDirty()) e.preventDefault();
      };
      window.addEventListener("beforeunload", onBeforeUnload);
      return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const stop = await getCurrentWindow().onCloseRequested(async (event) => {
        if (hasDirty() && !(await confirmDialog(t("project.unsavedQuit")))) event.preventDefault();
      });
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      {ready && root ? <Workspace /> : <Welcome />}
      <SettingsDialog />
      <Notices />
    </div>
  );
}
