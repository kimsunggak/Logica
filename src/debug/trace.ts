/**
 * Runtime trace events for the visual debugger.
 *
 * During `npm run tauri dev` a chat turn reports every step it runs
 * (function, caller, input, output, timing). Events go to the Rust backend
 * (`debug_trace`), which prints them in the terminal and streams them to the
 * standalone page at http://127.0.0.1:1430. Production builds and the
 * browser demo send nothing.
 *
 * Secrets are masked here before an event leaves the webview, and again in
 * the backend.
 */
import { call, isDesktop } from "../lib/backend";

/**
 * Where a span runs: the steps of a chat turn, `llm` for model calls (LLM
 * Gateway, Rust), and `summary` for the Summary Module's own trace.
 */
export type TraceModule = "pipeline" | "user" | "orchestrator" | "reply" | "refine" | "answer" | "llm" | "final" | "summary";
export type TraceStatus = "running" | "completed" | "error";

export interface Span {
  traceId: string;
  spanId: string;
  fn: string;
  started: number;
}

/** A value, or a function computing it (only called while tracing). */
export type Lazy = unknown | (() => unknown);

const ENABLED = import.meta.env.DEV && isDesktop();
let counter = 0;

export function tracing(): boolean {
  return ENABLED;
}

const SECRET_KEY = /(token$|secret|password|api[-_]?key|credential|cookie|^authorization$)/i;
const SECRET_TEXT = /\b(sk-[A-Za-z0-9_\-.]{8,}|Bearer\s+[A-Za-z0-9_\-.]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_\-.]+)/g;

/** Mask anything that looks like a credential, at any depth. */
export function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key) && typeof value !== "number" && typeof value !== "boolean" && value != null) return "***";
  if (typeof value === "string") return value.replace(SECRET_TEXT, (m) => (m.startsWith("Bearer") ? "Bearer ***" : m.startsWith("sk-") ? "sk-***" : "***"));
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

function resolve(value: Lazy): unknown {
  return typeof value === "function" ? (value as () => unknown)() : value;
}

function send(event: Record<string, unknown>) {
  if (!ENABLED) return;
  void call("debug_trace", { event: redact({ timestamp: Date.now(), ...event }) }).catch(() => {
    // Tracing must never disturb the app.
  });
}

export function startSpan(
  traceId: string,
  parent: Span | null,
  module: TraceModule,
  fn: string,
  input?: Lazy,
  requestId?: string,
): Span {
  counter += 1;
  const span: Span = { traceId, spanId: `${traceId}:${counter}`, fn, started: performance.now() };
  if (ENABLED) {
    send({
      trace_id: traceId,
      span_id: span.spanId,
      parent_id: parent?.spanId ?? null,
      caller: parent?.fn ?? null,
      module,
      function: fn,
      event_type: "span_start",
      status: "running",
      input: resolve(input),
      ...(requestId ? { request_id: requestId } : {}),
    });
  }
  return span;
}

function finish(span: Span, module: TraceModule, fields: Record<string, unknown>) {
  send({
    trace_id: span.traceId,
    span_id: span.spanId,
    module,
    function: span.fn,
    duration_ms: Math.round((performance.now() - span.started) * 10) / 10,
    ...fields,
  });
}

export function endSpan(span: Span, module: TraceModule, output?: Lazy) {
  if (ENABLED) finish(span, module, { event_type: "span_end", status: "completed", output: resolve(output) });
}

export function failSpan(span: Span, module: TraceModule, error: unknown) {
  if (ENABLED) finish(span, module, { event_type: "span_error", status: "error", error: error instanceof Error ? error.message : String(error) });
}

/** An intermediate value produced while a span runs. */
export function spanData(span: Span, module: TraceModule, label: string, value: Lazy) {
  if (ENABLED) send({ trace_id: span.traceId, span_id: span.spanId, module, function: span.fn, event_type: "span_data", status: "running", data: { label, value: resolve(value) } });
}

/** A step that finishes immediately (prompt building, parsing). */
export function step(traceId: string, parent: Span, module: TraceModule, fn: string, input: Lazy, output: Lazy) {
  const span = startSpan(traceId, parent, module, fn, input);
  endSpan(span, module, output);
}

/** Run `body` as a span; its result (or `output(result)`) becomes the span output. */
export async function traced<T>(
  traceId: string,
  parent: Span | null,
  module: TraceModule,
  fn: string,
  input: Lazy,
  body: (span: Span) => Promise<T>,
  output?: (result: T) => unknown,
): Promise<T> {
  const span = startSpan(traceId, parent, module, fn, input);
  try {
    const result = await body(span);
    endSpan(span, module, () => (output ? output(result) : result));
    return result;
  } catch (err) {
    failSpan(span, module, err);
    throw err;
  }
}
