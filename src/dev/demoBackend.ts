/**
 * In-memory backend used only when the frontend runs in a plain browser during
 * development (`npm run dev`). It lets the UI be exercised end to end without
 * the native shell: files live in memory, compilation produces a simple PDF
 * and AI responses are simulated in each provider's real streaming format so
 * the provider adapters run unchanged.
 *
 * Never bundled into production builds (see lib/backend.ts).
 */
import type { DemoBackend } from "../lib/backend";
import { buildPaperDocument, locateGi } from "../latex/parser/documentModel";
import { latexToPlain, maskComments } from "../latex/parser/text";
import mainTex from "../../examples/sample-paper/main.tex?raw";
import introTex from "../../examples/sample-paper/sections/introduction.tex?raw";
import relatedTex from "../../examples/sample-paper/sections/related_work.tex?raw";
import methodTex from "../../examples/sample-paper/sections/method.tex?raw";
import experimentsTex from "../../examples/sample-paper/sections/experiments.tex?raw";
import referencesBib from "../../examples/sample-paper/references.bib?raw";
import type { PaperTemplateId } from "../project/templates";

const DEMO_ROOT = "/demo/sample-paper";
/** First folder of each paper template, as in create_starter_project. */
const STARTER_BASES: Record<PaperTemplateId, string> = { blank: "/demo/My Paper", cvpr: "/demo/CVPR Paper" };
const STATE_KEY = "logica-demo-state";

interface DemoFile {
  content: string | Uint8Array;
  mtime: number;
}

type Channel = { onmessage: (message: unknown) => void };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(kind: string, message: string, extra: Record<string, unknown> = {}): never {
  throw { kind, message, ...extra };
}

// The same template files the desktop app embeds (src-tauri/templates/<id>/...).
const TEMPLATE_SOURCES = import.meta.glob<string>("../../src-tauri/templates/**/*", { query: "?raw", import: "default", eager: true });

/** `[path in the project, content]` of every file of a paper template. */
function templateFiles(template: PaperTemplateId): [string, string][] {
  const prefix = `../../src-tauri/templates/${template}/`;
  return Object.entries(TEMPLATE_SOURCES)
    .filter(([source]) => source.startsWith(prefix))
    .map(([source, content]) => [source.slice(prefix.length), content]);
}

// ------------------------------------------------------------------ PDF

function pdfEscape(text: string): string {
  return text
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Build a small multi-page PDF from styled lines. */
function makePdf(lines: { text: string; size: number; bold?: boolean }[]): Uint8Array {
  const pages: string[] = [];
  let ops: string[] = [];
  let y = 740;
  const flush = () => {
    pages.push(ops.join("\n"));
    ops = [];
    y = 740;
  };
  for (const line of lines) {
    const height = line.size * 1.5;
    if (y - height < 60) flush();
    y -= height;
    ops.push(`BT /${line.bold ? "F2" : "F1"} ${line.size} Tf 72 ${y.toFixed(1)} Td (${pdfEscape(line.text)}) Tj ET`);
  }
  if (ops.length) flush();

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  const kids: string[] = [];
  pages.forEach((content, i) => {
    const pageId = 5 + i * 2;
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((current + " " + word).trim().length > width) {
      lines.push(current);
      current = word;
    } else current = `${current} ${word}`.trim();
  }
  if (current) lines.push(current);
  return lines;
}

function renderPaper(files: Map<string, string>, mainFile: string): Uint8Array {
  const doc = buildPaperDocument({ mainFile, files });
  const lines: { text: string; size: number; bold?: boolean }[] = [];
  lines.push({ text: doc.title ?? "Untitled", size: 16, bold: true });
  lines.push({ text: "(browser preview: simplified rendering)", size: 9 });
  if (doc.abstract) {
    lines.push({ text: "Abstract", size: 11, bold: true });
    for (const l of wrap(latexToPlain(doc.abstract), 95)) lines.push({ text: l, size: 10 });
  }
  const headingAt = new Map(doc.flatSections.map((s) => [s.startGi, s]));
  const fileLines = new Map([...files].map(([p, t]) => [p, maskComments(t).split("\n")]));
  let paragraph = "";
  const flushParagraph = () => {
    for (const l of wrap(paragraph, 95)) lines.push({ text: l, size: 10 });
    paragraph = "";
  };
  const start = doc.flatSections[0]?.startGi ?? doc.totalLines;
  for (let g = start; g < doc.totalLines; g++) {
    const loc = locateGi(doc.spans, g);
    if (!loc) continue;
    const raw = fileLines.get(loc.filePath)?.[loc.line - 1] ?? "";
    const section = headingAt.get(g);
    if (section) {
      flushParagraph();
      lines.push({ text: `${section.number ?? ""} ${section.title}`.trim(), size: section.level <= 1 ? 13 : 11, bold: true });
      continue;
    }
    if (!raw.trim()) {
      flushParagraph();
      continue;
    }
    if (/\\(begin|end|label|input|include|bibliography|caption|centering|toprule|midrule|bottomrule)/.test(raw)) continue;
    paragraph += ` ${latexToPlain(raw.replace(/\\item/g, "-"))}`;
  }
  flushParagraph();
  return makePdf(lines);
}

// ------------------------------------------------------------------ AI simulation

const CONCISE_RULES: [RegExp, string][] = [
  [/do\s+not\s+consider\s+uncertainty\s+and\s+therefore\s+have\s+problems\s+when\s+the\s+image\s+is\s+occluded/g, "do not explicitly model uncertainty,\nmaking them vulnerable to severe occlusion"],
  [/\s*,?\s*which\s+is\s+very\s+common\s+in\s+real\s+world\s+videos\s+where\s+people\s+overlap\s+with\s+each\s+other\s+or\s+with\s+objects\s+in\s+the\s+scene/g, ", which is common in real-world videos"],
  [/\bvery\s+/g, ""],
  [/\bin order to\b/g, "to"],
  [/\bAs a matter of fact,\s*/g, ""],
  [/\bfor example\b/g, "e.g."],
];

function demoRewrite(text: string, instruction: string): string {
  let out = text;
  for (const [pattern, replacement] of CONCISE_RULES) out = out.replace(pattern, replacement);
  if (out === text) {
    out = /grammar/i.test(instruction) ? text.replace(/\s{2,}/g, " ") : text.replace(/\bWe\b/, "In this work, we");
  }
  return out.trim();
}

function between(text: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return m?.[1];
}

/** A demo model reply: text, or a function call. */
type DemoReply = { text: string } | { tool: { name: string; args: Record<string, unknown> } };

const EDIT_REQUEST = /rewrite|shorten|tighten|fix|improve|unify|make|change|remove|add|translate|수정|고쳐|줄여|바꿔|다듬|통일|추가|삭제|번역/i;
const SMALL_TALK = /^\s*(hi|hello|hey|thanks|thank you|ok|okay|안녕|고마워|고맙|감사|좋아|알겠어)/i;
const hangul = (text: string) => /[가-힣]/.test(text);

/** Sections of the paper map whose title the question names, such as "Section 3" or "the Method". */
function namedSections(last: string, question: string): string[] {
  const map = /<paper_map summaries="[^"]*">\n([\s\S]*?)\n<\/paper_map>/.exec(last)?.[1] ?? "";
  const asked = question.toLowerCase();
  const keys: string[] = [];
  for (const m of map.matchAll(/^\s*\[([^\]]+)\] ([^(\n]+?) \(/gm)) {
    if (asked.includes(m[2].toLowerCase()) || new RegExp(`\\b(section|sec\\.?|§)\\s*${m[1].replace(/\./g, "\\.")}\\b`, "i").test(question)) keys.push(m[1]);
  }
  return keys;
}

/** Browser demo only; production intent classification is performed by the model. */
function simulateJudge(last: string): DemoReply {
  const question = between(last, "user_message") ?? "";
  const edit = EDIT_REQUEST.test(question) && !/\?|않|말고|what|why|would|should/i.test(question);
  return { tool: { name: edit ? "route_edit" : "route_chat", args: { reason: edit ? "The user requests manuscript changes." : "The user requests discussion or an answer." } } };
}

function demoClarify(question: string): DemoReply {
  return { tool: { name: "clarify_request", args: { question: hangul(question) ? "어느 부분을 말씀하시는 건가요? 섹션이나 문장을 알려 주세요." : "Which part do you mean? Name the section or quote the sentence." } } };
}

function simulateSelection(last: string, edit: boolean): DemoReply {
  const question = between(last, "user_message") ?? "";
  if (/^(이거|그거|this|that)\s*\??$/i.test(question)) return demoClarify(question);
  const sections = namedSections(last, question);
  if (edit) {
    if (!sections.length && !/whole|entire|across|전체|통일/i.test(question)) return demoClarify(question);
    return { tool: { name: "select_edit_sections", args: { reason: "Read the requested edit targets and preserve the rest.", edit_sections: sections.length ? sections : ["all"], reference_sections: [] } } };
  }
  return { tool: { name: "select_chat_sections", args: { reason: "Read the sections named by the question.", sections } } };
}

function simulatePaperEdit(all: string, last: string): DemoReply {
  const question = between(last, "user_message") ?? "";
  const keys = (between(last, "editable_sections") ?? "").split(",").map((key) => key.trim());
  const edits: { path: string; original: string; revised: string }[] = [];
  const blocks = [...all.matchAll(/<section key="([^"]+)" title="[^"]*" content="full">\n([\s\S]*?)\n<\/section>/g)];
  for (const block of blocks) {
    if (!keys.includes("all") && !keys.some((key) => block[1] === key || block[1].startsWith(key + "."))) continue;
    for (const source of block[2].matchAll(/<source file="([^"]+)" lines="[^"]*">\n([\s\S]*?)\n<\/source>/g)) {
      const original = source[2].split("\n").find((line) => line.length > 40 && !/^\s*[\\%]/.test(line));
      if (original) {
        const revised = demoRewrite(original, question);
        if (revised !== original) edits.push({ path: source[1], original, revised });
      }
    }
  }
  if (!edits.length) return demoClarify(question);
  return { tool: { name: "apply_paper_edits", args: { summary: hangul(question) ? "요청하신 부분의 수정안입니다. diff를 확인하고 적용해 주세요." : "Proposed changes are ready for review. Apply the diff to update the paper.", edits } } };
}

/** Paper Summary Module: the first sentence of each section, as plain text. */
function simulateSectionSummaries(last: string): DemoReply {
  const summaries = [...last.matchAll(/<section key="([^"]+)" title="([^"]*)">\n([\s\S]*?)\n<\/section>/g)].map((m) => {
    const text = latexToPlain(m[3].replace(/\\(?:sub)*section\*?\{[^}]*\}/g, "")).replace(/\s+/g, " ").trim();
    const first = /^.*?[.!?](\s|$)/.exec(text)?.[0]?.trim() ?? text.slice(0, 160);
    return { key: m[1], summary: `${m[2]}: ${first || "(no text)"}` };
  });
  return { tool: { name: "write_section_summaries", args: { summaries } } };
}

/** Keep demo refinement literal; reference resolution is tested with scripted models. */
function simulateRefine(last: string): string {
  return (between(last, "user_message") ?? "").trim();
}

/** Answer Module: edit blocks for an edit request, otherwise a short demo answer. */
function simulateAnswerModule(all: string, last: string): string {
  const question = between(last, "user_message") ?? "";
  if (SMALL_TALK.test(question) && question.length < 40) return hangul(question) ? "천만에요! 논문에 대해 궁금한 점을 물어보세요." : "You're welcome! Ask me anything about the paper.";
  const refined = between(last, "refined_question");
  const files = [...all.matchAll(/<file path="([^"]+)">/g)].map((m) => m[1]);
  const full = [...all.matchAll(/<section key="([^"]+)" title="[^"]*" content="full">/g)].map((m) => m[1]);
  const read = all.includes('content="summary"') ? `sections ${full.join(", ")} word for word and the others as summaries` : `the whole paper (${files.join(", ") || "no files"})`;
  const answer = `Demo answer to "${refined ?? question}". In the desktop app, the connected model answers from ${read}.`;
  // Ask about "markdown" or "형식" to see how answers are rendered.
  if (!/markdown|마크다운|형식/i.test(question)) return answer;
  return [
    answer,
    "",
    "### 답변 형식 미리보기",
    "",
    "이 문단은 **강조**한다. **'인용'**이라는 표현과 **서론(Introduction)**에서는 처럼 한국어 조사가 붙어도 굵게 보입니다.",
    "",
    "1. 인라인 수식: $E = mc^2$, 그리고 \\(\\alpha + \\beta\\)",
    "2. `\\cite{key}` 같은 인라인 코드",
    "3. [LaTeX 문서](https://www.latex-project.org/help/documentation/) 링크",
    "",
    "\\[ \\int_0^1 x^2\\,dx = \\frac{1}{3} \\]",
    "",
    "> 인용문은 왼쪽 선과 흐린 색으로 표시됩니다.",
    "",
    "| 항목 | 값 |",
    "| --- | --- |",
    "| 정확도 | 95% |",
    "",
    "```latex",
    "\\section{Introduction}",
    "We prove that $f(x) = x^2$ is convex \\cite{boyd2004}.",
    "```",
  ].join("\n");
}

/** Session Summary Module: a topic and a goal once, a preference for "from now on" requests, and a history line per question. */
function simulateSummary(last: string): DemoReply {
  const ops: Record<string, unknown>[] = [];
  const op = (o: { op: string; kind?: string; id?: string; text: string; turn?: number }) => ops.push({ kind: "", id: "", turn: 0, ...o });
  const current = between(last, "current_summary") ?? "";
  if (!/^Topic: /m.test(current)) op({ op: "set_topic", text: "가림에 강한 비디오 자세 추정을 위한 시공간 라우팅" });
  if (!/^Goal: /m.test(current)) op({ op: "set_goal", text: "데모 논문을 함께 읽고 다듬는 중" });
  for (const m of last.matchAll(/<turn number="(\d+)">\nuser: ([\s\S]*?)\nassistant: [\s\S]*?\n<\/turn>/g)) {
    const turn = Number(m[1]);
    const question = m[2].replace(/\s+/g, " ").trim();
    if (/앞으로|항상|from now on|always/i.test(question)) op({ op: "add", kind: "preference", text: question.slice(0, 120), turn });
    else if (!(SMALL_TALK.test(question) && question.length < 40)) op({ op: "add", kind: "history", text: `${question.slice(0, 60)} → 답함`, turn });
  }
  return { tool: { name: "update_summary", args: { ops } } };
}

/** Which call a request body is, from the request itself. */
function simulateReply(body: Record<string, any>, messages: { content: string }[]): DemoReply {
  const last = messages[messages.length - 1]?.content ?? "";
  const all = messages.map((m) => m.content).join("\n\n");
  const tools: string[] = Array.isArray(body.tools) ? body.tools.map((t: { name?: string }) => t.name ?? "") : [];
  if (tools.includes("update_summary")) return simulateSummary(last);
  if (tools.includes("write_section_summaries")) return simulateSectionSummaries(last);
  if (tools.includes("route_chat")) return simulateJudge(last);
  if (tools.includes("select_chat_sections")) return simulateSelection(last, false);
  if (tools.includes("select_edit_sections")) return simulateSelection(last, true);
  if (tools.includes("apply_paper_edits")) return simulatePaperEdit(all, last);
  if (last.includes("<task>\nReply to the user's message.")) {
    const question = between(last, "user_message") ?? "";
    return { text: hangul(question) ? "천만에요! 논문에 대해 궁금한 점을 물어보세요." : "You're welcome! Ask me anything about the paper." };
  }
  const system = String(body.instructions ?? (Array.isArray(body.system) ? body.system.map((b: { text: string }) => b.text).join("\n") : body.system) ?? "");
  if (system.includes("Request Refinement Module")) return { text: simulateRefine(last) };
  if (last.includes("You are the Paper Chat Module")) return { text: simulateAnswerModule(all, last) };
  return { text: simulateAnswer(last) };
}

/** Inline edit: the rewritten selection, or a reviewable suggestion for the paragraph. */
function simulateAnswer(userMessage: string): string {
  const instruction = between(userMessage, "instruction") ?? "";
  const selected = between(userMessage, "selected_text");
  if (userMessage.includes("<instruction>") && selected !== undefined) return demoRewrite(selected, instruction);
  const target = selected ?? between(userMessage, "current_paragraph");
  if (!target) return "Place the cursor in a paragraph or select text, and I will suggest an edit for it.";
  return `Here is a tighter version that keeps the citations and LaTeX commands unchanged:\n\n\`\`\`latex\n${demoRewrite(target, instruction)}\n\`\`\`\n\nReview it as a diff before applying.`;
}

const chunks = (text: string, size = 14) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
const sseEvent = (data: Record<string, unknown>) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

function openAIStream(reply: DemoReply): string[] {
  const events = [sseEvent({ type: "response.created" })];
  let output = 0;
  if ("text" in reply) {
    for (const delta of chunks(reply.text)) events.push(sseEvent({ type: "response.output_text.delta", delta }));
    output = Math.ceil(reply.text.length / 4);
  } else {
    const args = JSON.stringify(reply.tool.args);
    const item = { id: "fc_demo", type: "function_call", call_id: "call_demo", name: reply.tool.name };
    events.push(sseEvent({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }));
    for (const delta of chunks(args)) events.push(sseEvent({ type: "response.function_call_arguments.delta", item_id: "fc_demo", output_index: 0, delta }));
    events.push(
      sseEvent({ type: "response.function_call_arguments.done", item_id: "fc_demo", output_index: 0, arguments: args }),
      sseEvent({ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: args } }),
    );
    output = Math.ceil(args.length / 4);
  }
  events.push(sseEvent({ type: "response.completed", response: { usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: output } } }));
  return events;
}

function anthropicStream(reply: DemoReply): string[] {
  const events = [sseEvent({ type: "message_start", message: { usage: { input_tokens: 900 } } })];
  let output = 0;
  if ("text" in reply) {
    events.push(sseEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), `event: ping\ndata: {"type": "ping"}\n\n`);
    for (const text of chunks(reply.text)) events.push(sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
    output = Math.ceil(reply.text.length / 4);
  } else {
    const args = JSON.stringify(reply.tool.args);
    events.push(sseEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_demo", name: reply.tool.name, input: {} } }));
    for (const partial_json of chunks(args)) events.push(sseEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } }));
    output = Math.ceil(args.length / 4);
  }
  events.push(
    sseEvent({ type: "content_block_stop", index: 0 }),
    sseEvent({ type: "message_delta", delta: { stop_reason: "text" in reply ? "end_turn" : "tool_use" }, usage: { output_tokens: output } }),
    sseEvent({ type: "message_stop" }),
  );
  return events;
}

// ------------------------------------------------------------------ backend

const CHATS_KEY = "logica-demo-chats";
const PAPERS_KEY = "logica-demo-papers";
type DemoSession = { createdAt: number; updatedAt: number; messages: { role: string; content: string }[] };

function demoChats(): Record<string, Record<string, DemoSession>> {
  try {
    return JSON.parse(localStorage.getItem(CHATS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function demoReports(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PAPERS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function createDemoBackend(): DemoBackend {
  // One in-memory file map per project folder; `files` is the one the current call targets.
  const projects = new Map<string, Map<string, DemoFile>>();
  let files = new Map<string, DemoFile>();
  projects.set(DEMO_ROOT, files);
  const starter = (root: string, template: PaperTemplateId) => {
    if (!projects.has(root)) {
      const mtime = Date.now();
      projects.set(root, new Map(templateFiles(template).map(([path, content]) => [path, { content, mtime }])));
    }
    return root;
  };
  const now = Date.now();
  const seed: [string, string][] = [
    ["main.tex", mainTex],
    ["sections/introduction.tex", introTex],
    ["sections/related_work.tex", relatedTex],
    ["sections/method.tex", methodTex],
    ["sections/experiments.tex", experimentsTex],
    ["references.bib", referencesBib],
  ];
  for (const [path, content] of seed) files.set(path, { content, mtime: now });
  const credentials = new Map<string, string>();
  // Simulated Sign in with ChatGPT session (no real OAuth in the browser preview).
  let chatgpt: { email: string; name: string } | null = null;
  let signInAbort: (() => void) | null = null;
  const chatgptStatus = () => ({
    connected: Boolean(chatgpt),
    email: chatgpt?.email ?? null,
    name: chatgpt?.name ?? null,
    planUsage: Boolean(chatgpt),
    storeAvailable: true,
    error: null,
  });
  /** Bearer credential for a request, mirroring ai.rs `credential_for`. */
  const credentialFor = (provider: string, auth: string | null | undefined): string => {
    if (provider === "openai" && auth === "chatgpt") {
      if (!chatgpt) fail("no_credential", "Sign in with ChatGPT in Settings to use your ChatGPT plan.");
      return "chatgpt-demo-token";
    }
    const key = credentials.get(provider);
    if (!key) fail("no_credential", `${provider === "openai" ? "OpenAI" : "Claude (Anthropic)"} is not connected. Add an API key in Settings.`);
    if (key === "invalid") fail("http_error", "Provider returned HTTP 401", { status: 401, body: '{"error":{"type":"authentication_error","message":"invalid api key"}}' });
    return key;
  };
  const cancelled = new Set<string>();
  const cancelledJobs = new Set<string>();

  const text = (path: string): string => {
    const file = files.get(path);
    if (!file) fail("not_found", `No such file: ${path}`);
    return typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content);
  };

  const status = (provider: string) => {
    const secret = credentials.get(provider);
    return {
      provider,
      stored: Boolean(secret),
      method: secret ? "api_key" : null,
      hint: secret ? `…${secret.slice(-4)}` : null,
      storeAvailable: true,
      error: null,
    };
  };

  const handlers: Record<string, (args: Record<string, any>) => Promise<unknown> | unknown> = {
    list_project_files: ({ root }) => ({
      root,
      truncated: false,
      entries: [...files.entries()]
        .filter(([p]) => /\.(tex|bib)$/.test(p))
        .map(([path, f]) => ({ path, size: typeof f.content === "string" ? f.content.length : f.content.byteLength, mtime: f.mtime })),
    }),
    read_text_file: ({ path }) => ({ content: text(path), mtime: files.get(path)!.mtime, lossy: false }),
    write_text_file: ({ path, content, expectedMtime, force }) => {
      const existing = files.get(path);
      if (existing && expectedMtime != null && !force && existing.mtime !== expectedMtime) {
        fail("conflict", `${path} was modified outside LOGICA`);
      }
      const mtime = Math.max(Date.now(), (existing?.mtime ?? 0) + 1);
      files.set(path, { content, mtime });
      return { mtime };
    },
    stat_files: ({ paths }) => (paths as string[]).map((path) => ({ path, mtime: files.get(path)?.mtime ?? null })),
    read_binary_file: ({ path }) => {
      const file = files.get(path);
      if (!file || typeof file.content === "string") fail("not_found", `No such file: ${path}`);
      return file.content.slice().buffer;
    },
    path_exists: ({ path }) => files.has(path),
    create_starter_project: ({ template, reuse }) => {
      if (!(template in STARTER_BASES)) fail("invalid_template", `unknown paper template: ${template}`);
      const base = STARTER_BASES[template as PaperTemplateId];
      if (reuse || !projects.has(base)) return starter(base, template);
      let n = 2;
      while (projects.has(`${base} ${n}`)) n++;
      return starter(`${base} ${n}`, template);
    },
    export_pdf: ({ path }) => {
      // The browser has no save dialog API here; download the file instead.
      const file = files.get(path);
      if (!file || typeof file.content === "string") fail("not_found", `${path} is not a compiled PDF`);
      const url = URL.createObjectURL(new Blob([file.content.slice()], { type: "application/pdf" }));
      const link = Object.assign(document.createElement("a"), { href: url, download: path.split("/").pop() });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return `Downloads/${link.download}`;
    },
    detect_compilers: () => [{ name: "latexmk", path: "(browser preview)" }],
    compile_latex: async ({ request }) => {
      // Like a real compiler, work on the project this call was made for, even if
      // other calls switch projects while it runs.
      const project = files;
      const read = (f: DemoFile) => (typeof f.content === "string" ? f.content : new TextDecoder().decode(f.content));
      // Tests can slow the simulated compiler down to exercise cancellation.
      await sleep((globalThis as { __LOGICA_DEMO_COMPILE_MS?: number }).__LOGICA_DEMO_COMPILE_MS ?? 400);
      if (request.jobId && cancelledJobs.delete(request.jobId)) fail("cancelled", "Compilation cancelled");
      const main = request.mainFile as string;
      const texts = new Map([...project].filter(([p]) => p.endsWith(".tex")).map(([p, f]) => [p, read(f)]));
      const broken = [...texts].find(([, t]) => /\\undefinedcommand/.test(t));
      if (broken) {
        const line = broken[1].split("\n").findIndex((l) => l.includes("\\undefinedcommand")) + 1;
        return {
          success: false,
          compiler: "latexmk",
          pdfPath: null,
          pdfMtime: null,
          log: `(./${main}\n./${broken[0]}:${line}: Undefined control sequence.\nl.${line} \\undefinedcommand\n\n`,
          output: "Latexmk: Errors, so I did not complete making targets",
          durationMs: 400,
          timedOut: false,
        };
      }
      const pdfPath = main.replace(/\.tex$/, ".pdf");
      const mtime = Date.now();
      project.set(pdfPath, { content: renderPaper(texts, main), mtime });
      return { success: true, compiler: "latexmk", pdfPath, pdfMtime: mtime, log: "", output: "Output written on main.pdf", durationMs: 400, timedOut: false };
    },
    credential_status: ({ provider }) => status(provider),
    credential_set: ({ provider, secret }) => {
      credentials.set(provider, secret);
      return status(provider);
    },
    credential_delete: ({ provider }) => {
      credentials.delete(provider);
    },
    chatgpt_status: () => chatgptStatus(),
    chatgpt_sign_in: async () => {
      // Stands in for: open browser, user approves, loopback callback, token exchange.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 900);
        signInAbort = () => {
          clearTimeout(timer);
          reject({ kind: "cancelled", message: "ChatGPT sign-in was cancelled." });
        };
      }).finally(() => (signInAbort = null));
      chatgpt = { email: "researcher@example.com", name: "Demo Researcher" };
      return chatgptStatus();
    },
    chatgpt_cancel_sign_in: () => {
      const abort = signInAbort;
      abort?.();
      return Boolean(abort);
    },
    chatgpt_sign_out: () => {
      chatgpt = null;
      return { revoked: true };
    },
    ai_get: ({ provider, auth }) => {
      credentialFor(provider, auth);
      if (provider === "openai" && auth === "chatgpt") {
        return {
          models: [
            { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
            { slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list" },
            { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list" },
            { slug: "internal-preview", display_name: "Hidden", visibility: "hide" },
          ],
        };
      }
      return provider === "openai"
        ? { data: [{ id: "gpt-6.1-sol", created: 4 }, { id: "gpt-6-sol", created: 3 }, { id: "gpt-6-luna", created: 2 }, { id: "text-embedding-3-large", created: 1 }] }
        : { data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }, { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] };
    },
    ai_stream: async ({ request, onEvent }) => {
      const channel = onEvent as Channel;
      const { requestId, provider, body, auth } = request as { requestId: string; provider: string; body: Record<string, any>; auth?: string | null };
      credentialFor(provider, auth);
      // Tests can make every OpenAI call fail to exercise the Claude fallback.
      if (provider === "openai" && (globalThis as { __LOGICA_DEMO_FAIL_OPENAI?: boolean }).__LOGICA_DEMO_FAIL_OPENAI) {
        fail("http_error", "Provider returned HTTP 503", { status: 503, body: '{"error":{"type":"server_error","message":"The demo OpenAI service is unavailable"}}' });
      }
      const messages: { content: string }[] = provider === "openai" ? body.input : body.messages;
      const reply = simulateReply(body, messages);
      const stream = (provider === "openai" ? openAIStream(reply) : anthropicStream(reply)).join("");
      channel.onmessage({ type: "open", status: 200 });
      // Deliver in uneven chunks to exercise the SSE parser.
      for (let i = 0; i < stream.length; ) {
        if (cancelled.has(requestId)) {
          cancelled.delete(requestId);
          fail("cancelled", "Generation cancelled");
        }
        const size = 40 + ((i * 7) % 90);
        channel.onmessage({ type: "chunk", data: stream.slice(i, i + size) });
        i += size;
        await sleep(25);
      }
      channel.onmessage({ type: "done" });
    },
    compile_cancel: ({ jobId }) => {
      cancelledJobs.add(jobId);
      return true;
    },
    ai_cancel: ({ requestId }) => {
      cancelled.add(requestId);
      return true;
    },
    // Saved conversations: localStorage stands in for the app's local data folder.
    chat_list_sessions: ({ root }) =>
      Object.entries(demoChats()[root] ?? {})
        .map(([id, s]) => ({
          id,
          title: (s.messages.find((m) => m.role === "user")?.content ?? "").replace(/\s+/g, " ").slice(0, 60),
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messages.length,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    chat_load_session: ({ root, id }) => demoChats()[root]?.[id] ?? null,
    chat_save_session: ({ root, id, session }) => {
      const all = demoChats();
      all[root] = { ...all[root], [id]: session };
      localStorage.setItem(CHATS_KEY, JSON.stringify(all));
    },
    chat_delete_session: ({ root, id }) => {
      const all = demoChats();
      delete all[root]?.[id];
      localStorage.setItem(CHATS_KEY, JSON.stringify(all));
    },
    // The paper summary (YAML) of each project: localStorage stands in for the local data folder.
    paper_load_summary: ({ root }) => demoReports()[root] ?? null,
    paper_save_summary: ({ root, text }) => {
      localStorage.setItem(PAPERS_KEY, JSON.stringify({ ...demoReports(), [root]: text }));
    },
    load_app_state: () => {
      try {
        const raw = localStorage.getItem(STATE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    save_app_state: ({ state }) => {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    },
  };

  return {
    async invoke(cmd, args = {}) {
      const handler = handlers[cmd];
      if (!handler) fail("unknown_command", `Demo backend does not implement ${cmd}`);
      const root = args.root ?? (args.request as { root?: unknown } | undefined)?.root;
      if (typeof root === "string") {
        // Starter papers live in memory only; recreate one remembered from an earlier page load.
        const template = (Object.keys(STARTER_BASES) as PaperTemplateId[]).find((id) => root.startsWith(STARTER_BASES[id]));
        if (!projects.has(root) && template) starter(root, template);
        if (!projects.has(root)) fail("not_found", `No such folder: ${root}`);
        files = projects.get(root)!;
      }
      return handler(args);
    },
    async openFolderDialog() {
      return DEMO_ROOT;
    },
  };
}
