/**
 * Chat Orchestrator: the agent that runs one chat turn.
 *
 *   👤 User → Chat Orchestrator ─┬─ reply_directly  → Reply Module ─────────────────→ 💬
 *                                ├─ answer_question → Answer Module ────────────────→ 💬
 *                                └─ refine_question → Refine Module → Answer Module → 💬
 *                                                                  └─ (still unclear) ask back → 💬
 *
 * Its judge model picks the route by calling one tool, with the reason for
 * it; it never writes text for the user. The Reply, Refine and Answer
 * modules are the tools: each builds its own request and makes one model
 * call. Every model call goes through the LLM Gateway (model choice and
 * fallback). In development each step is reported to the runtime debugger
 * (see `src/debug/trace.ts`).
 *
 * Every call reads the session summary (L1) and recent turns word for word
 * (L2): the judge the last four turns, the modules the turns the summary
 * does not cover yet (see `./session/`).
 */
import { parseRefine, type RefineResult } from "../ai/agent/refine";
import { callModel, type GatewayOptions, type GatewayResult, type RunControl } from "../ai/gateway";
import type { ModelChoice } from "../ai/models/modelConfig";
import { ANSWER_QUESTION, CHAT_TOOLS, REFINE_QUESTION, REPLY_DIRECTLY } from "../ai/tools/chatTools";
import type { AIContext, AIMessage, AIResponse, AIUsage, FinishReason, ProjectFile } from "../ai/types";
import { step, traced, type Span } from "../debug/trace";
import { renderSummary, type ConversationSummary } from "./session/summary";
import { JUDGE_MESSAGE_CHARS, judgeTurns, MODULE_MESSAGE_CHARS, moduleTurns, turnMessages, type Clipped, type TurnRecord } from "./session/turns";

/** What the judge chose: reply itself, answer, or refine first. */
export type Route = "reply" | "answer" | "refine";
/** How the turn ended: a direct reply, an answer, or a question back to the user. */
export type Outcome = "reply" | "answer" | "clarify";
export type Stage = "judge" | "reply" | "refine" | "answer";

export interface Turn {
  id: string;
  instruction: string;
  /** The open file (`currentFile`) only. */
  context: AIContext;
  /** Every earlier turn of the session, finished or not. */
  turns: TurnRecord[];
  /** The session summary of the older turns, when there is one. */
  summary?: ConversationSummary | null;
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
  /** The primary model that failed when the fallback wrote `content`. */
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

/** Why a tool call came without a usable reason (it only goes to the debugger). */
export type ReasonIssue = "arguments_unreadable" | "reason_missing";

/**
 * The judge's choice: the tool it called, and why. The route comes from the
 * tool's name, so a broken argument never changes it; it is only reported.
 */
export function chooseRoute(response: AIResponse): { route: Route; reason?: string; reasonIssue?: ReasonIssue } {
  const decision = routeOf(response);
  const call = response.toolCalls?.[0];
  if (!call || decision.reason) return decision;
  return { ...decision, reasonIssue: call.argumentsError ? "arguments_unreadable" : "reason_missing" };
}

function routeOf(response: AIResponse): { route: Route; reason?: string } {
  const call = response.toolCalls?.[0];
  const reason = typeof call?.arguments.reason === "string" ? call.arguments.reason.trim() || undefined : undefined;
  if (call?.name === REPLY_DIRECTLY) return { route: "reply", reason };
  if (call?.name === ANSWER_QUESTION) return { route: "answer", reason };
  if (call?.name === REFINE_QUESTION) return { route: "refine", reason };
  // The judge must call a tool. Text without one is read as small talk;
  // an unknown tool or no reply at all as a question to refine, as when unsure.
  if (!call && response.text.trim()) return { route: "reply" };
  return { route: "refine", reason };
}

/** Where the user is, as handed to the orchestrator: the open file. */
export function editorLocation(turn: Turn) {
  return { file: turn.context.currentFile ?? null };
}

/** What a call reads of the conversation: the summary text and the turns word for word. */
export interface Conversation {
  sessionSummary?: string;
  history: AIMessage[];
  /** For the debugger. */
  info: { chat_history_turns: number; history_turn_numbers: number[]; summary_covered_turns: number; clipped?: Clipped[] };
}

/**
 * The conversation for the judge (last four turns) and for the modules (the
 * turns the summary does not cover). The question being asked is not a turn
 * yet, so the first message of a session has none.
 */
export function conversationFor(turn: Turn, reader: "judge" | "module"): Conversation {
  const covered = turn.summary?.coveredTurns ?? 0;
  const turns = reader === "judge" ? judgeTurns(turn.turns) : moduleTurns(turn.turns, covered);
  const { messages, clipped } = turnMessages(turns, reader === "judge" ? JUDGE_MESSAGE_CHARS : MODULE_MESSAGE_CHARS);
  return {
    sessionSummary: renderSummary(turn.summary ?? null) || undefined,
    history: messages,
    info: {
      chat_history_turns: turns.length,
      history_turn_numbers: turns.map((t) => t.index),
      summary_covered_turns: covered,
      ...(clipped.length ? { clipped } : {}),
    },
  };
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
  const judgeReads = conversationFor(turn, "judge");
  const moduleReads = conversationFor(turn, "module");
  const ask = { instruction: turn.instruction, context: turn.context, sessionSummary: moduleReads.sessionSummary, history: moduleReads.history };
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
      ...judgeReads.info,
      tools: CHAT_TOOLS.map((tool) => tool.name),
    }),
    async (span) => {
      const result = await call("judge", { ...ask, history: judgeReads.history, id: `${turn.id}-judge`, tools: CHAT_TOOLS }, options(span));
      const decision = chooseRoute(result.response);
      step(turn.id, span, "orchestrator", "chooseRoute", () => ({ text: result.response.text, tool_calls: result.response.toolCalls ?? [] }), decision);
      return { ...decision, result };
    },
    (judged) => ({ route: judged.route, reason: judged.reason ?? null, ...(judged.reasonIssue ? { reason_issue: judged.reasonIssue } : {}) }),
  );

  // 2a. Small talk: the Reply Module answers without the paper.
  if (judged.route === "reply") {
    hooks.onStage?.("reply");
    const replied = await traced(
      turn.id,
      deps.root,
      "reply",
      "runReplyModule",
      () => ({ question: turn.instruction, ...moduleReads.info }),
      (span) => call("reply", { ...ask, id: `${turn.id}-reply` }, options(span, hooks.onText)),
      (result) => ({ text: result.response.text, finishReason: result.response.finishReason, model: result.choice.model }),
    );
    return { route: "reply", outcome: "reply", reason: judged.reason, content: replied.response.text.trim(), ...finished(replied) };
  }

  // 2b. Refine an abstract question first, or ask the user back.
  let refined: string | undefined;
  if (judged.route === "refine") {
    hooks.onStage?.("refine");
    const { parsed, result } = await traced(
      turn.id,
      deps.root,
      "refine",
      "runRefineModule",
      () => ({ question: turn.instruction, ...editorLocation(turn), ...moduleReads.info }),
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
    () => ({ question: turn.instruction, refined_question: refined ?? null, ...moduleReads.info }),
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
