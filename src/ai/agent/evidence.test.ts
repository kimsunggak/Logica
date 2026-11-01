import { describe, expect, it } from "vitest";
import type { TextCitation } from "../types";
import { buildEvidence, MAX_EVIDENCE } from "./evidence";

/** A citation of `part`, wherever it is in `text`. */
const cite = (text: string, part: string, url: string, extra: Partial<TextCitation> = {}): TextCitation => {
  const start = text.indexOf(part);
  if (start < 0) throw new Error(`"${part}" is not in the text`);
  return { start, end: start + part.length, url, ...extra };
};

describe("buildEvidence", () => {
  it("keeps cited lines as numbered findings and drops lines without a citation", () => {
    const text = [
      "Here is what I found:",
      "- Paper A (Kim et al., CVPR 2026) reaches 81.2 AP on OCHuman.",
      "- I believe Paper C is also relevant.",
      "- The OCHuman benchmark has 5,081 images.",
    ].join("\n");
    const found = buildEvidence(text, [
      cite(text, "81.2 AP on OCHuman", "https://example.org/a", { title: "Paper A", quote: "achieves 81.2 AP" }),
      cite(text, "5,081 images", "https://example.org/ochuman", { title: "OCHuman" }),
    ], ["q"]);
    expect(found).toEqual({
      evidence: [
        { id: "W1", finding: "Paper A (Kim et al., CVPR 2026) reaches 81.2 AP on OCHuman.", sources: [{ url: "https://example.org/a", title: "Paper A", quote: "achieves 81.2 AP" }] },
        { id: "W2", finding: "The OCHuman benchmark has 5,081 images.", sources: [{ url: "https://example.org/ochuman", title: "OCHuman" }] },
      ],
      gaps: [],
    });
  });

  it("reads NOT FOUND lines as gaps, and every question as a gap when nothing was found", () => {
    expect(buildEvidence("- NOT FOUND: the 2026 leaderboard\nNOT FOUND: Paper B's venue", [], ["a", "b"]).gaps).toEqual(["the 2026 leaderboard", "Paper B's venue"]);
    expect(buildEvidence("Nothing useful came up.", [], ["the 2026 leaderboard"])).toEqual({ evidence: [], gaps: ["the 2026 leaderboard"] });
  });

  it("strips inline markdown citations and merges the sources of a finding", () => {
    const text = "1. Paper A reaches 81.2 AP ([example.org](https://example.org/a)) ([mirror.org](https://mirror.org/a))";
    const found = buildEvidence(text, [
      cite(text, "([example.org](https://example.org/a))", "https://example.org/a", { title: "Paper A" }),
      cite(text, "([mirror.org](https://mirror.org/a))", "https://mirror.org/a"),
      cite(text, "Paper A", "https://example.org/a", { quote: "81.2 AP" }),
    ], []);
    expect(found.evidence).toEqual([{
      id: "W1",
      finding: "Paper A reaches 81.2 AP",
      sources: [{ url: "https://example.org/a", title: "Paper A", quote: "81.2 AP" }, { url: "https://mirror.org/a" }],
    }]);
  });

  it("does not let a citation of one line reach the next", () => {
    const text = "- First finding.\n- Second, uncited.";
    const first = "- First finding.\n";
    expect(buildEvidence(text, [{ start: 0, end: first.length, url: "https://example.org/1" }], []).evidence.map((e) => e.finding)).toEqual(["First finding."]);
  });

  it(`keeps at most ${MAX_EVIDENCE} findings`, () => {
    const lines = Array.from({ length: MAX_EVIDENCE + 3 }, (_, i) => `- Finding ${i + 1}.`);
    const text = lines.join("\n");
    const found = buildEvidence(text, lines.map((line, i) => cite(text, line, `https://example.org/${i}`)), []);
    expect(found.evidence).toHaveLength(MAX_EVIDENCE);
    expect(found.evidence.at(-1)!.id).toBe(`W${MAX_EVIDENCE}`);
  });
});
