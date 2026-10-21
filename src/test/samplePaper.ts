/** The example paper's files, as the project would load them (for tests). */
import mainTex from "../../examples/sample-paper/main.tex?raw";
import introTex from "../../examples/sample-paper/sections/introduction.tex?raw";
import relatedTex from "../../examples/sample-paper/sections/related_work.tex?raw";
import methodTex from "../../examples/sample-paper/sections/method.tex?raw";
import experimentsTex from "../../examples/sample-paper/sections/experiments.tex?raw";

export const sampleSources = { mainTex, introTex, relatedTex, methodTex, experimentsTex };

export function samplePaper(): Map<string, string> {
  return new Map([
    ["main.tex", mainTex],
    ["sections/introduction.tex", introTex],
    ["sections/related_work.tex", relatedTex],
    ["sections/method.tex", methodTex],
    ["sections/experiments.tex", experimentsTex],
  ]);
}
