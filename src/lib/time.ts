import { currentLanguage, t } from "../i18n";

/** "3 hours ago" / "3시간 전" in the UI language; "just now" under a minute. */
export function timeAgo(ms: number | undefined): string {
  if (!ms) return "";
  const rtf = new Intl.RelativeTimeFormat(currentLanguage(), { numeric: "auto" });
  const seconds = Math.round((ms - Date.now()) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  return t("home.justNow");
}
