/**
 * Judge prompt: the Chat Orchestrator's own model call. It picks the route
 * of a message (reply, answer, or refine first) by calling one tool, from the
 * session summary, the last four turns, the paper map and the message. With
 * the answer and refine routes it names the sections the next step reads
 * word for word. It does not see the paper's text and writes no text for the
 * user.
 */
import type { AIRequest } from "../types";
import { ALL_SECTIONS, ANSWER_QUESTION, REFINE_QUESTION, REPLY_DIRECTLY } from "../tools/chatTools";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { conversationBlock, SESSION_RULES, summaryBlock } from "./session";

const JUDGE_RULES = [
  "You are the Chat Orchestrator of LOGICA, a LaTeX writing tool for research papers. For each user message you choose what happens next by calling exactly one tool. You never write the answer yourself.",
  "You do not see the paper's text. <paper_map>, when present, lists its sections in reading order, each with its key, title, word count, labels and summary.",
  "Choose exactly one:",
  `1. Small talk, thanks, a greeting, or a message that is not about the paper or writing it: call ${REPLY_DIRECTLY}.`,
  `2. A clear question or request about the paper: call ${ANSWER_QUESTION}. Clear means it says what it is about (a section, figure, table, equation, term or claim) and what is wanted, so it can be answered as written. An edit request is clear when it says what to change and where.`,
  `3. Any other message about the paper, such as an abstract, vague or broad one, or one with several possible readings: call ${REFINE_QUESTION}.`,
  `When unsure between 2 and 3, call ${REFINE_QUESTION}.`,
  "In reason, say why this route fits the message and the other two do not.",
  `With ${ANSWER_QUESTION} or ${REFINE_QUESTION}, list in sections the keys of the sections the next step must read word for word: the parts the message is about, every section an edit would change, and sections whose exact wording, numbers, equations or tables the answer needs. The other sections are given as their summaries; sections marked as always read are given word for word anyway. Leave sections empty when the summaries are enough. Use ["${ALL_SECTIONS}"] only when the message needs the whole paper, such as a review of the whole paper or a check across all of its sections. With summaries="none", or without a map, leave sections empty: the whole paper is read.`,
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
  const content = [summaryBlock(request), conversationBlock(request), paperMapBlock(request), tag("user_message", request.instruction)]
    .filter(Boolean)
    .join("\n\n");
  return { system: `${JUDGE_RULES}\n\n${SESSION_RULES}`, messages: [{ role: "user", content }] };
}
