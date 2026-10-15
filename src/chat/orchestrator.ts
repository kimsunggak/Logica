/**
 * Chat Orchestrator: the agent that runs one chat turn.
 *
 *   👤 User → Chat Orchestrator ─┬─ (small talk) reply directly ───────────────────→ 💬
 *                                ├─ answer_question → Answer Module ───────────────→ 💬
 *                                └─ refine_question → Refine Module → Answer Module → 💬
 *                                                                 └─ (still unclear) ask back → 💬
 *
 * Its judge model picks the route by calling a tool, or by replying itself.
 * The Refine and Answer modules are the tools: each builds its own request
 * and makes one model call. Every model call goes through the LLM Gateway
 * (model choice, Claude fallback). In development each step is reported to
 * the runtime debugger (see `src/debug/trace.ts`).
 */
import { parseRefine, type RefineResult } from "../ai/agent/refine";
import { callModel, type GatewayOptions, type GatewayResult, type RunControl } from "../ai/gateway";
import type { ModelChoice } from "../ai/models/modelConfig";
import { JUDGE_HISTORY_MESSAGES } from "../ai/prompts/judge";
import { ANSWER_QUESTION, CHAT_TOOLS, REFINE_QUESTION } from "../ai/tools/chatTools";
import type { AIContext, AIMessage, AIResponse, AIUsage, FinishReason, ProjectFile } from "../ai/types";
import { step, traced, type Span } from "../debug/trace";

/** What the judge chose: reply itself, answer, or refine first. */
export type Route = "reply" | "answer" | "refine";
/** How the turn ended: a direct reply, an answer, or a question back to the user. */
export type Outcome = "reply" | "answer" | "clarify";
export type Stage = "judge" | "refine" | "answer";

export interface Turn {
  id: string;
  instruction: string;
  selectedText?: string;
  context: AIContext;
  /** Earlier question and answer pairs. */
  history: AIMessage[];
  activePath?: string;
}

export interface Paper {
  files: ProjectFile[];
  omitted: string[];
  budget: number;
}

export interface TurnHooks {
  onStage?: (stage: Stage) => void;
  onRefined?: (question: string) => void;
  /** Answer text as it streams in. */
  onText?: (full: string) => void;
  /** Before every model call, with the model it uses. */
  onModel?: (choice: ModelChoice, fallback: boolean) => void;
}

export interface TurnResult {
  route: Route;
  outcome: Outcome;
  /** Why the judge chose its tool. */
  reason?: string;
  refined?: string;
  /** The text to show. */
  content: string;
  finishReason: FinishReason;
  usage?: AIUsage;
  /** The model that wrote `content`. */
  choice: ModelChoice;
  /** The OpenAI model that failed when Claude wrote `content`. */
  fallbackFrom?: ModelChoice;
}

export interface OrchestratorDeps {
  root: Span;
  control: RunControl;
  hooks: TurnHooks;
  /** The paper for the Refine and Answer modules; read once per turn. */
  paper: () => Paper;
  /** Model calls; the LLM Gateway unless a test replaces it. */
  call?: typeof callModel;
}

/** The judge's choice: the tool it called, or a direct reply when it called none. */
export function chooseRoute(response: AIResponse): { route: Route; reason?: string } {
  const call = response.toolCalls?.[0];
  const reason = typeof call?.arguments.reason === "string" ? call.arguments.reason : undefined;
  if (call?.name === ANSWER_QUESTION) return { route: "answer", reason };
  if (call?.name === REFINE_QUESTION) return { route: "refine", reason };
  // An unknown tool or an empty reply: refine, as the judge is told to when unsure.
  if (call || !response.text.trim()) return { route: "refine", reason };
  return { route: "reply" };
}

/** What the user points at, as handed to the orchestrator. */
export function editorLocation(turn: Turn) {
  return { file: turn.context.currentFile ?? null, selected_text: turn.selectedText ?? null };
}

/** Earlier exchanges (one question and its answer each) in a history. */
export function turnCount(history: AIMessage[]): number {
  return Math.floor(history.length / 2);
}

function paperSummary(paper: Paper) {
  return {
    files: paper.files.map((f) => ({ path: f.path, chars: f.text.length })),
    omitted: paper.omitted,
    total_chars: paper.files.reduce((n, f) => n + f.text.length, 0),
    text: paper.files.map((f) => `% ---- ${f.path}\n${f.text}`).join("\n"),
  };
}

function finished(result: GatewayResult) {
  return {
    finishReason: result.response.finishReason,
    usage: result.response.usage,
    choice: result.choice,
    fallbackFrom: result.fallbackFrom?.choice,
  };
}

export async function runChatTurn(turn: Turn, deps: OrchestratorDeps): Promise<TurnResult> {
  const call = deps.call ?? callModel;
  const { hooks } = deps;
  const options = (parent: Span, onText?: (full: string) => void): GatewayOptions => ({
    control: deps.control,
    trace: { traceId: turn.id, parent },
    onAttempt: hooks.onModel,
    onText,
  });
  const ask = { instruction: turn.instruction, selectedText: turn.selectedText, context: turn.context, history: turn.history };
  let paper: Paper | null = null;
  const readPaper = (span: Span, module: "refine" | "answer"): Paper => {
    paper ??= deps.paper();
    const read = paper;
    step(turn.id, span, module, "paperFiles", { budget_chars: read.budget, active_file: turn.activePath ?? null }, () => paperSummary(read));
    return read;
  };

  // 1. The judge decides what happens with the message.
  hooks.onStage?.("judge");
  const judged = await traced(
    turn.id,
    deps.root,
    "orchestrator",
    "runOrchestrator",
    () => ({
      question: turn.instruction,
      ...editorLocation(turn),
      chat_history_turns: turnCount(turn.history.slice(-JUDGE_HISTORY_MESSAGES)),
      tools: CHAT_TOOLS.map((tool) => tool.name),
    }),
    async (span) => {
      const result = await call("judge", { ...ask, id: `${turn.id}-judge`, tools: CHAT_TOOLS }, options(span));
      const decision = chooseRoute(result.response);
      step(turn.id, span, "orchestrator", "chooseRoute", () => ({ text: result.response.text, tool_calls: result.response.toolCalls ?? [] }), decision);
      return { ...decision, result };
    },
    (judged) => ({ route: judged.route, reason: judged.reason ?? null, reply: judged.route === "reply" ? judged.result.response.text : null }),
  );

  if (judged.route === "reply") {
    return { route: "reply", outcome: "reply", content: judged.result.response.text.trim(), ...finished(judged.result) };
  }

  // 2. Refine an abstract question first, or ask the user back.
  let refined: string | undefined;
  if (judged.route === "refine") {
    hooks.onStage?.("refine");
    const { parsed, result } = await traced(
      turn.id,
      deps.root,
      "refine",
      "runRefineModule",
      () => ({ question: turn.instruction, ...editorLocation(turn), chat_history_turns: turnCount(turn.history) }),
      async (span): Promise<{ parsed: RefineResult; result: GatewayResult }> => {
        const read = readPaper(span, "refine");
        const result = await call(
          "refine",
          { ...ask, id: `${turn.id}-refine`, projectFiles: read.files, omittedFiles: read.omitted },
          options(span),
        );
        const parsed = parseRefine(result.response.text, turn.instruction);
        step(turn.id, span, "refine", "parseRefine", result.response.text, parsed);
        return { parsed, result };
      },
      ({ parsed }) => parsed,
    );
    if (parsed.kind === "clarify") {
      return { route: "refine", outcome: "clarify", reason: judged.reason, content: parsed.text, ...finished(result) };
    }
    refined = parsed.text;
    hooks.onRefined?.(refined);
  }

  // 3. Answer from the whole paper; the answer streams to the screen.
  hooks.onStage?.("answer");
  const answered = await traced(
    turn.id,
    deps.root,
    "answer",
    "runAnswerModule",
    () => ({ question: turn.instruction, refined_question: refined ?? null, chat_history_turns: turnCount(turn.history) }),
    async (span) => {
      const read = readPaper(span, "answer");
      return call(
        "answer",
        { ...ask, id: turn.id, projectFiles: read.files, omittedFiles: read.omitted, refinedQuestion: refined },
        options(span, hooks.onText),
      );
    },
    (result) => ({ text: result.response.text, finishReason: result.response.finishReason, model: result.choice.model }),
  );
  return { route: judged.route, outcome: "answer", reason: judged.reason, refined, content: answered.response.text, ...finished(answered) };
}
