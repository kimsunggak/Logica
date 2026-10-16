/**
 * The conversation as turns, and the part of it each module reads in full.
 *
 *   L1 session summary  (./summary.ts): turns folded into it
 *   L2 recent turns     (here): the turns sent word for word
 *
 * A turn is a question with whatever came back: a finished answer, a
 * question back, or an answer that was stopped, failed or cut off. Turns
 * that did not finish stay in the conversation with a note, so the next
 * model call knows the request was not answered.
 *
 * The judge reads the last four turns. The other modules read every turn
 * the session summary does not cover yet (two or three, see
 * `./summarizer.ts`). Long messages keep their start and end.
 */
import type { AIMessage } from "../../ai/types";
import { t } from "../../i18n";

export type TurnStatus = "done" | "clarify" | "truncated" | "cancelled" | "error";

export interface TurnRecord {
  /** 1 for the first question of the session; turns that did not finish count too. */
  index: number;
  question: string;
  answer: string;
  status: TurnStatus;
}

/** The fields of a chat message a turn is built from. */
export interface TurnMessage {
  role: "user" | "assistant";
  content: string;
  status: "done" | "streaming" | "error" | "cancelled";
  route?: string;
  truncated?: boolean;
}

/** The judge sees the last four turns, each message up to 10,000 characters. */
export const JUDGE_TURNS = 4;
export const JUDGE_MESSAGE_CHARS = 10_000;
/** The other modules see the turns the summary does not cover, each message up to 4,000 characters. */
export const MODULE_MESSAGE_CHARS = 4_000;
/** At least the last two turns go word for word, even when the summary covers them. */
export const MODULE_MIN_TURNS = 2;
/** When the summary keeps failing, the other modules still get at most eight turns. */
export const MODULE_MAX_TURNS = 8;

/** Notes after an answer that did not finish; the prompts explain them. */
export const TURN_NOTES: Record<Exclude<TurnStatus, "done" | "clarify">, string> = {
  cancelled: "[answer stopped by the user]",
  error: "[answer failed]",
  truncated: "[answer cut off at the length limit]",
};

/** Every turn of a conversation; an answer still streaming is not a turn yet. */
export function turnsOf(messages: TurnMessage[]): TurnRecord[] {
  const turns: TurnRecord[] = [];
  messages.forEach((m, i) => {
    const answer = messages[i + 1];
    if (m.role !== "user" || !m.content.trim() || answer?.role !== "assistant" || answer.status === "streaming") return;
    turns.push({ index: turns.length + 1, question: m.content, ...answerOf(answer) });
  });
  return turns;
}

function answerOf(m: TurnMessage): { answer: string; status: TurnStatus } {
  // The error text is for the user; the model only needs to know there was no answer.
  if (m.status === "error") return { answer: TURN_NOTES.error, status: "error" };
  if (m.status === "cancelled") return { answer: note(m.content, TURN_NOTES.cancelled), status: "cancelled" };
  if (m.truncated) {
    const notice = `\n\n${t("chat.truncated")}`;
    const text = m.content.endsWith(notice) ? m.content.slice(0, -notice.length) : m.content;
    return { answer: note(text, TURN_NOTES.truncated), status: "truncated" };
  }
  return { answer: m.content, status: m.route === "clarify" ? "clarify" : "done" };
}

function note(text: string, mark: string): string {
  return text.trim() ? `${text.trimEnd()}\n${mark}` : mark;
}

/**
 * Keep a long message's start and end: a pasted text usually ends with what
 * is asked about it. The result depends on the message alone, so a turn is
 * cut the same way in every request and the prompt cache still matches.
 */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n[... ${text.length - max} of ${text.length} characters omitted ...]\n${text.slice(-tail)}`;
}

export function judgeTurns(turns: TurnRecord[]): TurnRecord[] {
  return turns.slice(-JUDGE_TURNS);
}

/** The turns after `coveredTurns`; never fewer than two, never more than eight. */
export function moduleTurns(turns: TurnRecord[], coveredTurns: number): TurnRecord[] {
  const last = turns.at(-1)?.index ?? 0;
  const from = Math.min(coveredTurns, last - MODULE_MIN_TURNS);
  return turns.filter((turn) => turn.index > from).slice(-MODULE_MAX_TURNS);
}

/** A message that was cut, for the debugger. */
export interface Clipped {
  turn: number;
  role: AIMessage["role"];
  original_chars: number;
}

/** Turns as question and answer messages, each cut to `max` characters. */
export function turnMessages(turns: TurnRecord[], max: number): { messages: AIMessage[]; clipped: Clipped[] } {
  const messages: AIMessage[] = [];
  const clipped: Clipped[] = [];
  for (const turn of turns) {
    for (const [role, content] of [
      ["user", turn.question],
      ["assistant", turn.answer],
    ] as const) {
      if (content.length > max) clipped.push({ turn: turn.index, role, original_chars: content.length });
      messages.push({ role, content: capText(content, max) });
    }
  }
  return { messages, clipped };
}
