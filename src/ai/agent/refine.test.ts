import { describe, expect, it } from "vitest";
import { parseRefine } from "./refine";

describe("plain-text request refinement", () => {
  it("returns a request string without introducing metadata", () => {
    expect(parseRefine("  Shorten section 3.2 only.\n", "q")).toBe("Shorten section 3.2 only.");
  });
  it("uses the original request for an empty refinement", () => {
    expect(parseRefine(" \n", "Do not change the introduction.")).toBe("Do not change the introduction.");
  });
});
