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
import starterMain from "../../src-tauri/templates/main.tex?raw";

const DEMO_ROOT = "/demo/sample-paper";
const STARTER_BASE = "/demo/My Paper";
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

function editBlock(path: string, original: string, revised: string): string {
  return `\`\`\`edit ${path}\n<<<<<<< ORIGINAL\n${original}\n=======\n${revised}\n>>>>>>> REVISED\n\`\`\``;
}

/** Chat agent: edit blocks for the current paragraph, or for every file on a paper-wide request. */
function simulateAgent(userMessage: string, instruction: string, target: string | undefined): string {
  const files = [...userMessage.matchAll(/<file path="([^"]+)">\n([\s\S]*?)\n<\/file>/g)].map((m) => ({ path: m[1], text: m[2] }));
  const blocks: string[] = [];
  if (/whole|entire|across|all|전체|모든|통일/i.test(instruction)) {
    for (const file of files) {
      const line = file.text
        .split("\n")
        .find((l) => l.length > 40 && !/^\s*[\\%]/.test(l) && demoRewrite(l, instruction) !== l.trim());
      if (line && blocks.length < 4) blocks.push(editBlock(file.path, line.trim(), demoRewrite(line, instruction)));
    }
  } else if (target) {
    const path = between(userMessage, "current_file") ?? files[0]?.path ?? "main.tex";
    blocks.push(editBlock(path, target, demoRewrite(target, instruction)));
  }
  if (blocks.length === 0) return "Place the cursor in a paragraph or select text, and I will suggest an edit for it.";
  return `I tightened the wording and kept citations, labels and LaTeX commands unchanged.\n\n${blocks.join("\n\n")}`;
}

function simulateAnswer(userMessage: string): string {
  const instruction = between(userMessage, "instruction") ?? between(userMessage, "user_message") ?? "";
  const selected = between(userMessage, "selected_text");
  if (userMessage.includes("<instruction>") && selected !== undefined) return demoRewrite(selected, instruction);
  if (userMessage.includes("<project_files>")) return simulateAgent(userMessage, instruction, selected ?? between(userMessage, "current_paragraph"));
  const target = selected ?? between(userMessage, "current_paragraph");
  if (!target) return "Place the cursor in a paragraph or select text, and I will suggest an edit for it.";
  return `Here is a tighter version that keeps the citations and LaTeX commands unchanged:\n\n\`\`\`latex\n${demoRewrite(target, instruction)}\n\`\`\`\n\nReview it as a diff before applying.`;
}

function openAIStream(text: string): string[] {
  const events = [`event: response.created\ndata: ${JSON.stringify({ type: "response.created" })}\n\n`];
  for (let i = 0; i < text.length; i += 14) {
    events.push(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text.slice(i, i + 14) })}\n\n`);
  }
  events.push(
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 900, output_tokens: Math.ceil(text.length / 4) } } })}\n\n`,
  );
  return events;
}

function anthropicStream(text: string): string[] {
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 900 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: ping\ndata: {"type": "ping"}\n\n`,
  ];
  for (let i = 0; i < text.length; i += 14) {
    events.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 14) } })}\n\n`);
  }
  events.push(
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: Math.ceil(text.length / 4) } })}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  );
  return events;
}

// ------------------------------------------------------------------ backend

export function createDemoBackend(): DemoBackend {
  // One in-memory file map per project folder; `files` is the one the current call targets.
  const projects = new Map<string, Map<string, DemoFile>>();
  let files = new Map<string, DemoFile>();
  projects.set(DEMO_ROOT, files);
  const starter = (root: string) => {
    if (!projects.has(root)) projects.set(root, new Map([["main.tex", { content: starterMain, mtime: Date.now() }]]));
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
    create_starter_project: ({ reuse }) => {
      if (reuse || !projects.has(STARTER_BASE)) return starter(STARTER_BASE);
      let n = 2;
      while (projects.has(`${STARTER_BASE} ${n}`)) n++;
      return starter(`${STARTER_BASE} ${n}`);
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
            { slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list" },
            { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list" },
            { slug: "internal-preview", display_name: "Hidden", visibility: "hide" },
          ],
        };
      }
      return provider === "openai"
        ? { data: [{ id: "gpt-6-sol", created: 3 }, { id: "gpt-6-luna", created: 2 }, { id: "text-embedding-3-large", created: 1 }] }
        : { data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }, { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] };
    },
    ai_stream: async ({ request, onEvent }) => {
      const channel = onEvent as Channel;
      const { requestId, provider, body, auth } = request as { requestId: string; provider: string; body: Record<string, any>; auth?: string | null };
      credentialFor(provider, auth);
      const messages: { content: string }[] = provider === "openai" ? body.input : body.messages;
      const answer = simulateAnswer(messages[messages.length - 1]?.content ?? "");
      const stream = (provider === "openai" ? openAIStream(answer) : anthropicStream(answer)).join("");
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
        if (!projects.has(root) && root.startsWith(STARTER_BASE)) starter(root);
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
