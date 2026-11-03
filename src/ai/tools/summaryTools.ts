/**
 * The Session Summary Module's one tool: the changes to the session summary. Every
 * field is required for strict schemas; an operation sets the fields it
 * does not use to "" (or 0).
 */
import type { ToolDefinition } from "../types";

export const UPDATE_SUMMARY = "update_summary";

export const SUMMARY_TOOLS: ToolDefinition[] = [
  {
    name: UPDATE_SUMMARY,
    description: "Apply changes to the session summary. List only what changed; items you leave out stay as they are.",
    parameters: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "The changes, in order. Empty when nothing changed.",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["set_topic", "set_goal", "add", "replace"] },
              kind: { type: "string", enum: ["preference", "history", "reference", ""], description: 'For add: what the item is. Otherwise "".' },
              id: { type: "string", description: 'For replace: the item id, such as P2 or R1. Otherwise "".' },
              text: { type: "string", description: "The topic, the goal or the item's text." },
              turn: { type: "integer", description: "For add and replace: the turn the item comes from. Otherwise 0." },
            },
            required: ["op", "kind", "id", "text", "turn"],
            additionalProperties: false,
          },
        },
      },
      required: ["ops"],
      additionalProperties: false,
    },
  },
];
