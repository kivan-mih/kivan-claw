import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentSessionStartedAt } from "./subagent-session-metrics.js";

export type SubagentWorkflowState =
  | "running"
  | "recovering"
  | "reconciling"
  | "waiting_children"
  | "done"
  | "failed"
  | "killed"
  | "timeout"
  | "interrupted";

export type SubagentWorkflowProjection = {
  state: SubagentWorkflowState;
  terminal: boolean;
  active: boolean;
  pendingDescendants: number;
};

export const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;
export const RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS = 30 * 60 * 1_000;
const EXPLICIT_TIMEOUT_STALE_GRACE_MS = 60_000;
const MIN_REALISTIC_RUN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

export function collectUnresolvedRecoveryRemapRunIds(
  entries: Iterable<SubagentRunRecord>,
): Set<string> {
  const runIds = new Set<string>();
  for (const entry of entries) {
    const remap = entry.recoveryRemap;
    if (!remap) {
      continue;
    }
    runIds.add(remap.previousRunId);
    runIds.add(remap.nextRunId);
  }
  return runIds;
}

export function hasSubagentRunEnded<T extends Pick<SubagentRunRecord, "endedAt">>(
  entry: T,
): entry is T & { endedAt: number } {
  return typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt);
}

function resolveStaleCutoffMs(entry: Pick<SubagentRunRecord, "runTimeoutSeconds">): number {
  const timeoutSeconds = entry.runTimeoutSeconds;
  if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return Math.max(
      STALE_UNENDED_SUBAGENT_RUN_MS,
      Math.floor(timeoutSeconds) * 1_000 + EXPLICIT_TIMEOUT_STALE_GRACE_MS,
    );
  }
  return STALE_UNENDED_SUBAGENT_RUN_MS;
}

export function isStaleUnendedSubagentRun(
  entry: Pick<
    SubagentRunRecord,
    "createdAt" | "startedAt" | "sessionStartedAt" | "endedAt" | "runTimeoutSeconds"
  >,
  now = Date.now(),
): boolean {
  if (hasSubagentRunEnded(entry)) {
    return false;
  }
  const startedAt = getSubagentSessionStartedAt(entry);
  if (
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    startedAt < MIN_REALISTIC_RUN_TIMESTAMP_MS
  ) {
    return false;
  }
  return now - startedAt > resolveStaleCutoffMs(entry);
}

export function isLiveUnendedSubagentRun(
  entry: Pick<
    SubagentRunRecord,
    "createdAt" | "startedAt" | "sessionStartedAt" | "endedAt" | "runTimeoutSeconds"
  >,
  now = Date.now(),
): boolean {
  return !hasSubagentRunEnded(entry) && !isStaleUnendedSubagentRun(entry, now);
}

export function resolveSubagentWorkflowProjection(
  entry: SubagentRunRecord,
  pendingDescendants: number,
  now = Date.now(),
): SubagentWorkflowProjection {
  const pending = Math.max(0, Math.floor(pendingDescendants));
  if (pending > 0) {
    return {
      state: "waiting_children",
      terminal: false,
      active: true,
      pendingDescendants: pending,
    };
  }
  if (entry.recoveryState === "recovering") {
    return { state: "recovering", terminal: false, active: true, pendingDescendants: 0 };
  }
  if (isLiveUnendedSubagentRun(entry, now)) {
    return { state: "running", terminal: false, active: true, pendingDescendants: 0 };
  }
  if (!hasSubagentRunEnded(entry)) {
    return { state: "interrupted", terminal: false, active: false, pendingDescendants: 0 };
  }
  if (
    entry.pauseReason === "sessions_yield" &&
    entry.outcome === undefined &&
    entry.endedReason === undefined
  ) {
    return { state: "reconciling", terminal: false, active: true, pendingDescendants: 0 };
  }
  if (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    return { state: "killed", terminal: true, active: false, pendingDescendants: 0 };
  }
  if (entry.outcome?.status === "error") {
    return { state: "failed", terminal: true, active: false, pendingDescendants: 0 };
  }
  if (entry.outcome?.status === "timeout") {
    return { state: "timeout", terminal: true, active: false, pendingDescendants: 0 };
  }
  return { state: "done", terminal: true, active: false, pendingDescendants: 0 };
}

function isRecentlyEndedSubagentRun(
  entry: Pick<SubagentRunRecord, "endedAt">,
  now = Date.now(),
  recentMs = RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
): boolean {
  if (!hasSubagentRunEnded(entry)) {
    return false;
  }
  return now - entry.endedAt <= recentMs;
}

export function shouldKeepSubagentRunChildLink(
  entry: Pick<
    SubagentRunRecord,
    | "createdAt"
    | "startedAt"
    | "sessionStartedAt"
    | "endedAt"
    | "runTimeoutSeconds"
    | "pauseReason"
    | "outcome"
    | "endedReason"
  >,
  options?: {
    activeDescendants?: number;
    now?: number;
  },
): boolean {
  const now = options?.now ?? Date.now();
  return (
    isLiveUnendedSubagentRun(entry, now) ||
    (entry.pauseReason === "sessions_yield" &&
      entry.outcome === undefined &&
      entry.endedReason === undefined) ||
    (options?.activeDescendants ?? 0) > 0 ||
    isRecentlyEndedSubagentRun(entry, now)
  );
}
