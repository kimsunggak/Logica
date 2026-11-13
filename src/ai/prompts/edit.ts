/** Generate one apply_paper_edits tool call for the author to review. */
import type { AIRequest, WebEvidence } from "../types";
import { tag } from "./context";
import type { PromptPayload } from "./index";
import { paperMapBlock } from "./judge";
import { paperPrompt } from "./paper";

/** With web evidence: outside facts come only from the findings, and each edit names the ones it uses. */
const EVIDENCE_RULES = [
  "<web_evidence> lists what a web search found for this request, as findings W1, W2, ... with the sources each cites. Facts from outside the paper may come only from these findings: use them as they are stated and add no details they do not state.",
  "For every edit, list in evidence the ids of the findings it relies on, or [] when it uses none.",
  "Do not add \\cite keys the paper does not already use. When a change relies on a source the paper does not cite yet, name that source (title and link) in summary so the author can add the reference.",
];

const GAPS_RULE = "<research_gaps> lists what the web search could not find. Do not fill these gaps from memory: leave that part out, or call clarify_request if the change cannot be made without it.";

function formatEvidence(evidence: WebEvidence[]): string {
  return evidence.map((e) => [
    `[${e.id}] ${e.finding}`,
    ...e.sources.map((s) => `  source: ${s.title ? `${s.title} (${s.url})` : s.url}${s.quote ? `\n  quote: "${s.quote}"` : ""}`),
  ].join("\n")).join("\n");
}

export function buildEditPrompt(request: AIRequest): PromptPayload {
  const evidence = request.webEvidence ?? [];
  const gaps = request.researchGaps ?? [];
  const task = [
    "You are the Paper Edit Module. Propose manuscript changes requested by the user by calling apply_paper_edits exactly once, or clarify_request if a necessary detail cannot be resolved.",
    "Use the original user_message and refined_request together. The original is authoritative for intent, negation, conditions and scope.",
    "Only edit the sections listed in editable_sections (a parent includes its subsections). Other full sections are read-only references. Summaries provide context; ORIGINAL must be copied exactly from an editable full source block.",
    "For each edit, use the exact source path, a unique ORIGINAL substring, and its complete REVISED replacement. Include unchanged context needed to make ORIGINAL unique. Edits must not overlap. Return all places and files in the same tool call.",
    "For insertion, replace an existing anchor with the anchor plus the inserted text. For deletion, revised can be empty.",
    "Keep the paper's language and style. Preserve LaTeX commands, labels, citation/reference keys, math and environments unless the user requests changing them. Do not invent facts, measurements, citations or claims.",
    "A tabular does not shrink to fit its column, and text in l or c columns never wraps. When you write or change a table in a two-column paper, keep it within \\columnwidth: give long cells p{...} or tabularx X columns sized as fractions of \\columnwidth that leave room for the padding between columns, put a table with many or long columns in table* so it spans both columns, and use \\resizebox{\\columnwidth}{!}{...} only when the paper already loads graphicx. Otherwise the table runs into the other column.",
    "In summary explain the proposed changes briefly in the user's language. The author will review a diff and apply them; describe them as proposals awaiting application.",
    ...(evidence.length ? EVIDENCE_RULES : []),
    ...(gaps.length ? [GAPS_RULE] : []),
  ].join("\n");
  const payload = paperPrompt(request, [
    paperMapBlock(request),
    tag("editable_sections", request.editSections?.join(", ") ?? ""),
    evidence.length ? tag("web_evidence", formatEvidence(evidence)) : "",
    gaps.length ? tag("research_gaps", gaps.map((g) => `- ${g}`).join("\n")) : "",
    tag("user_message", request.instruction),
    tag("refined_request", request.refinedQuestion ?? ""),
    tag("task", task),
  ]);
  return { ...payload, system: `${payload.system}\n\n${task}` };
}
