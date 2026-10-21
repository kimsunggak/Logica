/**
 * The Section Summary Module's one tool: a summary for each section it was
 * given, by the section's key.
 */
import type { ToolDefinition } from "../types";

export const WRITE_SECTION_SUMMARIES = "write_section_summaries";

export const SECTION_TOOLS: ToolDefinition[] = [
  {
    name: WRITE_SECTION_SUMMARIES,
    description: "Save the summary of every section in <sections>, by its key.",
    parameters: {
      type: "object",
      properties: {
        summaries: {
          type: "array",
          description: "One entry per section, in the order given.",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: 'The section\'s key, as given (such as "3.2").' },
              summary: { type: "string", description: "Two to four sentences on what the section contains and claims." },
            },
            required: ["key", "summary"],
            additionalProperties: false,
          },
        },
      },
      required: ["summaries"],
      additionalProperties: false,
    },
  },
];
