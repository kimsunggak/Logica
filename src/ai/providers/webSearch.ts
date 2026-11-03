/**
 * Shared pieces of the providers' built-in web search: the cited pages and the
 * hint added when a request that offered search is rejected.
 */
import { AIError } from "../errors";
import { t } from "../../i18n";
import type { WebSource } from "../types";

/** Web pages in the order first seen, one per URL. */
export class SourceList {
  private readonly byUrl = new Map<string, WebSource>();

  add(url: unknown, title?: unknown): void {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    const known = this.byUrl.get(url);
    const name = typeof title === "string" && title.trim() ? title.trim() : undefined;
    if (!known) this.byUrl.set(url, name ? { url, title: name } : { url });
    else if (!known.title && name) known.title = name;
  }

  get size(): number {
    return this.byUrl.size;
  }

  list(): WebSource[] {
    return [...this.byUrl.values()];
  }
}

/** A rejected request that offered web search may be rejected for the search itself (e.g. turned off for the organization). */
export function withSearchHint(err: unknown): unknown {
  if (!(err instanceof AIError) || err.kind !== "bad_request") return err;
  return new AIError(err.kind, `${err.message}\n${t("ai.err.webSearch")}`, { provider: err.provider, status: err.status });
}
