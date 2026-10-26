import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIError } from "../ai/errors";
import type { RunControl } from "../ai/gateway";
import type { AIRequest, AIResponse, ProviderId, StreamHandlers } from "../ai/types";
import { startSpan } from "../debug/trace";
import { buildPaperDocument } from "../latex/parser/documentModel";
import { samplePaper } from "../test/samplePaper";
import { runChatTurn, type Paper } from "./orchestrator";
import { FRONT, paperUnits } from "./paper/sections";

// Exercise the real Gateway and Orchestrator, replacing only the external model service.
const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../ai/service", () => ({ aiService: { generate, isAuthenticated: async () => true } }));

const files = samplePaper();
const units = paperUnits(buildPaperDocument({ files }), files);
const paper: Paper = {
  files: [...files].map(([path, text]) => ({ path, text })),
  omitted: [],
  budget: 150_000,
  ...units,
  summaries: new Map(units.units.filter((u) => u.key !== FRONT).map((u) => [u.key, `Summary of ${u.title}`])),
};
const reply = (provider: ProviderId, request: AIRequest, text: string): AIResponse => ({
  id: request.id, provider, model: request.model, text, finishReason: "stop",
});
const judge = (provider: ProviderId, request: AIRequest): AIResponse => ({
  ...reply(provider, request, ""),
  toolCalls: [{ id: "tool", name: "route_chat", arguments: { reason: "Discuss the method" } }],
});
function preparation(provider: ProviderId, request: AIRequest): AIResponse | undefined {
  if (request.task === "refine") return reply(provider, request, request.instruction);
  if (request.task === "judge") return judge(provider, request);
  if (request.task === "select") return { ...reply(provider, request, ""), toolCalls: [{ id: "select", name: "select_chat_sections", arguments: { reason: "Read method", sections: ["3.2"] } }] };
  return undefined;
}
const fail = () => new AIError("stream_interrupted", "stream cut off", { provider: "openai" });

function run(control: RunControl = { stopped: false, activeRequest: null }) {
  const displayed: string[] = [];
  const result = runChatTurn({ id: "stream", instruction: "Explain section 3.2", turns: [] }, {
    root: startSpan("stream", null, "pipeline", "test"),
    control,
    paper: () => paper,
    hooks: { onText: (text) => displayed.push(text) },
  });
  return { displayed, result };
}

beforeEach(() => { generate.mockReset(); });

describe("fallback before visible output", () => {
  it.each(["[[need", "[[need_sections: 4.3]]"])("retries a failed Answer while %s is hidden", async (buffered) => {
    generate.mockImplementation(async (provider: ProviderId, request: AIRequest, handlers?: StreamHandlers) => {
      const prepared = preparation(provider, request);
      if (prepared) return prepared;
      expect(request.mayAskForSections).toBe(true);
      if (provider === "openai") {
        handlers?.onDelta?.(buffered, buffered);
        throw fail();
      }
      handlers?.onDelta?.("Recovered answer.", "Recovered answer.");
      return reply(provider, request, "Recovered answer.");
    });
    const r = run();
    expect(await r.result).toMatchObject({ content: "Recovered answer.", fallbackFrom: { provider: "openai" } });
    expect(r.displayed).toEqual(["Recovered answer."]);
    expect(generate.mock.calls.map(([provider]) => provider)).toEqual(["openai", "anthropic", "openai", "openai", "anthropic"]);
  });

  it("clears the failed attempt's buffer when fallback completes without streamed text", async () => {
    generate.mockImplementation(async (provider: ProviderId, request: AIRequest, handlers?: StreamHandlers) => {
      const prepared = preparation(provider, request);
      if (prepared) return prepared;
      if (provider === "openai") {
        handlers?.onDelta?.("[[need", "[[need");
        throw fail();
      }
      return reply(provider, request, "Recovered without streaming.");
    });
    const r = run();
    expect((await r.result).content).toBe("Recovered without streaming.");
    // chatStore displays the final result; release() must not leak the old buffer first.
    expect(r.displayed).toEqual([]);
  });

  it("still hides a fallback's section request and reads those sections before answering", async () => {
    generate.mockImplementation(async (provider: ProviderId, request: AIRequest, handlers?: StreamHandlers) => {
      const prepared = preparation(provider, request);
      if (prepared) return prepared;
      if (request.mayAskForSections) {
        if (provider === "openai") {
          handlers?.onDelta?.("[[need", "[[need");
          throw fail();
        }
        const text = "[[need_sections: 4.3]]";
        handlers?.onDelta?.(text, text);
        return reply(provider, request, text);
      }
      expect(request.paperView?.sections.find((s) => s.key === "4.3")?.content).toBe("full");
      handlers?.onDelta?.("Answer with section 4.3.", "Answer with section 4.3.");
      return reply(provider, request, "Answer with section 4.3.");
    });
    const r = run();
    expect((await r.result).content).toBe("Answer with section 4.3.");
    expect(r.displayed).toEqual(["Answer with section 4.3."]);
    expect(generate.mock.calls.map(([provider]) => provider)).toEqual(["openai", "anthropic", "openai", "openai", "anthropic", "openai"]);
  });

  it("does not retry once Answer text has reached the screen", async () => {
    generate.mockImplementation(async (provider: ProviderId, request: AIRequest, handlers?: StreamHandlers) => {
      const prepared = preparation(provider, request);
      if (prepared) return prepared;
      handlers?.onDelta?.("Visible answer.", "Visible answer.");
      throw fail();
    });
    const r = run();
    await expect(r.result).rejects.toMatchObject({ kind: "stream_interrupted" });
    expect(r.displayed).toEqual(["Visible answer."]);
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it("does not retry when the user cancels while output is buffered", async () => {
    const control: RunControl = { stopped: false, activeRequest: null };
    generate.mockImplementation(async (provider: ProviderId, request: AIRequest, handlers?: StreamHandlers) => {
      const prepared = preparation(provider, request);
      if (prepared) return prepared;
      handlers?.onDelta?.("[[need", "[[need");
      control.stopped = true;
      throw fail();
    });
    const r = run(control);
    await expect(r.result).rejects.toMatchObject({ kind: "cancelled" });
    expect(r.displayed).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(4);
  });
});
