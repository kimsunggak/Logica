import { describe, expect, it } from "vitest";
import { normalizeRewrite, validateRewrite } from "./validation";

const errors = (o: string, r: string, bib?: string[]) =>
  validateRewrite(o, r, { bibKeys: bib ? new Set(bib) : undefined }).filter((i) => i.severity === "error");

describe("validateRewrite", () => {
  it("accepts a faithful rewrite", () => {
    const o = "Prior methods \\cite{a} ignore uncertainty (see Sec.~\\ref{sec:m}) where $x_t$ matters.";
    const r = "Previous methods \\cite{a} do not model uncertainty (Sec.~\\ref{sec:m}), where $x_t$ matters.";
    expect(validateRewrite(o, r)).toEqual([]);
  });
  it("flags unbalanced braces and environments", () => {
    expect(errors("\\textbf{a} b", "\\textbf{a b")).toHaveLength(1);
    expect(errors("\\begin{itemize}\\item a\\end{itemize}", "\\begin{itemize}\\item a")).toHaveLength(1);
    expect(errors("$a$ b", "$a b")).toHaveLength(1);
  });
  it("flags removed labels and unknown citations", () => {
    expect(errors("x \\label{eq:1}", "x \\label{eq:2}")[0].message).toContain("eq:1");
    expect(errors("x", "x \\cite{made_up}", ["real"])[0].message).toContain("made_up");
  });
  it("does not flag a selection that was already unbalanced", () => {
    expect(errors("\\textbf{partial", "\\textbf{shorter")).toEqual([]);
  });
  it("warns about changed math and removed comments", () => {
    const issues = validateRewrite("a $x+y$ % note\nb", "a $x-y$\nb");
    expect(issues.map((i) => i.message).join(" ")).toMatch(/Math/);
    expect(issues.map((i) => i.message).join(" ")).toMatch(/comments/);
  });
  it("rejects empty output", () => {
    expect(errors("a", "  ")).toHaveLength(1);
  });
});

describe("normalizeRewrite", () => {
  it("strips code fences and keeps surrounding whitespace", () => {
    expect(normalizeRewrite("  old text\n", "```latex\nnew text\n```")).toBe("  new text\n");
    expect(normalizeRewrite("old", "new")).toBe("new");
  });
});
