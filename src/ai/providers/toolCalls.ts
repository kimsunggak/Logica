import type { ToolCall } from "../types";

/** A function call as collected from a stream: arguments are raw JSON text. */
export interface StreamedCall {
  id: string;
  name: string;
  args: string;
}

/** Finished function calls with their JSON arguments parsed. */
export function toToolCalls(calls: StreamedCall[]): ToolCall[] {
  return calls
    .filter((call) => call.name)
    .map((call, i) => {
      let args: Record<string, unknown> = {};
      let argumentsError: ToolCall["argumentsError"];
      try {
        const parsed = JSON.parse(call.args || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
        else argumentsError = "not_object";
      } catch {
        // Invalid JSON arguments: keep the call, without arguments.
        argumentsError = "invalid_json";
      }
      return { id: call.id || `call_${i}`, name: call.name, arguments: args, ...(argumentsError ? { argumentsError } : {}) };
    });
}
