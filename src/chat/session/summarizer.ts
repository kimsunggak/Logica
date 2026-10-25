/**
 * Summary Module: folds the oldest turns into the session summary.
 *
 *   after turn 10:  summary(1-6) + turns 7-10 word for word
 *   after turn 16:  summary(1-12) + turns 13-16
 *
 * Once ten turns are not in the summary, or those turns run past 40,000
 * characters as the modules read them, all but the last four are folded, so
 * every call reads at least four turns word for word. Each message counts up
 * to the 4,000 characters it is cut to, so five turns never pass the limit
 * and a run always folds at least two turns. It runs after a turn ends, in
 * the background; a question asked before it finishes reads the older
 * summary and more turns word for word. A failed run is tried again after
 * the next turn.
 */
import { AIError } from "../../ai/errors";
import { callModel, type RunControl } from "../../ai/gateway";
import { SUMMARY_TOOLS, UPDATE_SUMMARY } from "../../ai/tools/summaryTools";
import { step, traced, type Span } from "../../debug/trace";
import { addUnresolved, applyOps, emptySummary, pruneSummary, readOps, renderSummary, type ConversationSummary, type IgnoredOp, type SummaryOp } from "./summary";
import { MODULE_MESSAGE_CHARS, MODULE_TURNS, type TurnRecord } from "./turns";

/** Fold once this many turns are not in the summary, */
export const FOLD_AT = 10;
/** or once those turns are longer than this, as the modules read them. */
export const FOLD_CHARS = 40_000;
/** Turns folded in one call when a long session catches up. */
export const FOLD_BATCH = 6;
/** Longest message of a folded turn. */
const FOLD_MESSAGE_CHARS = 10_000;

/** The turns the summary does not cover yet. */
export function unsummarized(turns: TurnRecord[], summary: ConversationSummary | null): TurnRecord[] {
  const covered = summary?.coveredTurns ?? 0;
  return turns.filter((turn) => turn.index > covered);
}

/** The length of turns as the modules read them: each message counts up to the length it is cut to. */
export function moduleChars(turns: TurnRecord[]): number {
  return turns.reduce((sum, turn) => sum + Math.min(turn.question.length, MODULE_MESSAGE_CHARS) + Math.min(turn.answer.length, MODULE_MESSAGE_CHARS), 0);
}

/** The turns to fold now, oldest first; none until ten are open or they run long. */
export function turnsToFold(turns: TurnRecord[], summary: ConversationSummary | null): TurnRecord[] {
  const open = unsummarized(turns, summary);
  if (open.length < FOLD_AT && moduleChars(open) <= FOLD_CHARS) return [];
  return open.slice(0, Math.max(0, open.length - MODULE_TURNS)).slice(0, FOLD_BATCH);
}

export interface FoldOptions {
  traceId: string;
  /** The turn's root span, so the debugger shows the run in that turn. */
  parent?: Span | null;
  control: RunControl;
  /** The paper's outline, so references name sections the way the paper does. */
  outline?: string;
  call?: typeof callModel;
}

export interface FoldResult {
  summary: ConversationSummary;
  ops: SummaryOp[];
  ignored: IgnoredOp[];
}

function cap(text: string): string {
  return text.length > FOLD_MESSAGE_CHARS ? `${text.slice(0, FOLD_MESSAGE_CHARS)}\n[... ${text.length - FOLD_MESSAGE_CHARS} characters omitted ...]` : text;
}

/** Fold `turns` into `summary` with one call to the Summary Module. */
export async function foldTurns(summary: ConversationSummary | null, turns: TurnRecord[], options: FoldOptions): Promise<FoldResult> {
  const call = options.call ?? callModel;
  const first = turns[0]?.index ?? 0;
  const last = turns.at(-1)?.index ?? 0;
  return traced(
    options.traceId,
    options.parent ?? null,
    "summary",
    "runSummaryModule",
    () => ({ question: `세션 요약: 턴 ${first}~${last} 접기`, fold_turns: turns.map((t) => ({ turn: t.index, status: t.status })), covered_before: summary?.coveredTurns ?? 0 }),
    async (span) => {
      // Requests left unanswered are known from the turns' status, not from the model.
      const before = addUnresolved(summary ?? emptySummary(), turns);
      step(options.traceId, span, "summary", "addUnresolved", () => turns.map((t) => ({ turn: t.index, status: t.status })), () =>
        before.items.filter((item) => !summary?.items.some((old) => old.id === item.id)),
      );
      const result = await call(
        "summary",
        {
          id: `${options.traceId}-summary`,
          instruction: "",
          context: options.outline ? { outline: options.outline } : {},
          sessionSummary: renderSummary(before) || undefined,
          foldTurns: turns.map((t) => ({ index: t.index, question: cap(t.question), answer: cap(t.answer) })),
          tools: SUMMARY_TOOLS,
        },
        { control: options.control, trace: { traceId: options.traceId, parent: span } },
      );
      const toolCall = result.response.toolCalls?.find((c) => c.name === UPDATE_SUMMARY);
      if (!toolCall || toolCall.argumentsError) {
        throw new AIError("unknown", toolCall ? "The Summary Module sent unreadable changes" : "The Summary Module did not call update_summary");
      }
      const ops = readOps(toolCall.arguments);
      const applied = applyOps(before, ops, turns);
      const next = pruneSummary(applied.summary);
      step(options.traceId, span, "summary", "applyOps", () => ops, () => ({ ignored: applied.ignored, summary: renderSummary(next) }));
      return { summary: next, ops, ignored: applied.ignored };
    },
    (r) => ({ covered_turns: r.summary.coveredTurns, ops: r.ops.length, ignored: r.ignored.length, summary: renderSummary(r.summary) }),
  );
}
