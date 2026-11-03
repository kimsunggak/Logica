import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "./settingsStore";

describe("mergeSettings", () => {
  it("turns live preview on by default and drops retired LaTeX settings", () => {
    const merged = mergeSettings({ latex: { autoCompile: false, timeoutSecs: 60 } });
    expect(merged.latex.livePreview).toBe(true);
    expect(merged.latex.timeoutSecs).toBe(60);
    expect("autoCompile" in merged.latex).toBe(false);
  });

  it("keeps a saved live preview choice", () => {
    expect(mergeSettings({ latex: { livePreview: false } }).latex.livePreview).toBe(false);
    expect(mergeSettings(null).latex).toEqual(DEFAULT_SETTINGS.latex);
  });

  it("adds the chat text size to older settings and ignores an unusable one", () => {
    expect(mergeSettings({ editor: { fontSize: 16 } }).editor).toMatchObject({ fontSize: 16, chatFontSize: 14 });
    expect(mergeSettings({ editor: { chatFontSize: 16 } }).editor.chatFontSize).toBe(16);
    expect(mergeSettings({ editor: { chatFontSize: 99 } }).editor.chatFontSize).toBe(14);
    expect(mergeSettings({ editor: { chatFontSize: "big" } }).editor.chatFontSize).toBe(14);
  });
});
