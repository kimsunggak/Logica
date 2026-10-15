/**
 * Judge prompt: the Chat Orchestrator's own model call. It decides what
 * happens with a message (reply directly, answer, or refine first) from the
 * message, the editor location and the recent conversation. It does not
 * see the paper.
 */
import type { AIRequest } from "../types";
import { ANSWER_QUESTION, REFINE_QUESTION } from "../tools/chatTools";
import { formatContext, tag } from "./context";
import type { PromptPayload } from "./index";

const JUDGE_RULES = [
  "You are the Chat Orchestrator of LOGICA, a LaTeX writing tool for research papers. For each user message you decide what happens next. You cannot see the paper; your two tools can.",
  "Choose exactly one:",
  "1. Small talk, thanks, a greeting, or a message that is not about the paper or writing it: reply yourself in one or two short sentences, in the language of the user's message. Do not call a tool.",
  `2. A clear question or request about the paper: call ${ANSWER_QUESTION}. Clear means it says what it is about (a section, figure, table, equation, term or claim, or the selected text or cursor paragraph) and what is wanted, so it can be answered as written. An edit request is clear when it says what to change and where.`,
  `3. Any other message about the paper, such as an abstract, vague or broad one, or one with several possible readings: call ${REFINE_QUESTION}.`,
  `When unsure between 2 and 3, call ${REFINE_QUESTION}. Never answer a question about the paper yourself.`,
].join("\n");

const CLIP = { text: 1500, turn: 600 };
/** Earlier messages the judge sees (to resolve follow-up messages). */
export const JUDGE_HISTORY_MESSAGES = 4;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildJudgePrompt(request: AIRequest): PromptPayload {
  const location = formatContext(request.context, ["currentFile", "currentSection"]);
  const history = (request.history ?? [])
    .slice(-JUDGE_HISTORY_MESSAGES)
    .filter((m) => m.content.trim())
    .map((m) => `${m.role}: ${clip(m.content, CLIP.turn)}`)
    .join("\n");
  const content = [
    location ? tag("editor_location", location) : "",
    request.selectedText
      ? tag("selected_text", clip(request.selectedText, CLIP.text))
      : request.context.currentParagraph
        ? tag("cursor_paragraph", clip(request.context.currentParagraph, CLIP.text))
        : "",
    history ? tag("recent_conversation", history) : "",
    tag("user_message", request.instruction),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: JUDGE_RULES, messages: [{ role: "user", content }] };
}
