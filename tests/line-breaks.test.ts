import { describe, expect, it } from "vitest";
import {
  ChatInputSchema,
  literalLineBreaks,
  QuestionInputSchema,
} from "../src/shared/schema.js";

describe("line breaks an agent typed as \\n", () => {
  it("become line breaks", () => {
    expect(
      literalLineBreaks("Yes.\\n\\nThere are two parts:\\n1. One\\r\\n2. Two"),
    ).toBe("Yes.\n\nThere are two parts:\n1. One\n2. Two");
  });

  it("stay as written in code, after a backslash, or beside real line breaks", () => {
    expect(literalLineBreaks('Split on `"\\n"`.\\nDone')).toBe(
      'Split on `"\\n"`.\nDone',
    );
    expect(literalLineBreaks("A path C:\\\\new")).toBe("A path C:\\\\new");
    expect(literalLineBreaks("Line one\nwrites \\n")).toBe(
      "Line one\nwrites \\n",
    );
  });

  it("apply to prompts and recommendations, not to what the user types", () => {
    const question = QuestionInputSchema.parse({
      type: "text",
      prompt: "First\\nSecond",
      recommendation: "Do **A**.\\n\\nThen B.",
    });
    expect(question.prompt).toBe("First\nSecond");
    expect(question.recommendation).toBe("Do **A**.\n\nThen B.");
    expect(ChatInputSchema.parse({ text: "a\\nb" }).text).toBe("a\\nb");
  });
});
