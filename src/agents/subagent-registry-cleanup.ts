import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type DeferredCleanupDecision =
  | {
      kind: "defer-descendants";
      delayMs: number;
    }
  | {
      kind: "give-up";
      reason: "retry-limit" | "expiry";
      retryCount?: number;
    }
  | {
      kind: "retry";
      retryCount: number;
      resumeDelayMs?: number;
    };

export function resolveCleanupCompletionReason(
  entry: SubagentRunRecord,
): SubagentLifecycleEndedReason {
  return entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
}

function resolveEndedAgoMs(entry: SubagentRunRecord, now: number): number {
  return typeof entry.endedAt === "number" ? now - entry.endedAt : 0;
}

export function resolveDeferredCleanupDecision(params: {
  entry: SubagentRunRecord;
  now: number;
  activeDescendantRuns: number;
  announceExpiryMs: number;
  announceCompletionHardExpiryMs: number;
  maxAnnounceRetryCount: number;
  deferDescendantDelayMs: number;
  resolveAnnounceRetryDelayMs: (retryCount: number) => number;
}): DeferredCleanupDecision {
  const endedAgo = resolveEndedAgoMs(params.entry, params.now);
  const isCompletionMessageFlow = params.entry.expectsCompletionMessage === true;
  const completionHardExpiryExceeded =
    isCompletionMessageFlow && endedAgo > params.announceCompletionHardExpiryMs;
  if (isCompletionMessageFlow && params.activeDescendantRuns > 0) {
    if (completionHardExpiryExceeded) {
      return { kind: "give-up", reason: "expiry" };
    }
    return { kind: "defer-descendants", delayMs: params.deferDescendantDelayMs };
  }

  // A retry hint set on the entry (typically by a "provider in cooldown"
  // delivery failure) means we know the failure won't clear within the
  // exponential-backoff budget. Skip the retry-count increment so the loop
  // doesn't give up after 3 fast attempts during a multi-minute cooldown,
  // and use the hint as a floor for the resume delay (capped at the hard
  // expiry budget remaining so we don't schedule beyond give-up time).
  const retryHintMs = params.entry.lastAnnounceRetryHintMs;
  const hasValidRetryHint =
    typeof retryHintMs === "number" && Number.isFinite(retryHintMs) && retryHintMs > 0;
  const hardBudgetRemainingMs = params.announceCompletionHardExpiryMs - endedAgo;
  if (hasValidRetryHint && isCompletionMessageFlow && hardBudgetRemainingMs > 0) {
    const cappedHintMs = Math.min(retryHintMs as number, hardBudgetRemainingMs);
    const baseDelayMs = params.resolveAnnounceRetryDelayMs(
      (params.entry.announceRetryCount ?? 0) + 1,
    );
    return {
      kind: "retry",
      // Do not increment the counter for hint-driven retries. The hard
      // expiry above is the upper bound that keeps the loop terminating.
      retryCount: params.entry.announceRetryCount ?? 0,
      resumeDelayMs: Math.max(baseDelayMs, cappedHintMs),
    };
  }

  const retryCount = (params.entry.announceRetryCount ?? 0) + 1;
  const expiryExceeded = isCompletionMessageFlow
    ? completionHardExpiryExceeded
    : endedAgo > params.announceExpiryMs;
  if (retryCount >= params.maxAnnounceRetryCount || expiryExceeded) {
    return {
      kind: "give-up",
      reason: retryCount >= params.maxAnnounceRetryCount ? "retry-limit" : "expiry",
      retryCount,
    };
  }

  return {
    kind: "retry",
    retryCount,
    resumeDelayMs: params.resolveAnnounceRetryDelayMs(retryCount),
  };
}
