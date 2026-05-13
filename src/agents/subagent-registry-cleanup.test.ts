import { describe, expect, it } from "vitest";
import { resolveDeferredCleanupDecision } from "./subagent-registry-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function makeEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "test",
    cleanup: "keep",
    createdAt: 0,
    endedAt: 1_000,
    ...overrides,
  };
}

describe("resolveDeferredCleanupDecision", () => {
  const now = 2_000;

  function resolveDecision(
    overrides: Pick<
      Parameters<typeof resolveDeferredCleanupDecision>[0],
      "activeDescendantRuns" | "entry"
    > &
      Partial<
        Pick<Parameters<typeof resolveDeferredCleanupDecision>[0], "resolveAnnounceRetryDelayMs">
      >,
  ) {
    return resolveDeferredCleanupDecision({
      now,
      announceExpiryMs: 5 * 60_000,
      announceCompletionHardExpiryMs: 30 * 60_000,
      maxAnnounceRetryCount: 3,
      deferDescendantDelayMs: 1_000,
      resolveAnnounceRetryDelayMs: () => 2_000,
      ...overrides,
    });
  }

  it("defers completion-message cleanup while descendants are still pending", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: true }),
      activeDescendantRuns: 2,
    });

    expect(decision).toEqual({ kind: "defer-descendants", delayMs: 1_000 });
  });

  it("hard-expires completion-message cleanup when descendants never settle", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: true, endedAt: now - (30 * 60_000 + 1) }),
      activeDescendantRuns: 1,
    });

    expect(decision).toEqual({ kind: "give-up", reason: "expiry" });
  });

  it("keeps regular expiry behavior for non-completion flows", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: false, endedAt: now - (5 * 60_000 + 1) }),
      activeDescendantRuns: 0,
    });

    expect(decision).toEqual({ kind: "give-up", reason: "expiry", retryCount: 1 });
  });

  it("uses retry backoff for completion-message flows once descendants are settled", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: true, announceRetryCount: 1 }),
      activeDescendantRuns: 0,
      resolveAnnounceRetryDelayMs: (retryCount) => retryCount * 1_000,
    });

    expect(decision).toEqual({ kind: "retry", retryCount: 2, resumeDelayMs: 2_000 });
  });

  it("uses retry backoff for non-completion flows so cleanup can settle after announce failures", () => {
    const decision = resolveDecision({
      entry: makeEntry({ expectsCompletionMessage: false, announceRetryCount: 1 }),
      activeDescendantRuns: 0,
      resolveAnnounceRetryDelayMs: (retryCount) => retryCount * 1_000,
    });

    expect(decision).toEqual({ kind: "retry", retryCount: 2, resumeDelayMs: 2_000 });
  });

  it("honors a cooldown retry hint and does not advance the retry counter", () => {
    // Completion-message flow, hint says wait 120s for provider cooldown.
    const decision = resolveDecision({
      entry: makeEntry({
        expectsCompletionMessage: true,
        announceRetryCount: 2,
        lastAnnounceRetryHintMs: 120_000,
      }),
      activeDescendantRuns: 0,
      resolveAnnounceRetryDelayMs: (retryCount) => retryCount * 1_000,
    });

    // retryCount must stay at 2 (no increment) so the loop doesn't give up
    // after 3 fast 1/2/4s attempts during a multi-minute cooldown.
    expect(decision).toEqual({
      kind: "retry",
      retryCount: 2,
      resumeDelayMs: 120_000,
    });
  });

  it("caps the cooldown hint at the hard-expiry budget remaining", () => {
    // Hard expiry is 30 * 60_000 = 1_800_000 ms. endedAt set so that only
    // 60_000 ms remain in the budget. A 120_000 ms hint must be capped.
    const decision = resolveDecision({
      entry: makeEntry({
        expectsCompletionMessage: true,
        announceRetryCount: 1,
        lastAnnounceRetryHintMs: 120_000,
        endedAt: now - (30 * 60_000 - 60_000),
      }),
      activeDescendantRuns: 0,
      resolveAnnounceRetryDelayMs: () => 1_000,
    });

    expect(decision.kind).toBe("retry");
    if (decision.kind === "retry") {
      expect(decision.retryCount).toBe(1);
      expect(decision.resumeDelayMs).toBe(60_000);
    }
  });

  it("ignores the cooldown hint once the hard expiry budget is exhausted", () => {
    // Past hard expiry: the hint branch must yield to the standard
    // give-up/expiry path so the loop terminates.
    const decision = resolveDecision({
      entry: makeEntry({
        expectsCompletionMessage: true,
        announceRetryCount: 1,
        lastAnnounceRetryHintMs: 120_000,
        endedAt: now - (30 * 60_000 + 1),
      }),
      activeDescendantRuns: 0,
    });

    expect(decision.kind).toBe("give-up");
  });

  it("uses the normal backoff if the cooldown hint is shorter than the backoff floor", () => {
    // Hint of 500ms must not under-cut the exponential backoff: the resume
    // delay should be max(backoff, hint), not min.
    const decision = resolveDecision({
      entry: makeEntry({
        expectsCompletionMessage: true,
        announceRetryCount: 1,
        lastAnnounceRetryHintMs: 500,
      }),
      activeDescendantRuns: 0,
      resolveAnnounceRetryDelayMs: () => 2_000,
    });

    expect(decision).toEqual({
      kind: "retry",
      retryCount: 1,
      resumeDelayMs: 2_000,
    });
  });
});
