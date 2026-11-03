import { create } from "zustand";

export type SettingsTab = "ai" | "editor" | "latex";

interface UIState {
  settingsOpen: boolean;
  settingsTab: SettingsTab;
}

export const useUI = create<UIState>()(() => ({ settingsOpen: false, settingsTab: "ai" }));

export function openSettings(tab: SettingsTab = "ai") {
  useUI.setState({ settingsOpen: true, settingsTab: tab });
}

export function closeSettings() {
  useUI.setState({ settingsOpen: false });
}
