import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveMaxRateLimitSameModelRetries,
  resolveRateLimitRetryBackoffMs,
} from "./helpers.js";

function makeAssistantMessage(
  content: AssistantMessage["content"],
  phase?: string,
): AssistantMessage {
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    role: "assistant",
    content,
    timestamp: Date.now(),
    stopReason: "stop",
    ...(phase ? { phase } : {}),
  };
}

describe("resolveFinalAssistantVisibleText", () => {
  it("prefers final_answer text over commentary blocks", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "Section 1\nSection 2",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBe("Section 1\nSection 2");
  });

  it("returns undefined when the final visible text is empty", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "Working...",
        textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
      },
      {
        type: "text",
        text: "   ",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantVisibleText(lastAssistant)).toBeUndefined();
  });

  it("preserves raw final answer text without visible-text sanitization", () => {
    const lastAssistant = makeAssistantMessage([
      {
        type: "text",
        text: "<final>keep this</final>",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ]);

    expect(resolveFinalAssistantRawText(lastAssistant)).toBe("<final>keep this</final>");
  });
});

describe("resolveRateLimitRetryBackoffMs", () => {
  it("returns 5s for the first attempt", () => {
    expect(resolveRateLimitRetryBackoffMs(1)).toBe(5_000);
  });

  it("doubles each attempt until the cap", () => {
    expect(resolveRateLimitRetryBackoffMs(2)).toBe(10_000);
    expect(resolveRateLimitRetryBackoffMs(3)).toBe(20_000);
    expect(resolveRateLimitRetryBackoffMs(4)).toBe(40_000);
    expect(resolveRateLimitRetryBackoffMs(5)).toBe(80_000);
    expect(resolveRateLimitRetryBackoffMs(6)).toBe(160_000);
  });

  it("caps at 5 minutes (300_000 ms) on the 7th attempt", () => {
    expect(resolveRateLimitRetryBackoffMs(7)).toBe(300_000);
  });

  it("stays at the cap for attempts beyond the budget", () => {
    expect(resolveRateLimitRetryBackoffMs(8)).toBe(300_000);
    expect(resolveRateLimitRetryBackoffMs(20)).toBe(300_000);
  });

  it("clamps non-positive or fractional attempts to the first-attempt delay", () => {
    expect(resolveRateLimitRetryBackoffMs(0)).toBe(5_000);
    expect(resolveRateLimitRetryBackoffMs(-1)).toBe(5_000);
    expect(resolveRateLimitRetryBackoffMs(1.6)).toBe(5_000);
  });
});

describe("resolveMaxRateLimitSameModelRetries", () => {
  it("is 7 (matches the cap-bound 7th retry sequence)", () => {
    expect(resolveMaxRateLimitSameModelRetries()).toBe(7);
  });
});
