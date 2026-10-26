/** Intent routing, source selection, and source editing are separate tools. */
import type { ExecutionMode, ToolDefinition } from "../types";

export const ALL_SECTIONS = "all";
export const ROUTE_CHAT = "route_chat";
export const ROUTE_EDIT = "route_edit";
export const CLARIFY_REQUEST = "clarify_request";
export const SELECT_CHAT_SECTIONS = "select_chat_sections";
export const SELECT_EDIT_SECTIONS = "select_edit_sections";
export const APPLY_PAPER_EDITS = "apply_paper_edits";

const reason = { type: "string", description: "One sentence explaining this choice, in the user's language." };
const keys = (description: string) => ({ type: "array", items: { type: "string" }, description });
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const CLARIFY_TOOL: ToolDefinition = {
  name: CLARIFY_REQUEST,
  description: "Ask one concise question when the request, target, or desired change cannot be resolved from the conversation. Do not guess.",
  parameters: object({ question: { type: "string", description: "The question to show the user, in their language." } }),
};

/** Auto alone classifies intent. These tools do not select sections. */
export const CHAT_TOOLS: ToolDefinition[] = [
  { name: ROUTE_CHAT, description: "Discuss, explain, evaluate or answer a question without changing the paper. Includes greetings and general guidance.", parameters: object({ reason }) },
  { name: ROUTE_EDIT, description: "The user explicitly requests changes to their manuscript. A question about a possible change is discussion, not permission to edit.", parameters: object({ reason }) },
  CLARIFY_TOOL,
];

export function sectionTools(mode: ExecutionMode): ToolDefinition[] {
  return [mode === "edit" ? {
    name: SELECT_EDIT_SECTIONS,
    description: "Select the sections to modify and the additional sections to read word for word as references. Use keys from paper_map.",
    parameters: object({
      reason,
      edit_sections: keys('Sections to modify, including any affected subsections. Must not be empty. ["all"] means the whole paper.'),
      reference_sections: keys('Additional sections needed word for word for terminology, facts or consistency. [] if unnecessary; ["all"] for all.'),
    }),
  } : {
    name: SELECT_CHAT_SECTIONS,
    description: "Select sections whose exact source is needed to answer. The remaining sections are provided as summaries.",
    parameters: object({ reason, sections: keys('Keys to read word for word. [] when summaries suffice or for small talk. ["all"] for the whole paper.') }),
  }, CLARIFY_TOOL];
}

export const EDIT_TOOLS: ToolDefinition[] = [{
  name: APPLY_PAPER_EDITS,
  description: "Propose exact replacements in the editable paper sources. The app shows a diff and executes these replacements when the author applies them. One call contains every change, including changes in multiple files.",
  parameters: object({
    summary: { type: "string", description: "Briefly explain the proposed changes in the user's language. They are awaiting application." },
    edits: {
      type: "array",
      minItems: 1,
      items: object({
        path: { type: "string", description: "Exact project-relative path from an editable source block." },
        original: { type: "string", description: "Exact, unique text copied from that editable source; include enough context to locate it." },
        revised: { type: "string", description: "The complete replacement for original. An empty string deletes original." },
      }),
    },
  }),
}, CLARIFY_TOOL];
