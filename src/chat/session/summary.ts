/**
 * L1 session summary: what the conversation before the recent turns left
 * behind, for every chat module to read instead of those turns.
 *
 *   Topic            what the paper is about, one line
 *   Goal             what the user is working on now, one line
 *   P#               preferences: how the user wants answers, standing requirements
 *   U#               unfinished requests, not fully answered (stopped, failed, cut off, asked back)
 *   Session history  each answered turn, one line: what was asked and how it ended
 *   R#               external references: material from outside the paper the user gave (later also tool results)
 *
 * The numbers (P1, U2, R1) let the Summary Module name an item to replace or
 * close; history lines never change, so they go by their turn instead. The
 * Summary Module never rewrites the summary: it returns operations
 * (set_topic, set_goal, add, replace, close) that `applyOps` checks and
 * applies, so items that did not change stay exactly as they were. U# items
 * are made here, from the turns' status; the model can only close them.
 * `renderSummary` always writes the same text for the same summary, which
 * keeps the prompt cache valid.
 */
import type { TurnRecord } from "./turns";

export type SummaryKind = "preference" | "history" | "reference" | "unresolved";
/** Where a reference came from; the Summary Module only adds pasted material. */
export type ReferenceSource = "paste" | "web" | "figure" | "table";

export interface SummaryItem {
  /** P1, R1, U2; history lines have one too (H3) but are shown by their turn. */
  id: string;
  kind: SummaryKind;
  text: string;
  /** The turn it comes from. */
  turn: number;
  status: "active" | "replaced" | "closed";
  /** The item that replaced it. */
  by?: string;
  /** How an unresolved request was settled. */
  note?: string;
  source?: ReferenceSource;
}

export interface ConversationSummary {
  /** Turns 1..coveredTurns are folded into the summary. */
  coveredTurns: number;
  /** What the paper is about. */
  topic: string;
  /** What the user is working on now. */
  goal: string;
  items: SummaryItem[];
  /** Next number per id prefix; ids are never reused. */
  next: Record<SummaryKind, number>;
}

/** One change returned by the Summary Module. Fields an operation does not use are "" (or 0). */
export interface SummaryOp {
  op: string;
  kind: string;
  id: string;
  text: string;
  turn: number;
}

export interface IgnoredOp {
  op: SummaryOp;
  why: string;
}

const PREFIX: Record<SummaryKind, string> = { preference: "P", history: "H", reference: "R", unresolved: "U" };
const KINDS = Object.keys(PREFIX) as SummaryKind[];
/** Longest text per item; longer text is cut. */
const MAX_CHARS = { topic: 200, goal: 200, preference: 300, history: 300, reference: 1500, unresolved: 300, note: 200 } as const;
/** Longest rendered summary; older items are dropped beyond it (see `pruneSummary`). */
export const SUMMARY_CHARS = 4_000;

export function emptySummary(): ConversationSummary {
  return { coveredTurns: 0, topic: "", goal: "", items: [], next: { preference: 1, history: 1, reference: 1, unresolved: 1 } };
}

/** A summary read from a saved session, or null when it is missing or not one. */
export function readSummary(value: unknown): ConversationSummary | null {
  const s = value as ConversationSummary | null | undefined;
  if (!s || typeof s !== "object" || typeof s.coveredTurns !== "number" || !Array.isArray(s.items) || !s.next) return null;
  const saved: Partial<Record<string, number>> = s.next;
  return {
    ...emptySummary(),
    ...s,
    // Sessions saved before the session history called its lines topics (T#).
    items: s.items.map((item) => ((item.kind as string) === "topic" ? { ...item, kind: "history" } : item)),
    next: Object.fromEntries(KINDS.map((kind) => [kind, saved[kind] ?? 1])) as Record<SummaryKind, number>,
  };
}

function cut(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function short(text: string, max: number): string {
  return cut(text.replace(/\s+/g, " "), max);
}

function add(summary: ConversationSummary, item: Omit<SummaryItem, "id" | "status">): SummaryItem {
  const n = summary.next[item.kind];
  const made: SummaryItem = { ...item, id: `${PREFIX[item.kind]}${n}`, status: "active" };
  summary.next[item.kind] = n + 1;
  summary.items.push(made);
  return made;
}

function copy(summary: ConversationSummary): ConversationSummary {
  return { ...summary, items: summary.items.map((item) => ({ ...item })), next: { ...summary.next } };
}

/** What a turn left unanswered, as known from its status. */
function unresolvedText(turn: TurnRecord): string | null {
  const question = `"${short(turn.question, 160)}"`;
  switch (turn.status) {
    case "cancelled":
      return `The user stopped the answer to ${question}.`;
    case "error":
      return `The answer to ${question} failed.`;
    case "truncated":
      return `The answer to ${question} was cut off at the length limit.`;
    case "clarify":
      return `LOGICA asked back "${short(turn.answer, 100)}" about ${question}.`;
    default:
      return null;
  }
}

/** Add a U# item for every turn being folded that was not fully answered. */
export function addUnresolved(summary: ConversationSummary, turns: TurnRecord[]): ConversationSummary {
  const next = copy(summary);
  for (const turn of turns) {
    const text = unresolvedText(turn);
    if (text) add(next, { kind: "unresolved", text: cut(text, MAX_CHARS.unresolved), turn: turn.index });
  }
  return next;
}

/**
 * Apply the Summary Module's operations to a summary that `turns` are folded
 * into. Operations that name a missing item, do what their kind does not
 * allow, or carry no text are left out and reported.
 */
export function applyOps(summary: ConversationSummary, ops: SummaryOp[], turns: TurnRecord[]): { summary: ConversationSummary; ignored: IgnoredOp[] } {
  const next = copy(summary);
  const ignored: IgnoredOp[] = [];
  const first = turns[0]?.index ?? next.coveredTurns + 1;
  const last = turns.at(-1)?.index ?? next.coveredTurns;
  const turnOf = (n: number) => (Number.isInteger(n) && n >= first && n <= last ? n : last);
  const find = (id: string) => next.items.find((item) => item.id === id.trim());

  for (const op of ops) {
    const text = (op.text ?? "").trim();
    const skip = (why: string) => ignored.push({ op, why });
    if (op.op === "set_topic" || op.op === "set_goal") {
      const field = op.op === "set_topic" ? "topic" : "goal";
      if (!text) skip("no text");
      else next[field] = cut(text, MAX_CHARS[field]);
    } else if (op.op === "add") {
      const kind = op.kind as SummaryKind;
      if (kind !== "preference" && kind !== "history" && kind !== "reference") skip(`cannot add ${op.kind || "an item without a kind"}`);
      else if (!text) skip("no text");
      else if (next.items.some((item) => item.kind === kind && item.status === "active" && item.text === cut(text, MAX_CHARS[kind]))) skip("duplicate");
      else add(next, { kind, text: cut(text, MAX_CHARS[kind]), turn: turnOf(op.turn), ...(kind === "reference" ? { source: "paste" as const } : {}) });
    } else if (op.op === "replace") {
      const old = find(op.id);
      if (!old) skip(`no item ${op.id}`);
      else if (old.kind !== "preference" && old.kind !== "reference") skip(`${old.id} cannot be replaced`);
      else if (old.status !== "active") skip(`${old.id} is already ${old.status}`);
      else if (!text) skip("no text");
      else {
        const made = add(next, { kind: old.kind, text: cut(text, MAX_CHARS[old.kind]), turn: turnOf(op.turn), ...(old.source ? { source: old.source } : {}) });
        old.status = "replaced";
        old.by = made.id;
      }
    } else if (op.op === "close") {
      const item = find(op.id);
      if (!item) skip(`no item ${op.id}`);
      else if (item.kind !== "unresolved") skip(`${item.id} is not an unresolved request`);
      else if (item.status !== "active") skip(`${item.id} is already ${item.status}`);
      else {
        item.status = "closed";
        if (text) item.note = cut(text, MAX_CHARS.note);
      }
    } else {
      skip(`unknown operation ${op.op}`);
    }
  }
  next.coveredTurns = Math.max(next.coveredTurns, last);
  return { summary: next, ignored };
}

/** The operations in the Summary Module's tool call, read loosely. */
export function readOps(args: Record<string, unknown>): SummaryOp[] {
  const list = Array.isArray(args.ops) ? args.ops : [];
  return list
    .filter((op): op is Record<string, unknown> => Boolean(op) && typeof op === "object")
    .map((op) => ({
      op: String(op.op ?? ""),
      kind: String(op.kind ?? ""),
      id: String(op.id ?? ""),
      text: String(op.text ?? ""),
      turn: typeof op.turn === "number" ? op.turn : 0,
    }));
}

function line(item: SummaryItem): string {
  // History lines never change, so they go by their turn instead of an id.
  if (item.kind === "history") return `- turn ${item.turn}: ${item.text}`;
  const where = item.kind === "preference" ? "" : item.kind === "reference" ? ` (turn ${item.turn}, ${item.source === "paste" || !item.source ? "pasted" : item.source})` : ` (turn ${item.turn})`;
  const replaced = item.status === "replaced" ? ` (replaced by ${item.by})` : "";
  return `- ${item.id}${where}${replaced}: ${item.text}`;
}

/**
 * The summary as prompt text, the same for the same summary. Settled
 * requests are left out; replaced preferences stay, marked, so a later
 * "go back to what I said first" can be followed.
 */
export function renderSummary(summary: ConversationSummary | null): string {
  if (!summary || (!summary.topic && !summary.goal && summary.items.length === 0)) return "";
  const of = (kind: SummaryKind, keep: (item: SummaryItem) => boolean) => summary.items.filter((item) => item.kind === kind && keep(item));
  const sections: [string, SummaryItem[]][] = [
    ["Preferences (follow the active ones):", of("preference", (item) => item.status !== "closed")],
    ["Unfinished requests:", of("unresolved", (item) => item.status === "active")],
    // One fold may add its lines in any order; the history reads oldest first.
    ["Session history:", of("history", () => true).sort((a, b) => a.turn - b.turn)],
    ["External references (from the user):", of("reference", (item) => item.status === "active")],
  ];
  return [
    summary.coveredTurns ? `Turns 1-${summary.coveredTurns} of this conversation are folded into this summary; later turns follow word for word.` : "",
    [summary.topic ? `Topic: ${summary.topic}` : "", summary.goal ? `Goal: ${summary.goal}` : ""].filter(Boolean).join("\n"),
    ...sections.filter(([, items]) => items.length).map(([title, items]) => [title, ...items.map(line)].join("\n")),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Keep the rendered summary within `max` characters by dropping, oldest
 * first: settled requests, replaced preferences and references, history
 * lines, then references. Active preferences and unfinished requests are always
 * kept.
 */
export function pruneSummary(summary: ConversationSummary, max = SUMMARY_CHARS): ConversationSummary {
  const next = copy(summary);
  const order: ((item: SummaryItem) => boolean)[] = [
    (item) => item.kind === "unresolved" && item.status === "closed",
    (item) => item.status === "replaced",
    (item) => item.kind === "history",
    (item) => item.kind === "reference",
  ];
  for (const drop of order) {
    while (renderSummary(next).length > max) {
      const i = next.items.findIndex(drop);
      if (i < 0) break;
      next.items.splice(i, 1);
    }
  }
  return next;
}
