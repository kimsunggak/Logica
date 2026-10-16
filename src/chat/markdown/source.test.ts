import { describe, expect, it } from "vitest";
import { resolveLanguage } from "./codeHighlighter";
import { fencedCode, normalizeMath } from "./source";

describe("normalizeMath", () => {
  it("turns \\( \\) into inline and \\[ \\] into display math", () => {
    expect(normalizeMath("where \\( \\alpha \\) is small")).toBe("where $\\alpha$ is small");
    expect(normalizeMath("so \\[ x^2 \\] holds")).toBe("so \n\n$$\nx^2\n$$\n\n holds");
  });

  it("leaves inline code and plain text alone", () => {
    expect(normalizeMath("use `\\(x\\)` here")).toBe("use `\\(x\\)` here");
    expect(normalizeMath("``a ` \\[b\\]`` and \\(c\\)")).toBe("``a ` \\[b\\]`` and $c$");
    const plain = "no math (just brackets) [here]";
    expect(normalizeMath(plain)).toBe(plain);
  });
});

describe("fencedCode", () => {
  it("fences longer than any backtick run in the code", () => {
    expect(fencedCode("x = 1", "python")).toBe("```python\nx = 1\n```");
    expect(fencedCode("a ``` b")).toBe("````\na ``` b\n````");
  });
});

describe("resolveLanguage", () => {
  it("knows the languages of a LaTeX writer, by name or alias", () => {
    expect(resolveLanguage("latex")).toBe("latex");
    expect(resolveLanguage("TeX")).toBe("latex");
    expect(resolveLanguage("bib")).toBe("bibtex");
    expect(resolveLanguage("py")).toBe("python");
    expect(resolveLanguage("bash")).toBe("shellscript");
    expect(resolveLanguage("cobol")).toBeNull();
    expect(resolveLanguage("edit")).toBeNull();
  });
});
