/**
 * The chat pipeline and its debug trace:
 *
 *   👤 User → Intent Module → Answer Agent → 💬 Answer
 *
 * Each step records what it received, what it produced and what it hands to
 * the next step, so the debug view can show the flow of one question.
 */
import type { MessageKey } from "../i18n";
import { buildPrompt } from "../ai/prompts";
import type { AIRequest } from "../ai/types";

export type StepId = "user" | "intent" | "agent" | "answer";
export const STEPS: readonly StepId[] = ["user", "intent", "agent", "answer"];

export type StepStatus = "waiting" | "running" | "done" | "error";

export interface TraceField {
  label: MessageKey;
  value: string;
}

export interface StepTrace {
  status: StepStatus;
  /** Milliseconds the step took. */
  ms?: number;
  input: TraceField[];
  output: TraceField[];
  next: TraceField[];
}

export type PipelineTrace = Record<StepId, StepTrace>;

export function emptyTrace(): PipelineTrace {
  const step = (): StepTrace => ({ status: "waiting", input: [], output: [], next: [] });
  return { user: step(), intent: step(), agent: step(), answer: step() };
}

/** The exact system and messages a provider receives for a request. */
export function promptText(request: AIRequest): string {
  const payload = buildPrompt(request);
  return [`[system]\n${payload.system}`, ...payload.messages.map((m) => `[${m.role}]\n${m.content}`)].join("\n\n");
}
