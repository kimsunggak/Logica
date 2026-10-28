/**
 * Paper Orchestra: common plain-text refinement, fixed UI route or Auto intent
 * routing, source selection, then Paper Chat or Paper Edit execution.
 */
import { parseRefine } from "../ai/agent/refine";
import type { ProposedEdit } from "../ai/agent/edits";
import { AIError } from "../ai/errors";
import { callModel, type GatewayOptions, type GatewayResult, type RunControl } from "../ai/gateway";
import type { ModelChoice } from "../ai/models/modelConfig";
import { NEED_SECTIONS } from "../ai/prompts/answer";
import { ALL_SECTIONS, CHAT_TOOLS, CLARIFY_REQUEST, EDIT_TOOLS, ROUTE_CHAT, ROUTE_EDIT, SELECT_CHAT_SECTIONS, SELECT_EDIT_SECTIONS, sectionTools } from "../ai/tools/chatTools";
import type { AIMessage, AIResponse, AIUsage, ChatMode, ExecutionMode, FinishReason } from "../ai/types";
import { step, traced, type Span } from "../debug/trace";
import { t } from "../i18n";
import { editableSources, readEditProposal, requireFullSections } from "./paper/editTool";
import { describeScope, paperMap, paperRequest, resolveScope, type Paper, type Scope } from "./paper/scope";
import { renderSummary, type ConversationSummary } from "./session/summary";
import { JUDGE_MESSAGE_CHARS, JUDGE_TURNS, MODULE_MESSAGE_CHARS, MODULE_TURNS, selectHistory, type Clipped, type TurnRecord } from "./session/turns";

export type Route = "chat" | "edit" | "clarify";
/** Includes outcomes in saved conversations from before UI modes were introduced. */
export type Outcome = Route | "reply" | "answer";
export type Stage = "paper" | "refine" | "judge" | "select" | "answer" | "edit" | "reply";

export interface Turn {
  id: string;
  instruction: string;
  mode?: ChatMode;
  turns: TurnRecord[];
  summary?: ConversationSummary | null;
}
export type { Paper } from "./paper/scope";
export interface TurnHooks {
  onStage?: (stage: Stage) => void;
  onRefined?: (request: string) => void;
  onText?: (full: string) => void;
  onModel?: (choice: ModelChoice, fallback: boolean) => void;
}
export interface TurnResult {
  route: Route;
  outcome: Outcome;
  reason?: string;
  refined?: string;
  content: string;
  edits?: ProposedEdit[];
  editToolCallId?: string;
  finishReason: FinishReason;
  usage?: AIUsage;
  choice: ModelChoice;
  fallbackFrom?: ModelChoice;
}
export interface OrchestratorDeps {
  root: Span;
  control: RunControl;
  hooks: TurnHooks;
  paper: () => Paper;
  call?: typeof callModel;
}
export interface Decision {
  route: Route;
  reason?: string;
  question?: string;
}
/** An invalid Auto result never grants permission to edit. */
export function chooseRoute(response: AIResponse): Decision {
  const call = response.toolCalls?.[0];
  if (response.finishReason !== "stop" || response.toolCalls?.length !== 1 || !call || call.argumentsError) return { route: "clarify", question: t("chat.clarifyIntent") };
  if (call.name === CLARIFY_REQUEST) return { route: "clarify", question: clarification(response) ?? t("chat.clarifyIntent") };
  const reason = typeof call.arguments.reason === "string" ? call.arguments.reason.trim() : "";
  if (reason && call.name === ROUTE_CHAT) return { route: "chat", reason };
  if (reason && call.name === ROUTE_EDIT) return { route: "edit", reason };
  return { route: "clarify", question: t("chat.clarifyIntent") };
}
function clarification(response: AIResponse): string | undefined {
  const call = response.toolCalls?.[0];
  if (response.finishReason !== "stop" || response.toolCalls?.length !== 1 || call?.name !== CLARIFY_REQUEST || call.argumentsError) return undefined;
  return typeof call.arguments.question === "string" ? call.arguments.question.trim() || undefined : undefined;
}
function complete(result: GatewayResult): void {
  if (result.response.finishReason === "cancelled") throw new AIError("cancelled", t("chat.stopped"));
  if (result.response.finishReason !== "stop") throw new AIError("malformed_response", t("chat.incompleteStep"));
}
interface Selection {
  edit: string[];
  reference: string[];
  reason: string;
}
/** The paper's own key. Claude may change an enum value's capitalization, so a unique case-insensitive match counts. */
function sectionKey(paper: Paper, value: string): string | undefined {
  const keys = [ALL_SECTIONS, ...(paper.units ?? []).map((u) => u.key)];
  if (keys.includes(value)) return value;
  const same = keys.filter((key) => key.toLowerCase() === value.toLowerCase());
  return same.length === 1 ? same[0] : undefined;
}
function selectionOf(response: AIResponse, mode: ExecutionMode, paper: Paper): Selection {
  const call = response.toolCalls?.[0];
  const invalid = () => new AIError("malformed_response", t("chat.invalidSections"));
  if (response.toolCalls?.length !== 1 || !call || call.argumentsError || call.name !== (mode === "edit" ? SELECT_EDIT_SECTIONS : SELECT_CHAT_SECTIONS)) throw invalid();
  const list = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) throw invalid();
    const keys = (value as string[]).map((v) => sectionKey(paper, v.trim()));
    if (keys.some((key) => key === undefined)) throw invalid();
    return [...new Set(keys as string[])];
  };
  const reason = typeof call.arguments.reason === "string" ? call.arguments.reason.trim() : "";
  if (!reason) throw invalid();
  if (mode === "chat") return { edit: [], reference: list(call.arguments.sections), reason };
  const edit = list(call.arguments.edit_sections);
  if (!edit.length || !paper.files.length && !paper.units?.length) throw invalid();
  return { edit, reference: list(call.arguments.reference_sections), reason };
}

export interface Conversation {
  sessionSummary?: string;
  history: AIMessage[];
  info: { turn_numbers: number[]; clipped?: Clipped[] };
}
export function conversationFor(turn: Turn, reader: "judge" | "module"): Conversation {
  const { messages, turnNumbers, clipped } = selectHistory(turn.turns, turn.summary?.coveredTurns ?? 0,
    reader === "judge" ? JUDGE_TURNS : MODULE_TURNS, reader === "judge" ? JUDGE_MESSAGE_CHARS : MODULE_MESSAGE_CHARS);
  return { sessionSummary: renderSummary(turn.summary ?? null) || undefined, history: messages,
    info: { turn_numbers: turnNumbers, ...(clipped.length ? { clipped } : {}) } };
}
function paperRead(paper: Paper, scope: Scope) {
  return scope.kind === "sections" ? describeScope(scope) : {
    ...describeScope(scope), files: paper.files.map((f) => ({ path: f.path, chars: f.text.length })), omitted_files: paper.omitted,
  };
}
export function askedForSections(text: string): string[] | null {
  const head = text.trimStart();
  if (!head.startsWith(NEED_SECTIONS)) return null;
  const end = head.indexOf("]]");
  return head.slice(NEED_SECTIONS.length, end < 0 ? undefined : end).split(",").map((k) => k.trim()).filter(Boolean);
}
/** Hide the Chat Module's source requests while retaining normal streaming/fallback. */
function holdBack(onText: (full: string) => boolean) {
  let open = false, last = "";
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
    release() { if (!open && last) { open = true; onText(last); } },
    reset() { open = false; last = ""; },
  };
}
function finished(result: GatewayResult) {
  return { finishReason: result.response.finishReason, usage: result.response.usage, choice: result.choice, fallbackFrom: result.fallbackFrom?.choice };
}

export async function runChatTurn(turn: Turn, deps: OrchestratorDeps): Promise<TurnResult> {
  const call = deps.call ?? callModel;
  const { hooks } = deps;
  const mode = turn.mode ?? "auto";
  const showText = (full: string): boolean => {
    if (!full || !hooks.onText) return false;
    hooks.onText(full);
    return true;
  };
  const options = (parent: Span, reads: Conversation, onText?: GatewayOptions["onText"]): GatewayOptions => ({
    control: deps.control, trace: { traceId: turn.id, parent, input: reads.info }, onAttempt: hooks.onModel, onText,
  });
  const moduleReads = conversationFor(turn, "module");
  const base = { instruction: turn.instruction, context: {}, uiMode: mode, sessionSummary: moduleReads.sessionSummary, history: moduleReads.history };

  // All modes refine first. No paper selection or intent routing belongs here.
  hooks.onStage?.("refine");
  const refined = await traced(turn.id, deps.root, "refine", "runRefineModule",
    () => ({ question: turn.instruction, ui_mode: mode, ...moduleReads.info }),
    async (span) => {
      const result = await call("refine", { ...base, id: `${turn.id}-refine` }, options(span, moduleReads));
      complete(result);
      const text = parseRefine(result.response.text, turn.instruction);
      step(turn.id, span, "refine", "refinedRequest", result.response.text, text);
      return text;
    }, (text) => ({ text }));
  hooks.onRefined?.(refined);
  const paper = deps.paper();
  const map = paperMap(paper);
  const ask = { ...base, refinedQuestion: refined };
  const decision = await traced(turn.id, deps.root, "orchestrator", "runOrchestrator",
    () => ({ question: turn.instruction, refined_request: refined, ui_mode: mode, session_turns: turn.turns.length,
      summary_covered_turns: turn.summary?.coveredTurns ?? 0,
      paper_map: map ? { sections: map.length, summarized: map.filter((e) => e.summary).length } : null,
      tools: mode === "auto" ? CHAT_TOOLS.map((tool) => tool.name) : [] }),
    async (span) => {
      if (mode !== "auto") {
        const fixed: Decision = { route: mode, reason: `UI mode: ${mode}` };
        step(turn.id, span, "orchestrator", "fixedModeRoute", { ui_mode: mode }, fixed);
        return { ...fixed, result: undefined };
      }
      hooks.onStage?.("judge");
      const reads = conversationFor(turn, "judge");
      const result = await call("judge", { ...ask, history: reads.history, paperMap: map, id: `${turn.id}-route`, tools: CHAT_TOOLS }, options(span, reads));
      complete(result);
      const chosen = chooseRoute(result.response);
      step(turn.id, span, "orchestrator", "chooseRoute", result.response.toolCalls ?? [], chosen);
      return { ...chosen, result };
    }, (chosen) => ({ route: chosen.route, reason: chosen.reason, ui_mode: mode }));

  if (decision.route === "clarify") {
    return { route: "clarify", outcome: "clarify", refined, content: decision.question ?? t("chat.clarifyIntent"), ...finished(decision.result!) };
  }
  const route = decision.route;
  const request = { ...ask, executionMode: route, paperMap: map };
  hooks.onStage?.("select");
  const selected = await traced(turn.id, deps.root, "selection", "runSectionSelection",
    () => ({ mode: route, question: turn.instruction, refined_request: refined, paper_map: map, ...moduleReads.info }),
    async (span) => {
      const result = await call("select", { ...request, id: `${turn.id}-select`, tools: sectionTools(route, map?.map((e) => e.key) ?? []) }, options(span, moduleReads));
      complete(result);
      const question = clarification(result.response);
      if (question) return { question, result, selection: undefined };
      const selection = selectionOf(result.response, route, paper);
      step(turn.id, span, "selection", "selectedSections", result.response.toolCalls, selection);
      return { selection, result, question: undefined };
    }, (out) => out.question ? { clarify: out.question } : out.selection);
  if (selected.question) return { route, outcome: "clarify", reason: decision.reason, refined, content: selected.question, ...finished(selected.result) };
  const selection = selected.selection!;
  let requested = [...selection.edit, ...selection.reference];
  let scope = resolveScope(paper, requested);

  if (route === "edit") {
    requireFullSections(paper, scope, requested);
    const sources = editableSources(paper, selection.edit);
    if (!sources.length) throw new AIError("malformed_response", t("chat.invalidSections"));
    hooks.onStage?.("edit");
    const edited = await traced(turn.id, deps.root, "edit", "runPaperEditModule",
      () => ({ question: turn.instruction, refined_request: refined, edit_sections: selection.edit, reference_sections: selection.reference, ...moduleReads.info }),
      async (span) => {
        step(turn.id, span, "edit", "paperView", { edit_sections: selection.edit, reference_sections: selection.reference }, () => paperRead(paper, scope));
        const result = await call("edit", { ...request, id: `${turn.id}-edit`, ...paperRequest(paper, scope), editSections: selection.edit, tools: EDIT_TOOLS }, options(span, moduleReads));
        complete(result);
        const question = clarification(result.response);
        if (question) return { result, question, proposal: undefined };
        const proposal = readEditProposal(result.response, sources);
        step(turn.id, span, "edit", "queuePaperEdits", { tool: "apply_paper_edits", call_id: proposal.callId }, () => ({ status: "awaiting_application", ...proposal }));
        return { result, proposal, question: undefined };
      }, (out) => out.question ? { clarify: out.question } : { status: "awaiting_application", edits: out.proposal?.edits.length });
    return { route, outcome: edited.question ? "clarify" : "edit", reason: decision.reason, refined,
      content: edited.question ?? edited.proposal!.summary, edits: edited.proposal?.edits,
      editToolCallId: edited.proposal?.callId, ...finished(edited.result) };
  }

  hooks.onStage?.("answer");
  const answered = await traced(turn.id, deps.root, "answer", "runAnswerModule",
    () => ({ question: turn.instruction, refined_request: refined, ...moduleReads.info }),
    async (span) => {
      const readPaper = () => {
        step(turn.id, span, "answer", "paperView", { sections: requested }, () => paperRead(paper, scope));
        return paperRequest(paper, scope);
      };
      const mayAsk = scope.kind === "sections";
      const shown = holdBack(showText);
      const first = await call("answer", { ...request, id: turn.id, ...readPaper(), mayAskForSections: mayAsk }, {
        ...options(span, moduleReads, mayAsk ? shown.onText : showText),
        onAttempt: (choice, fallback) => { shown.reset(); hooks.onModel?.(choice, fallback); },
      });
      const more = mayAsk && first.response.finishReason === "stop" ? askedForSections(first.response.text) : null;
      if (!more) { shown.release(); return first; }
      requested = [...requested, ...more];
      scope = resolveScope(paper, requested);
      step(turn.id, span, "answer", "askForSections", more, () => describeScope(scope));
      return call("answer", { ...request, id: `${turn.id}-more`, ...readPaper() }, options(span, moduleReads, showText));
    }, (result) => ({ text: result.response.text, finishReason: result.response.finishReason, model: result.choice.model }));
  return { route, outcome: "chat", reason: decision.reason, refined, content: answered.response.text, ...finished(answered) };
}
