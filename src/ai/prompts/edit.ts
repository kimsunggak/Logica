/** Generate one apply_paper_edits tool call for the author to review. */
import type { AIRequest } from "../types";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { paperMapBlock } from "./judge";
import { paperPrompt } from "./paper";

export function buildEditPrompt(request: AIRequest): PromptPayload {
  const task = [
    "You are the Paper Edit Module. Propose manuscript changes requested by the user by calling apply_paper_edits exactly once, or clarify_request if a necessary detail cannot be resolved.",
    "Use the original user_message and refined_request together. The original is authoritative for intent, negation, conditions and scope.",
    "Only edit the sections listed in editable_sections (a parent includes its subsections). Other full sections are read-only references. Summaries provide context; ORIGINAL must be copied exactly from an editable full source block.",
    "For each edit, use the exact source path, a unique ORIGINAL substring, and its complete REVISED replacement. Include unchanged context needed to make ORIGINAL unique. Edits must not overlap. Return all places and files in the same tool call.",
    "For insertion, replace an existing anchor with the anchor plus the inserted text. For deletion, revised can be empty.",
    "Keep the paper's language and style. Preserve LaTeX commands, labels, citation/reference keys, math and environments unless the user requests changing them. Do not invent facts, measurements, citations or claims.",
    "In summary explain the proposed changes briefly in the user's language. The author will review a diff and apply them; describe them as proposals awaiting application.",
  ].join("\n");
  const payload = paperPrompt(request, [paperMapBlock(request), tag("editable_sections", request.editSections?.join(", ") ?? ""), tag("user_message", request.instruction), tag("refined_request", request.refinedQuestion ?? ""), tag("task", task)]);
  return { ...payload, system: `${payload.system}\n\n${task}` };
}
