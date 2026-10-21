/**
 * Provider-independent prompt construction. Adapters convert the resulting
 * payload into their own message format.
 */
import type { AIMessage, AIRequest, AITask } from "../types";
import { buildAnswerPrompt } from "./answer";
import { buildJudgePrompt } from "./judge";
import { buildRefinePrompt } from "./refine";
import { buildReplyPrompt } from "./reply";
import { buildSectionSummaryPrompt } from "./sectionSummary";
import { buildSummaryPrompt } from "./summary";
import { buildInlineEditPrompt } from "./rewrite";

export interface PromptPayload {
  system: string;
  messages: AIMessage[];
}

/** Merge consecutive messages of the same role (required by some APIs). */
function normalizeMessages(messages: AIMessage[]): AIMessage[] {
  const out: AIMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else out.push({ ...m });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

const BUILDERS: Record<AITask, (request: AIRequest) => PromptPayload> = {
  "inline-edit": buildInlineEditPrompt,
  judge: buildJudgePrompt,
  reply: buildReplyPrompt,
  refine: buildRefinePrompt,
  answer: buildAnswerPrompt,
  summary: buildSummaryPrompt,
  sections: buildSectionSummaryPrompt,
};

export function buildPrompt(request: AIRequest): PromptPayload {
  const payload = BUILDERS[request.task](request);
  return { system: payload.system, messages: normalizeMessages(payload.messages) };
}

export { INLINE_COMMANDS, type InlineCommand } from "./presets";
