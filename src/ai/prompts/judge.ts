/**
 * Judge prompt: the Chat Orchestrator's own model call. It picks the route
 * of a message (reply, answer, or refine first) by calling one tool, from the
 * message, the open file and the recent conversation. It does not see the
 * paper and writes no text for the user.
 */
import type { AIRequest } from "../types";
import { ANSWER_QUESTION, REFINE_QUESTION, REPLY_DIRECTLY } from "../tools/chatTools";
import { formatContext, tag } from "./context";
import type { PromptPayload } from "./index";

const JUDGE_RULES = [
  "You are the Chat Orchestrator of LOGICA, a LaTeX writing tool for research papers. For each user message you choose what happens next by calling exactly one tool. You cannot see the paper, and you never write the answer yourself.",
  "Choose exactly one:",
  `1. Small talk, thanks, a greeting, or a message that is not about the paper or writing it: call ${REPLY_DIRECTLY}.`,
  `2. A clear question or request about the paper: call ${ANSWER_QUESTION}. Clear means it says what it is about (a section, figure, table, equation, term or claim) and what is wanted, so it can be answered as written. An edit request is clear when it says what to change and where.`,
  `3. Any other message about the paper, such as an abstract, vague or broad one, or one with several possible readings: call ${REFINE_QUESTION}.`,
  `When unsure between 2 and 3, call ${REFINE_QUESTION}.`,
  "In reason, say why this route fits the message and the other two do not.",
].join("\n");

const CLIP = { turn: 600 };
/** Earlier messages the judge sees (to resolve follow-up messages). */
export const JUDGE_HISTORY_MESSAGES = 4;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildJudgePrompt(request: AIRequest): PromptPayload {
  const location = formatContext(request.context, ["currentFile"]);
  const history = (request.history ?? [])
    .slice(-JUDGE_HISTORY_MESSAGES)
    .filter((m) => m.content.trim())
    .map((m) => `${m.role}: ${clip(m.content, CLIP.turn)}`)
    .join("\n");
  const content = [
    location ? tag("editor_location", location) : "",
    history ? tag("recent_conversation", history) : "",
    tag("user_message", request.instruction),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: JUDGE_RULES, messages: [{ role: "user", content }] };
}
