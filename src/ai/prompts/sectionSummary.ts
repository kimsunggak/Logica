/**
 * Paper Summary Module prompt: summarize sections of the paper for the
 * paper map. The judge reads the map to choose the sections a question needs
 * word for word, and the Refine and Answer modules read the summaries of the
 * sections they do not get word for word. It runs before the first answer
 * about a paper, and after a turn for the sections edited since.
 */
import type { AIRequest } from "../types";
import { WRITE_SECTION_SUMMARIES } from "../tools/sectionTools";
import { formatContext, tag } from "./context";
import type { PromptPayload } from "./index";

const SECTION_RULES = [
  "You are the Paper Summary Module of LOGICA, a LaTeX writing tool for research papers. You write the paper map: one summary for each section of the paper you are given.",
  "Other models read only these summaries to choose which sections to read word for word for a question, and read them in place of the sections they do not open. Say what each section contains and claims, so they can tell whether it holds what a question needs.",
  "Each summary is three or four lines, one sentence per line, in the language of the paper. Name the problem, claim or idea; the method, model or definitions; the datasets, metrics, figures, tables and equations it presents, with their \\label keys; and its key numbers and results. Use the paper's own terms and macro names.",
  "The section with key abstract is the title block and the abstract: summarize the paper's problem, approach and main result from it.",
  "Summarize only the section's own text: its subsections are summarized on their own. A section that holds little more than its heading gets one line saying what it introduces.",
  `Call ${WRITE_SECTION_SUMMARIES} once, with one summary for every section in <sections>, using each section's key.`,
].join("\n");

/** An attribute value that cannot end the attribute. */
export function attr(value: string): string {
  return value.replace(/"/g, "'");
}

export function buildSectionSummaryPrompt(request: AIRequest): PromptPayload {
  const sections = (request.sectionsToSummarize ?? []).map((s) => `<section key="${attr(s.key)}" title="${attr(s.title)}">\n${s.text}\n</section>`);
  const content = [formatContext(request.context, ["paperTitle", "outline"]), tag("sections", sections.join("\n"))].filter(Boolean).join("\n\n");
  return { system: SECTION_RULES, messages: [{ role: "user", content }] };
}
