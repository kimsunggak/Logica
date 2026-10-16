/**
 * Summary Module prompt: fold the oldest turns of the conversation into the
 * session summary (L1) by calling `update_summary` with the changes. It runs
 * in the background every two turns and does not see the paper, only its
 * outline.
 */
import type { AIRequest } from "../types";
import { UPDATE_SUMMARY } from "../tools/summaryTools";
import { formatContext, tag } from "./context";
import type { PromptPayload } from "./index";

const SUMMARY_RULES = [
  "You are the Summary Module of LOGICA, a LaTeX writing tool for research papers. You keep the session summary of a chat between a researcher and LOGICA.",
  "The chat modules read this summary instead of the turns folded into it, so keep what they need to continue the conversation.",
  "<current_summary> holds the summary so far, with item ids. <turns_to_fold> holds the turns to fold into it now, oldest first; the turns after them stay in the conversation word for word.",
  `Call ${UPDATE_SUMMARY} once with the changes these turns bring. List only changes; never restate items that stay as they are.`,
  "- set_goal: the paper's topic and what the user is working on now, in one or two sentences. Only when it is missing or changed.",
  "- add preference: something the user wants from every later answer: style, length, language, tone, terms, formatting, or a standing requirement. Not a one-off request about a single answer.",
  "- replace: the user changed an earlier preference or reference; give its id and the new text.",
  "- add topic: one line per answered turn saying what it dealt with (the section, figure, table, problem or question). Skip small talk.",
  "- add reference: material from outside the paper the user gave in a turn (reviewer comments, text of another paper, data), copied word for word, up to 1500 characters. Not the paper's own text.",
  "- close: an item U# that a turn in <turns_to_fold> settled, with how. Items U# are added for you: the answers marked [answer stopped by the user], [answer failed] or [answer cut off at the length limit], and questions LOGICA asked back.",
  "Write the text in the language the user writes in. Set fields an operation does not use to \"\" and turn to 0.",
].join("\n");

export function buildSummaryPrompt(request: AIRequest): PromptPayload {
  const turns = (request.foldTurns ?? []).map((turn) => `<turn number="${turn.index}">\nuser: ${turn.question}\nassistant: ${turn.answer}\n</turn>`);
  const content = [
    formatContext(request.context, ["outline"]),
    tag("current_summary", request.sessionSummary || "(empty)"),
    tag("turns_to_fold", turns.join("\n")),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: SUMMARY_RULES, messages: [{ role: "user", content }] };
}
