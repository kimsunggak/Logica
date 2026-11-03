import { describe, expect, it } from "vitest";
import { formatAuthors, parseBibtex } from "./bibParser";

const bib = String.raw`
@string{nips = "NeurIPS"}
@inproceedings{vaswani2017attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},
  booktitle = nips,
  year = 2017
}
@article{broken2020,
  title = {Missing brace,
  year = {2020}

@article{he2016deep,
  title="Deep Residual Learning for {Image} Recognition",
  author="Kaiming He and Xiangyu Zhang",
  year={2016},
}
@comment{ignored}
@misc{who2020, author = {{World Health Organization}}, title = {Report}, year = {2020}}
`;

describe("parseBibtex", () => {
  const result = parseBibtex(bib, "references.bib");
  it("parses entries and skips malformed ones", () => {
    const keys = result.entries.map((e) => e.key);
    expect(keys).toContain("vaswani2017attention");
    expect(keys).toContain("he2016deep");
    expect(keys).toContain("who2020");
    expect(result.errors.length).toBeGreaterThan(0);
  });
  it("extracts fields", () => {
    const v = result.entries.find((e) => e.key === "vaswani2017attention")!;
    expect(v.title).toBe("Attention Is All You Need");
    expect(v.year).toBe("2017");
    expect(formatAuthors(v.author)).toBe("Vaswani et al.");
    const he = result.entries.find((e) => e.key === "he2016deep")!;
    expect(he.title).toBe("Deep Residual Learning for Image Recognition");
    expect(formatAuthors(he.author)).toBe("He and Zhang");
    const who = result.entries.find((e) => e.key === "who2020")!;
    expect(formatAuthors(who.author)).toBe("World Health Organization");
  });
});
