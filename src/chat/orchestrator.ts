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
 * The judge reads the paper map (L0, see `./paper/`) and, for the answer and
 * refine routes, names the sections to read word for word; the Refine Module
 * may correct that choice. The Refine and Answer modules then read those
 * sections word for word and the rest as summaries, or the whole paper while
 * the paper report has no summaries. An answer that still needs a section it
 * has only as a summary asks for it once, and is written again with it.
 *
 * Every call reads the session summary (L1) and recent turns word for word
 * (L2): at least four turns for the judge, two for the other modules,
 * including every turn the summary does not cover yet (see `./session/`).
 */
import { parseRefine, type RefineResult } from "../ai/agent/refine";
import { callModel, type GatewayOptions, type GatewayResult, type RunControl } from "../ai/gateway";
import type { ModelChoice } from "../ai/models/modelConfig";
import { NEED_SECTIONS } from "../ai/prompts/answer";
import { ANSWER_QUESTION, CHAT_TOOLS, REFINE_QUESTION, REPLY_DIRECTLY } from "../ai/tools/chatTools";
import type { AIMessage, AIResponse, AIUsage, FinishReason } from "../ai/types";
import { step, traced, type Span } from "../debug/trace";
import { describeScope, paperMap, paperRequest, resolveScope, type Paper, type Scope } from "./paper/scope";
import { renderSummary, type ConversationSummary } from "./session/summary";
import { JUDGE_MESSAGE_CHARS, JUDGE_TURNS, MODULE_MESSAGE_CHARS, MODULE_TURNS, selectHistory, type Clipped, type TurnRecord } from "./session/turns";

/** What the judge chose: reply itself, answer, or refine first. */
export type Route = "reply" | "answer" | "refine";
/** How the turn ended: a direct reply, an answer, or a question back to the user. */
export type Outcome = "reply" | "answer" | "clarify";
/** The step running for the answer on screen; `paper` summarizes the paper before the first answer. */
export type Stage = "paper" | "judge" | "reply" | "refine" | "answer";

/** One question to answer. The editor's state (open file, selection, cursor) is not part of it. */
export interface Turn {
  id: string;
  instruction: string;
  /** Every earlier turn of the session, finished or not. */
  turns: TurnRecord[];
  /** The session summary of the older turns, when there is one. */
  summary?: ConversationSummary | null;
}

export type { Paper } from "./paper/scope";

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
  /** The paper, read once at the start of the turn: the judge reads its map. */
  paper: () => Paper;
  /** Model calls; the LLM Gateway unless a test replaces it. */
  call?: typeof callModel;
}

/** Why a tool call came without a usable reason (it only goes to the debugger). */
export type ReasonIssue = "arguments_unreadable" | "reason_missing";

/** The judge's choice: the route, why, and for the paper routes the sections to read word for word. */
export interface Decision {
  route: Route;
  reason?: string;
  sections?: string[];
  reasonIssue?: ReasonIssue;
}

/**
 * The judge's choice: the tool it called, and why. The route comes from the
 * tool's name, so a broken argument never changes it; it is only reported.
 */
export function chooseRoute(response: AIResponse): Decision {
  const decision = routeOf(response);
  const call = response.toolCalls?.[0];
  if (!call || decision.reason) return decision;
  return { ...decision, reasonIssue: call.argumentsError ? "arguments_unreadable" : "reason_missing" };
}

function routeOf(response: AIResponse): Decision {
  const call = response.toolCalls?.[0];
  const reason = typeof call?.arguments.reason === "string" ? call.arguments.reason.trim() || undefined : undefined;
  const listed = call?.arguments.sections;
  const sections = Array.isArray(listed) ? { sections: listed.filter((s): s is string => typeof s === "string") } : {};
  if (call?.name === REPLY_DIRECTLY) return { route: "reply", reason };
  if (call?.name === ANSWER_QUESTION) return { route: "answer", reason, ...sections };
  if (call?.name === REFINE_QUESTION) return { route: "refine", reason, ...sections };
  // The judge must call a tool. Text without one is read as small talk;
  // an unknown tool or no reply at all as a question to refine, as when unsure.
  if (!call && response.text.trim()) return { route: "reply" };
  return { route: "refine", reason };
}

/** What a call reads of the conversation: the summary text and the turns word for word. */
export interface Conversation {
  sessionSummary?: string;
  history: AIMessage[];
  /** For the debugger. */
  info: { turn_numbers: number[]; clipped?: Clipped[] };
}

/**
 * One history selector for all calls, using a four- or two-turn window and
 * the summary's coverage. The question being asked is not a turn yet, so
 * the first message of a session has none.
 */
export function conversationFor(turn: Turn, reader: "judge" | "module"): Conversation {
  const covered = turn.summary?.coveredTurns ?? 0;
  const { messages, turnNumbers, clipped } = selectHistory(
    turn.turns,
    covered,
    reader === "judge" ? JUDGE_TURNS : MODULE_TURNS,
    reader === "judge" ? JUDGE_MESSAGE_CHARS : MODULE_MESSAGE_CHARS,
  );
  return {
    sessionSummary: renderSummary(turn.summary ?? null) || undefined,
    history: messages,
    info: {
      turn_numbers: turnNumbers,
      ...(clipped.length ? { clipped } : {}),
    },
  };
}

/** What the debugger shows of the paper a module reads. */
function paperRead(paper: Paper, scope: Scope) {
  if (scope.kind === "sections") return describeScope(scope);
  return {
    ...describeScope(scope),
    files: paper.files.map((f) => ({ path: f.path, chars: f.text.length })),
    omitted_files: paper.omitted,
    text: paper.files.map((f) => `% ---- ${f.path}\n${f.text}`).join("\n"),
  };
}

/** The sections an answer asked for instead of answering, or null when it answered. */
export function askedForSections(text: string): string[] | null {
  const head = text.trimStart();
  if (!head.startsWith(NEED_SECTIONS)) return null;
  const end = head.indexOf("]]");
  const list = head.slice(NEED_SECTIONS.length, end < 0 ? undefined : end);
  return list.split(",").map((k) => k.trim()).filter(Boolean);
}

/**
 * The answer's text for the screen, held back while it may still be a request
 * for sections: such a request is never shown.
 */
function holdBack(onText: (full: string) => boolean) {
  let open = false;
  let last = "";
  return {
    onText(full: string) {
      last = full;
      if (!open) {
        const head = full.trimStart();
        if (!head || (head.length < NEED_SECTIONS.length ? NEED_SECTIONS.startsWith(head) : head.startsWith(NEED_SECTIONS))) return false;
        open = true;
      }
      return onText(full);
    },
    /** Show what was held back: it was an answer after all. */
    release() {
      if (open || !last) return;
      open = true;
      onText(last);
    },
    /** A fallback attempt starts with its own stream, without the failed attempt's buffer. */
    reset() {
      open = false;
      last = "";
    },
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
  const showText = (full: string): boolean => {
    if (!full || !hooks.onText) return false;
    hooks.onText(full);
    return true;
  };
  const options = (parent: Span, reads: Conversation, onText?: GatewayOptions["onText"]): GatewayOptions => ({
    control: deps.control,
    trace: { traceId: turn.id, parent, input: reads.info },
    onAttempt: hooks.onModel,
    onText,
  });
  const judgeReads = conversationFor(turn, "judge");
  const moduleReads = conversationFor(turn, "module");
  const ask = { instruction: turn.instruction, context: {}, sessionSummary: moduleReads.sessionSummary, history: moduleReads.history };
  const paper = deps.paper();
  const map = paperMap(paper);
  // The sections chosen so far (judge, then Refine Module), and what they make of the paper.
  let requested: string[] | undefined;
  let scope: Scope = resolveScope(paper, undefined);
  const readPaper = (span: Span, module: "refine" | "answer") => {
    step(turn.id, span, module, "paperView", { sections: requested ?? null, budget_chars: paper.budget }, () => paperRead(paper, scope));
    return paperRequest(paper, scope);
  };

  // 1. The judge decides what happens with the message, and which sections to read.
  hooks.onStage?.("judge");
  const judged = await traced(
    turn.id,
    deps.root,
    "orchestrator",
    "runOrchestrator",
    () => ({
      question: turn.instruction,
      session_turns: turn.turns.length,
      summary_covered_turns: turn.summary?.coveredTurns ?? 0,
      paper_map: map ? { sections: map.filter((e) => !e.always).length, summarized: map.filter((e) => e.summary).length } : null,
      tools: CHAT_TOOLS.map((tool) => tool.name),
    }),
    async (span) => {
      const result = await call("judge", { ...ask, history: judgeReads.history, ...(map ? { paperMap: map } : {}), id: `${turn.id}-judge`, tools: CHAT_TOOLS }, options(span, judgeReads));
      const decision = chooseRoute(result.response);
      step(turn.id, span, "orchestrator", "chooseRoute", () => ({ text: result.response.text, tool_calls: result.response.toolCalls ?? [] }), decision);
      return { ...decision, result };
    },
    (judged) => ({
      route: judged.route,
      reason: judged.reason ?? null,
      ...(judged.route !== "reply" ? { sections: judged.sections ?? [] } : {}),
      ...(judged.reasonIssue ? { reason_issue: judged.reasonIssue } : {}),
    }),
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
      (span) => call("reply", { ...ask, id: `${turn.id}-reply` }, options(span, moduleReads, showText)),
      (result) => ({ text: result.response.text, finishReason: result.response.finishReason, model: result.choice.model }),
    );
    return { route: "reply", outcome: "reply", reason: judged.reason, content: replied.response.text.trim(), ...finished(replied) };
  }
  requested = judged.sections;
  scope = resolveScope(paper, requested);

  // 2b. Refine an abstract question first, or ask the user back.
  let refined: string | undefined;
  if (judged.route === "refine") {
    hooks.onStage?.("refine");
    const { parsed, result } = await traced(
      turn.id,
      deps.root,
      "refine",
      "runRefineModule",
      () => ({ question: turn.instruction, ...moduleReads.info }),
      async (span): Promise<{ parsed: RefineResult; result: GatewayResult }> => {
        const result = await call("refine", { ...ask, id: `${turn.id}-refine`, ...readPaper(span, "refine") }, options(span, moduleReads));
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
    // With the question settled, the Refine Module's choice of sections replaces the judge's.
    if (scope.kind === "sections" && parsed.sections) {
      requested = parsed.sections;
      scope = resolveScope(paper, requested);
    }
  }

  // 3. Answer from the paper; the answer streams to the screen.
  hooks.onStage?.("answer");
  const answered = await traced(
    turn.id,
    deps.root,
    "answer",
    "runAnswerModule",
    () => ({ question: turn.instruction, refined_question: refined ?? null, ...moduleReads.info }),
    async (span) => {
      const request = { ...ask, id: turn.id, refinedQuestion: refined };
      const mayAsk = scope.kind === "sections";
      const shown = holdBack(showText);
      const first = await call("answer", { ...request, ...readPaper(span, "answer"), ...(mayAsk ? { mayAskForSections: true } : {}) }, {
        ...options(span, moduleReads, mayAsk ? shown.onText : showText),
        onAttempt: (choice, fallback) => {
          shown.reset();
          hooks.onModel?.(choice, fallback);
        },
      });
      const asked = mayAsk ? askedForSections(first.response.text) : null;
      if (!asked) {
        shown.release();
        return first;
      }
      // Once: the second answer gets those sections word for word and must answer.
      requested = [...(requested ?? []), ...asked];
      scope = resolveScope(paper, requested);
      step(turn.id, span, "answer", "askForSections", asked, () => describeScope(scope));
      return call("answer", { ...request, id: `${turn.id}-more`, ...readPaper(span, "answer") }, options(span, moduleReads, showText));
    },
    (result) => ({ text: result.response.text, finishReason: result.response.finishReason, model: result.choice.model }),
  );
  return { route: judged.route, outcome: "answer", reason: judged.reason, refined, content: answered.response.text, ...finished(answered) };
}
