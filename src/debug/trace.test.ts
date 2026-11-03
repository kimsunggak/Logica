import { describe, expect, it } from "vitest";
import { redact } from "./trace";

describe("trace redaction", () => {
  it("masks secret fields and secret-looking text, and keeps token counts", () => {
    const out = redact({
      input: { access_token: "abc", refreshToken: "def", api_key: "k", Authorization: "x", inputTokens: 12 },
      text: "key sk-ant-api03-ABCDEFGHIJ, Bearer abcdefghij12, jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigvalue",
      prose: "a risk-assessment of task-management",
    }) as Record<string, any>;
    expect(out.input).toEqual({ access_token: "***", refreshToken: "***", api_key: "***", Authorization: "***", inputTokens: 12 });
    expect(out.text).toBe("key sk-***, Bearer ***, jwt ***");
    expect(out.prose).toBe("a risk-assessment of task-management");
  });
});
