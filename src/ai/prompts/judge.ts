/** Auto-only intent routing. Source selection belongs to execution preparation. */
import type { AIRequest } from "../types";
import { CLARIFY_REQUEST, ROUTE_CHAT, ROUTE_EDIT } from "../tools/chatTools";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { conversationBlock, SESSION_RULES, summaryBlock } from "./session";

const JUDGE_RULES = [
  "You are the Auto Router of LOGICA's Paper Orchestra. The UI is in Auto mode. Classify intent by calling exactly one tool. Never answer or select sections.",
  "You do not see the paper's text. <paper_map>, when present, lists its sections in reading order, each with its key, title, word count, labels and summary.",
  `Call ${ROUTE_CHAT} for explanations, questions, evaluations, hypothetical changes, greetings, thanks, or guidance that does not request manuscript changes.`,
  `Call ${ROUTE_EDIT} only for an explicit request to modify manuscript content, including clear contextual approval of a previously proposed edit.`,
  `Call ${CLARIFY_REQUEST} if it is unclear whether the user wants a discussion or actual manuscript changes.`,
  "Read the original user_message together with refined_request and history. The original message is authoritative if the rewrite changes its intent. Preserve negation and scope.",
].join("\n");

/** The paper map: every section with its summary, to choose what to read word for word. */
export function paperMapBlock(request: AIRequest): string {
  const map = request.paperMap;
  if (!map?.length) return "";
  const listed = map.filter((e) => !e.always);
  const summarized = listed.filter((e) => e.summary).length;
  const lines = map.map((e) => {
    const head = `${"  ".repeat(e.depth)}[${e.key}] ${e.title} (${e.words} ${e.words === 1 ? "word" : "words"})`;
    const labels = e.labels.length ? ` | labels: ${e.labels.join(", ")}` : "";
    // A summary has one sentence per line; the map keeps one line per section.
    const summary = e.summary?.replace(/\s*\n\s*/g, " ");
    if (e.always) return `${head}: ${summary ? `${summary} (always read word for word)` : "always read word for word"}${labels}`;
    if (!summarized) return `${head}${labels}`;
    return `${head}: ${summary ?? "no summary yet, read word for word"}${labels}`;
  });
  return `<paper_map summaries="${summarized ? `${summarized}/${listed.length}` : "none"}">\n${lines.join("\n")}\n</paper_map>`;
}

export function buildJudgePrompt(request: AIRequest): PromptPayload {
  // The conversation so far, then the paper, then the message to route.
  const content = [summaryBlock(request), conversationBlock(request), paperMapBlock(request), tag("user_message", request.instruction), tag("refined_request", request.refinedQuestion ?? "")]
    .filter(Boolean)
    .join("\n\n");
  return { system: `${JUDGE_RULES}\n\n${SESSION_RULES}`, messages: [{ role: "user", content }] };
}
