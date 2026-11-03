import { describe, expect, it } from "vitest";
import { useSettings } from "../settings/settingsStore";
import { messages } from "./messages";
import { t, translate } from "./index";

describe("i18n", () => {
  it("fills placeholders and leaves unknown ones", () => {
    expect(translate("en", "status.position", { line: 3, column: 7 })).toBe("Ln 3, Col 7");
    expect(translate("ko", "status.position", { line: 3, column: 7 })).toBe("3행, 7열");
    expect(translate("en", "settings.compileCommandHint")).toContain("{main}");
  });

  it("defines every key in Korean with the same placeholders", () => {
    for (const key of Object.keys(messages.en) as (keyof typeof messages.en)[]) {
      const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(messages.ko[key], key).toBeTruthy();
      expect(names(messages.ko[key]), key).toEqual(names(messages.en[key]));
    }
  });

  it("follows the language setting", () => {
    useSettings.getState().updateUI({ language: "ko" });
    expect(t("top.save")).toBe("저장");
    useSettings.getState().updateUI({ language: "en" });
    expect(t("top.save")).toBe("Save");
  });
});
