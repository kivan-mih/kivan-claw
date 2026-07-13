import crypto from "node:crypto";
import type { ClearSessionQueueResult } from "../auto-reply/reply/queue.js";
import {
  resolveSubagentLabel,
  resolveSubagentTargetFromRuns,
  sortSubagentRuns,
  type SubagentTargetResolution,
} from "../auto-reply/reply/subagents-utils.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import {
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "./run-wait.js";
import { resolveStoredSubagentCapabilities } from "./subagent-capabilities.js";
import { buildLatestSubagentRunIndex, resolveSessionEntryForKey } from "./subagent-list.js";
import {
  movePreparedSubagentRecoveryAdmission,
  prepareSubagentRecoveryAdmission,
  isSubagentRecoveryStageDurablyBlocked,
  quarantineUncertainSubagentRecovery,
  rollbackSubagentRecoveryAdmission,
} from "./subagent-recovery-admission.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { countPendingDescendantRunsFromRuns } from "./subagent-registry-queries.js";
import {
  getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController,
} from "./subagent-registry-read.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import {
  clearSubagentRunSteerRestart,
  countPendingDescendantRuns,
  markSubagentRunTerminated,
  markSubagentRunForSteerRestart,
  replaceSubagentRunAfterSteer,
} from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentWorkflowProjection } from "./subagent-run-liveness.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";

export const DEFAULT_RECENT_MINUTES = 30;
export const MAX_RECENT_MINUTES = 24 * 60;
export const MAX_STEER_MESSAGE_CHARS = 4_000;
const STEER_RATE_LIMIT_MS = 2_000;
const STEER_ABORT_SETTLE_TIMEOUT_MS = 5_000;
const SUBAGENT_REPLY_HISTORY_LIMIT = 50;

const steerRateLimit = new Map<string, number>();

type GatewayCaller = typeof callGateway;
type UpdateSessionStore = typeof updateSessionStore;
type AbortEmbeddedPiRun = (sessionId: string) => boolean;
type ClearSessionQueues = (keys: Array<string | undefined>) => ClearSessionQueueResult;

const defaultSubagentControlDeps = {
  callGateway,
  updateSessionStore,
};

let subagentControlDeps: {
  callGateway: GatewayCaller;
  updateSessionStore: UpdateSessionStore;
  abortEmbeddedPiRun?: AbortEmbeddedPiRun;
  clearSessionQueues?: ClearSessionQueues;
} = defaultSubagentControlDeps;

const subagentControlRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-control.runtime.js"),
);

function loadSubagentControlRuntime() {
  return subagentControlRuntimeLoader.load();
}

async function resolveSubagentControlRuntime(): Promise<{
  abortEmbeddedPiRun: AbortEmbeddedPiRun;
  clearSessionQueues: ClearSessionQueues;
}> {
  if (subagentControlDeps.abortEmbeddedPiRun && subagentControlDeps.clearSessionQueues) {
    return {
      abortEmbeddedPiRun: subagentControlDeps.abortEmbeddedPiRun,
      clearSessionQueues: subagentControlDeps.clearSessionQueues,
    };
  }
  const runtime = await loadSubagentControlRuntime();
  return {
    abortEmbeddedPiRun: subagentControlDeps.abortEmbeddedPiRun ?? runtime.abortEmbeddedPiRun,
    clearSessionQueues: subagentControlDeps.clearSessionQueues ?? runtime.clearSessionQueues,
  };
}

export type ResolvedSubagentController = {
  controllerSessionKey: string;
  callerSessionKey: string;
  callerIsSubagent: boolean;
  controlScope: "children" | "none";
};
export function resolveSubagentController(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
}): ResolvedSubagentController {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const callerRaw = params.agentSessionKey?.trim() || alias;
  const callerSessionKey = resolveInternalSessionKey({
    key: callerRaw,
    alias,
    mainKey,
  });
  if (!isSubagentSessionKey(callerSessionKey)) {
    return {
      controllerSessionKey: callerSessionKey,
      callerSessionKey,
      callerIsSubagent: false,
      controlScope: "children",
    };
  }
  const capabilities = resolveStoredSubagentCapabilities(callerSessionKey, {
    cfg: params.cfg,
  });
  return {
    controllerSessionKey: callerSessionKey,
    callerSessionKey,
    callerIsSubagent: true,
    controlScope: capabilities.controlScope,
  };
}

export function listControlledSubagentRuns(controllerSessionKey: string): SubagentRunRecord[] {
  const key = controllerSessionKey.trim();
  if (!key) {
    return [];
  }

  const snapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const latestByChildSessionKey = buildLatestSubagentRunIndex(snapshot).latestByChildSessionKey;
  const filtered = Array.from(latestByChildSessionKey.values()).filter((entry) => {
    const latestControllerSessionKey =
      entry.controllerSessionKey?.trim() || entry.requesterSessionKey?.trim();
    return latestControllerSessionKey === key;
  });
  return sortSubagentRuns(filtered);
}

function ensureControllerOwnsRun(params: {
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}) {
  const owner = params.entry.controllerSessionKey?.trim() || params.entry.requesterSessionKey;
  if (owner === params.controller.controllerSessionKey) {
    return undefined;
  }
  return "Subagents can only control runs spawned from their own session.";
}

async function killSubagentRun(params: {
  cfg: OpenClawConfig;
  entry: SubagentRunRecord;
  cache: Map<string, Record<string, SessionEntry>>;
  pendingDescendants?: number;
}): Promise<{ killed: boolean; sessionId?: string }> {
  const workflow = resolveSubagentWorkflowProjection(
    params.entry,
    params.pendingDescendants ?? countPendingDescendantRuns(params.entry.childSessionKey),
  );
  if (workflow.terminal) {
    return { killed: false };
  }
  const childSessionKey = params.entry.childSessionKey;
  const resolved = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: childSessionKey,
    cache: params.cache,
  });
  const sessionId = resolved.entry?.sessionId;
  const runtime = await resolveSubagentControlRuntime();
  const aborted = sessionId ? runtime.abortEmbeddedPiRun(sessionId) : false;
  const cleared = runtime.clearSessionQueues([childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }
  if (resolved.entry) {
    try {
      await subagentControlDeps.updateSessionStore(resolved.storePath, (store) => {
        const current = store[childSessionKey];
        if (!current) {
          return;
        }
        current.abortedLastRun = true;
        current.updatedAt = Date.now();
        store[childSessionKey] = current;
      });
    } catch (error) {
      logVerbose(
        `subagents control kill: failed to persist abortedLastRun for ${childSessionKey}: ${formatErrorMessage(error)}`,
      );
    }
  }
  const marked = markSubagentRunTerminated({
    runId: params.entry.runId,
    childSessionKey,
    reason: "killed",
  });
  const killed = marked > 0 || aborted || cleared.followupCleared > 0 || cleared.laneCleared > 0;
  return { killed, sessionId };
}

async function cascadeKillChildren(params: {
  cfg: OpenClawConfig;
  parentChildSessionKey: string;
  cache: Map<string, Record<string, SessionEntry>>;
  seenChildSessionKeys?: Set<string>;
  latestRunsByChildSessionKey?: Map<string, SubagentRunRecord>;
  runsSnapshot?: Map<string, SubagentRunRecord>;
}): Promise<{ killed: number; labels: string[] }> {
  const runsSnapshot = params.runsSnapshot ?? getSubagentRunsSnapshotForRead(subagentRuns);
  const latestRunsByChildSessionKey =
    params.latestRunsByChildSessionKey ??
    buildLatestSubagentRunIndex(runsSnapshot).latestByChildSessionKey;
  const childRuns: SubagentRunRecord[] = [];
  for (const run of latestRunsByChildSessionKey.values()) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey) {
      continue;
    }
    const controllerSessionKey =
      run.controllerSessionKey?.trim() || run.requesterSessionKey?.trim();
    if (controllerSessionKey !== params.parentChildSessionKey) {
      continue;
    }
    childRuns.push(run);
  }
  const seenChildSessionKeys = params.seenChildSessionKeys ?? new Set<string>();
  let killed = 0;
  const labels: string[] = [];

  for (const run of childRuns) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey || seenChildSessionKeys.has(childKey)) {
      continue;
    }
    seenChildSessionKeys.add(childKey);

    const workflow = resolveSubagentWorkflowProjection(
      run,
      countPendingDescendantRunsFromRuns(runsSnapshot, run.childSessionKey),
    );
    if (!workflow.terminal) {
      const stopResult = await killSubagentRun({
        cfg: params.cfg,
        entry: run,
        cache: params.cache,
        pendingDescendants: countPendingDescendantRunsFromRuns(runsSnapshot, run.childSessionKey),
      });
      if (stopResult.killed) {
        killed += 1;
        labels.push(resolveSubagentLabel(run));
      }
    }

    const cascade = await cascadeKillChildren({
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      cache: params.cache,
      seenChildSessionKeys,
      latestRunsByChildSessionKey,
      runsSnapshot,
    });
    killed += cascade.killed;
    labels.push(...cascade.labels);
  }

  return { killed, labels };
}

export async function killAllControlledSubagentRuns(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  runs: SubagentRunRecord[];
}) {
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
      killed: 0,
      labels: [],
    };
  }
  const cache = new Map<string, Record<string, SessionEntry>>();
  const seenChildSessionKeys = new Set<string>();
  const runsSnapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const latestRunsByChildSessionKey =
    buildLatestSubagentRunIndex(runsSnapshot).latestByChildSessionKey;
  const killedLabels: string[] = [];
  let killed = 0;
  for (const entry of params.runs) {
    const childKey = entry.childSessionKey?.trim();
    if (!childKey || seenChildSessionKeys.has(childKey)) {
      continue;
    }
    const currentEntry = latestRunsByChildSessionKey.get(childKey);
    if (!currentEntry || currentEntry.runId !== entry.runId) {
      continue;
    }
    seenChildSessionKeys.add(childKey);

    const workflow = resolveSubagentWorkflowProjection(
      currentEntry,
      countPendingDescendantRunsFromRuns(runsSnapshot, currentEntry.childSessionKey),
    );
    if (!workflow.terminal) {
      const stopResult = await killSubagentRun({
        cfg: params.cfg,
        entry: currentEntry,
        cache,
        pendingDescendants: countPendingDescendantRunsFromRuns(
          runsSnapshot,
          currentEntry.childSessionKey,
        ),
      });
      if (stopResult.killed) {
        killed += 1;
        killedLabels.push(resolveSubagentLabel(currentEntry));
      }
    }

    const cascade = await cascadeKillChildren({
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      cache,
      seenChildSessionKeys,
      latestRunsByChildSessionKey,
      runsSnapshot,
    });
    killed += cascade.killed;
    killedLabels.push(...cascade.labels);
  }
  return { status: "ok" as const, killed, labels: killedLabels };
}

export async function killControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}) {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return {
      status: "forbidden" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: ownershipError,
    };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const currentEntry = getLatestSubagentRunByChildSessionKey(params.entry.childSessionKey);
  if (!currentEntry || currentEntry.runId !== params.entry.runId) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const killCache = new Map<string, Record<string, SessionEntry>>();
  const runsSnapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const latestRunsByChildSessionKey =
    buildLatestSubagentRunIndex(runsSnapshot).latestByChildSessionKey;
  const stopResult = await killSubagentRun({
    cfg: params.cfg,
    entry: currentEntry,
    cache: killCache,
    pendingDescendants: countPendingDescendantRunsFromRuns(
      runsSnapshot,
      currentEntry.childSessionKey,
    ),
  });
  const seenChildSessionKeys = new Set<string>();
  const targetChildKey = params.entry.childSessionKey?.trim();
  if (targetChildKey) {
    seenChildSessionKeys.add(targetChildKey);
  }
  const cascade = await cascadeKillChildren({
    cfg: params.cfg,
    parentChildSessionKey: params.entry.childSessionKey,
    cache: killCache,
    seenChildSessionKeys,
    latestRunsByChildSessionKey,
    runsSnapshot,
  });
  if (!stopResult.killed && cascade.killed === 0) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const cascadeText =
    cascade.killed > 0 ? ` (+ ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"})` : "";
  return {
    status: "ok" as const,
    runId: params.entry.runId,
    sessionKey: params.entry.childSessionKey,
    label: resolveSubagentLabel(params.entry),
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
    text: stopResult.killed
      ? `killed ${resolveSubagentLabel(params.entry)}${cascadeText}.`
      : `killed ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"} of ${resolveSubagentLabel(params.entry)}.`,
  };
}

export async function killSubagentRunAdmin(params: { cfg: OpenClawConfig; sessionKey: string }) {
  const targetSessionKey = params.sessionKey.trim();
  if (!targetSessionKey) {
    return { found: false as const, killed: false };
  }
  const entry = getLatestSubagentRunByChildSessionKey(targetSessionKey);
  if (!entry) {
    return { found: false as const, killed: false };
  }

  const killCache = new Map<string, Record<string, SessionEntry>>();
  const runsSnapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const latestRunsByChildSessionKey =
    buildLatestSubagentRunIndex(runsSnapshot).latestByChildSessionKey;
  const stopResult = await killSubagentRun({
    cfg: params.cfg,
    entry,
    cache: killCache,
    pendingDescendants: countPendingDescendantRunsFromRuns(runsSnapshot, entry.childSessionKey),
  });
  const seenChildSessionKeys = new Set<string>([targetSessionKey]);
  const cascade = await cascadeKillChildren({
    cfg: params.cfg,
    parentChildSessionKey: targetSessionKey,
    cache: killCache,
    seenChildSessionKeys,
    latestRunsByChildSessionKey,
    runsSnapshot,
  });

  return {
    found: true as const,
    killed: stopResult.killed || cascade.killed > 0,
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
  };
}

export async function steerControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
}): Promise<
  | {
      status: "forbidden" | "done" | "rate_limited" | "error";
      runId?: string;
      sessionKey: string;
      sessionId?: string;
      error?: string;
      text?: string;
    }
  | {
      status: "accepted";
      runId: string;
      sessionKey: string;
      sessionId?: string;
      mode: "restart";
      label: string;
      text: string;
    }
> {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: ownershipError,
    };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  if (
    resolveSubagentWorkflowProjection(
      params.entry,
      countPendingDescendantRuns(params.entry.childSessionKey),
    ).terminal
  ) {
    return {
      status: "done",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  if (params.controller.callerSessionKey === params.entry.childSessionKey) {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Subagents cannot steer themselves.",
    };
  }
  const currentEntry = getLatestSubagentRunByChildSessionKey(params.entry.childSessionKey);
  if (
    !currentEntry ||
    currentEntry.runId !== params.entry.runId ||
    resolveSubagentWorkflowProjection(
      currentEntry,
      countPendingDescendantRuns(currentEntry.childSessionKey),
    ).terminal
  ) {
    return {
      status: "done",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }

  const rateKey = `${params.controller.callerSessionKey}:${params.entry.childSessionKey}`;
  if (process.env.VITEST !== "true") {
    const now = Date.now();
    const lastSentAt = steerRateLimit.get(rateKey) ?? 0;
    if (now - lastSentAt < STEER_RATE_LIMIT_MS) {
      return {
        status: "rate_limited",
        runId: params.entry.runId,
        sessionKey: params.entry.childSessionKey,
        error: "Steer rate limit exceeded. Wait a moment before sending another steer.",
      };
    }
    steerRateLimit.set(rateKey, now);
  }

  markSubagentRunForSteerRestart(params.entry.runId);

  const targetSession = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: params.entry.childSessionKey,
    cache: new Map<string, Record<string, SessionEntry>>(),
  });
  const sessionId =
    typeof targetSession.entry?.sessionId === "string" && targetSession.entry.sessionId.trim()
      ? targetSession.entry.sessionId.trim()
      : undefined;

  if (sessionId) {
    const runtime = await resolveSubagentControlRuntime();
    runtime.abortEmbeddedPiRun(sessionId);
  }
  const runtime = await resolveSubagentControlRuntime();
  const cleared = runtime.clearSessionQueues([params.entry.childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control steer: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }

  try {
    await subagentControlDeps.callGateway({
      method: "agent.wait",
      params: {
        runId: params.entry.runId,
        timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS,
      },
      timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS + 2_000,
    });
  } catch {
    // Continue even if wait fails; steer should still be attempted.
  }

  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;
  let recoveryAdmission;
  try {
    recoveryAdmission = prepareSubagentRecoveryAdmission({
      entry: params.entry,
      nextRunId: idempotencyKey,
    });
    runId = recoveryAdmission.nextRunId;
  } catch (error) {
    clearSubagentRunSteerRestart(params.entry.runId);
    return {
      status: "error" as const,
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId,
      error: formatErrorMessage(error),
    };
  }
  const cleanupAcceptedRecoveryRun = () => {
    if (sessionId) {
      runtime.abortEmbeddedPiRun(sessionId);
    }
    runtime.clearSessionQueues([params.entry.childSessionKey, sessionId]);
  };
  let dispatchAttempted = false;
  try {
    dispatchAttempted = true;
    const response = await subagentControlDeps.callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: params.message,
        sessionKey: params.entry.childSessionKey,
        sessionId,
        idempotencyKey: recoveryAdmission.nextRunId,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_SUBAGENT,
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      runId = response.runId;
    }
    recoveryAdmission = movePreparedSubagentRecoveryAdmission({
      entry: params.entry,
      admission: recoveryAdmission,
      nextRunId: runId,
    });
  } catch (err) {
    if (!dispatchAttempted) {
      rollbackSubagentRecoveryAdmission({ entry: params.entry, admission: recoveryAdmission });
    } else {
      cleanupAcceptedRecoveryRun();
      quarantineUncertainSubagentRecovery({
        entry: params.entry,
        runId,
        reason: "Recovery dispatch failed without synchronous abort proof.",
      });
    }
    clearSubagentRunSteerRestart(params.entry.runId);
    const error = formatErrorMessage(err);
    return {
      status: "error",
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId,
      error,
    };
  }

  const replaced = await replaceSubagentRunAfterSteer({
    previousRunId: params.entry.runId,
    nextRunId: runId,
    fallback: params.entry,
    runTimeoutSeconds: params.entry.runTimeoutSeconds ?? 0,
  });
  if (!replaced) {
    const pendingEntry = subagentRuns.get(runId);
    const pendingRemap = pendingEntry?.recoveryRemap;
    if (
      pendingEntry &&
      pendingRemap?.previousRunId === params.entry.runId &&
      pendingRemap.nextRunId === runId &&
      isSubagentRecoveryStageDurablyBlocked(pendingEntry)
    ) {
      return {
        status: "accepted" as const,
        runId,
        sessionKey: params.entry.childSessionKey,
        sessionId,
        mode: "restart" as const,
        label: resolveSubagentLabel(params.entry),
        text: `steered ${resolveSubagentLabel(params.entry)}; recovery reconciliation is pending.`,
      };
    }
    cleanupAcceptedRecoveryRun();
    quarantineUncertainSubagentRecovery({
      entry: params.entry,
      runId,
      reason: "Accepted recovery run could not be reconciled or synchronously aborted.",
    });
    clearSubagentRunSteerRestart(params.entry.runId);
    return {
      status: "error",
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId,
      error: "failed to replace steered subagent run",
    };
  }

  return {
    status: "accepted",
    runId,
    sessionKey: params.entry.childSessionKey,
    sessionId,
    mode: "restart",
    label: resolveSubagentLabel(params.entry),
    text: `steered ${resolveSubagentLabel(params.entry)}.`,
  };
}

export async function sendControlledSubagentMessage(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
}) {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return { status: "forbidden" as const, error: ownershipError };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const currentEntry = getLatestSubagentRunByChildSessionKey(params.entry.childSessionKey);
  if (!currentEntry || currentEntry.runId !== params.entry.runId) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }

  const targetSessionKey = params.entry.childSessionKey;
  const parsed = parseAgentSessionKey(targetSessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed?.agentId });
  const store = loadSessionStore(storePath);
  const targetSessionEntry = store[targetSessionKey];
  const targetSessionId =
    typeof targetSessionEntry?.sessionId === "string" && targetSessionEntry.sessionId.trim()
      ? targetSessionEntry.sessionId.trim()
      : undefined;

  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;
  try {
    const baselineReply = await readLatestAssistantReplySnapshot({
      sessionKey: targetSessionKey,
      limit: SUBAGENT_REPLY_HISTORY_LIMIT,
      callGateway: subagentControlDeps.callGateway,
    });

    const response = await subagentControlDeps.callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: params.message,
        sessionKey: targetSessionKey,
        sessionId: targetSessionId,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_SUBAGENT,
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    const responseRunId = typeof response?.runId === "string" ? response.runId : undefined;
    if (responseRunId) {
      runId = responseRunId;
    }

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId,
      sessionKey: targetSessionKey,
      timeoutMs: 30_000,
      limit: SUBAGENT_REPLY_HISTORY_LIMIT,
      baseline: baselineReply,
      callGateway: subagentControlDeps.callGateway,
    });
    if (result.status === "timeout") {
      return { status: "timeout" as const, runId };
    }
    if (result.status === "error") {
      return {
        status: "error" as const,
        runId,
        error: result.error ?? "unknown error",
      };
    }
    return { status: "ok" as const, runId, replyText: result.replyText };
  } catch (err) {
    const error = formatErrorMessage(err);
    return { status: "error" as const, runId, error };
  }
}

export function resolveControlledSubagentTarget(
  runs: SubagentRunRecord[],
  token: string | undefined,
  options?: { recentMinutes?: number; isActive?: (entry: SubagentRunRecord) => boolean },
): SubagentTargetResolution {
  return resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: options?.recentMinutes ?? DEFAULT_RECENT_MINUTES,
    label: (entry) => resolveSubagentLabel(entry),
    isActive: options?.isActive,
    errors: {
      missingTarget: "Missing subagent target.",
      invalidIndex: (value) => `Invalid subagent index: ${value}`,
      unknownSession: (value) => `Unknown subagent session: ${value}`,
      ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
      ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}`,
      ambiguousRunIdPrefix: (value) => `Ambiguous subagent run id prefix: ${value}`,
      unknownTarget: (value) => `Unknown subagent target: ${value}`,
    },
  });
}

export const __testing = {
  setDepsForTest(
    overrides?: Partial<{
      callGateway: GatewayCaller;
      updateSessionStore: UpdateSessionStore;
      abortEmbeddedPiRun: AbortEmbeddedPiRun;
      clearSessionQueues: ClearSessionQueues;
    }>,
  ) {
    subagentControlDeps = overrides
      ? {
          ...defaultSubagentControlDeps,
          ...overrides,
        }
      : defaultSubagentControlDeps;
  },
};
