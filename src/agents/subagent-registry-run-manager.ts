import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  forceFinalizeTaskRunById,
  rebindActiveTaskRun,
  recordTaskRunProgressByRunId,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
} from "../tasks/detached-task-runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { isRecoverableAgentWaitError, waitForAgentRun } from "./run-wait.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import { type SubagentRunOutcome, withSubagentOutcomeTiming } from "./subagent-announce-output.js";
import {
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  emitSubagentEndedHookOnce,
  shouldUpdateRunOutcome,
} from "./subagent-registry-completion.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  persistSubagentSessionTiming,
  resolveArchiveAfterMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentWorkflowProjection } from "./subagent-run-liveness.js";

const log = createSubsystemLogger("agents/subagent-registry");
const RECOVERABLE_WAIT_RETRY_DELAY_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 25 : 5_000;
// Grace to await a still-active whole-run loop before deferring a terminal wait. Mirrors
// the lifecycle path's `LIFECYCLE_COMPLETE_RETRY_GRACE_MS` (subagent-registry.ts).
const LOOP_SETTLE_GRACE_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 50 : 15_000;

function shouldDeleteAttachments(entry: SubagentRunRecord) {
  return entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
}

export function markSubagentRunPausedAfterYield(params: {
  entry: SubagentRunRecord;
  startedAt?: number;
  endedAt?: number;
  now?: number;
}): boolean {
  const { entry } = params;
  let mutated = false;
  if (typeof params.startedAt === "number" && entry.startedAt !== params.startedAt) {
    entry.startedAt = params.startedAt;
    if (typeof entry.sessionStartedAt !== "number") {
      entry.sessionStartedAt = params.startedAt;
    }
    mutated = true;
  }
  const endedAt = typeof params.endedAt === "number" ? params.endedAt : (params.now ?? Date.now());
  if (entry.endedAt !== endedAt) {
    entry.endedAt = endedAt;
    mutated = true;
  }
  if (entry.pauseReason !== "sessions_yield") {
    entry.pauseReason = "sessions_yield";
    mutated = true;
  }
  if (entry.outcome !== undefined) {
    entry.outcome = undefined;
    mutated = true;
  }
  if (entry.endedReason !== undefined) {
    entry.endedReason = undefined;
    mutated = true;
  }
  if (entry.cleanupHandled === true) {
    entry.cleanupHandled = false;
    mutated = true;
  }
  if (entry.frozenResultText !== undefined) {
    entry.frozenResultText = undefined;
    entry.frozenResultCapturedAt = undefined;
    mutated = true;
  }
  return mutated;
}

export type RegisterSubagentRunParams = {
  runId: string;
  taskId?: string;
  stageKey?: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  spawnMode?: "run" | "session";
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
};

export function createSubagentRunManager(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  endedHookInFlightRunIds: Set<string>;
  persist(): boolean | void;
  callGateway: typeof callGateway;
  getRuntimeConfig: typeof getRuntimeConfig;
  ensureRuntimePluginsLoaded:
    | typeof ensureRuntimePluginsLoadedFn
    | ((args: {
        config: OpenClawConfig;
        workspaceDir?: string;
        allowGatewaySubagentBinding?: boolean;
      }) => void | Promise<void>);
  ensureListener(): void;
  startSweeper(): void;
  stopSweeper(): void;
  resumeSubagentRun(runId: string): void;
  clearPendingLifecycleState(runId: string): void;
  countPendingDescendantRuns(rootSessionKey: string): number;
  resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number): number;
  scheduleOrphanRecovery(args?: { delayMs?: number; maxRetries?: number }): void;
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted" | "released";
    agentDir?: string;
    workspaceDir?: string;
  }): Promise<void>;
  completeCleanupBookkeeping(args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
  }): void;
  completeSubagentRun(args: {
    runId: string;
    endedAt?: number;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    triggerCleanup: boolean;
  }): Promise<void>;
  // Whole-run loop-active signal (subagent-registry passes the pi-embedded-runner
  // helpers). Injected rather than imported to avoid a run-manager -> registry cycle and
  // to keep the module unit-testable in isolation.
  isEmbeddedPiRunLoopActive(sessionKey: string | undefined): boolean;
  waitForEmbeddedPiRunLoopEnd(sessionKey: string | undefined, timeoutMs?: number): Promise<boolean>;
}) {
  const createLogicalSubagentTask = (entry: SubagentRunRecord, startedAt: number) => {
    if (entry.taskId) {
      const started = startTaskRunByRunId({
        runId: entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        startedAt,
        lastEventAt: startedAt,
        progressSummary: "Subagent execution started.",
      })[0];
      if (!started || started.taskId !== entry.taskId) {
        throw new Error(`Reserved background task was not found for subagent run ${entry.runId}.`);
      }
      return started;
    }
    return createRunningTaskRun({
      runtime: "subagent",
      sourceId: entry.logicalRunId ?? entry.runId,
      stageKey: entry.stageKey,
      ownerKey: entry.requesterSessionKey,
      scopeKind: "session",
      requesterOrigin: entry.requesterOrigin,
      childSessionKey: entry.childSessionKey,
      runId: entry.runId,
      label: entry.label,
      task: entry.task,
      deliveryStatus: entry.expectsCompletionMessage === false ? "not_applicable" : "pending",
      startedAt,
      lastEventAt: startedAt,
    });
  };

  const markRecovering = async (entry: SubagentRunRecord, error?: string) => {
    const now = Date.now();
    let mutated = false;
    if (entry.recoveryState !== "recovering") {
      entry.recoveryState = "recovering";
      mutated = true;
    }
    if (typeof entry.recoveryStartedAt !== "number") {
      entry.recoveryStartedAt = now;
      mutated = true;
    }
    if (mutated) {
      params.persist();
    }
    try {
      await persistSubagentSessionTiming(entry);
    } catch (sessionError) {
      log.warn("Failed to reconcile recovering subagent session state", {
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        error: sessionError,
      });
    }
    try {
      recordTaskRunProgressByRunId({
        runId: entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        lastEventAt: now,
        progressSummary: "Recovering after a transport interruption.",
        eventSummary: error,
      });
    } catch (taskError) {
      log.warn("Failed to mark subagent task as recovering", {
        runId: entry.runId,
        error: taskError,
      });
    }
  };

  const waitForSubagentCompletion = async (
    runId: string,
    waitTimeoutMs: number,
    expectedEntry?: SubagentRunRecord,
  ) => {
    try {
      const wait = await waitForAgentRun({
        runId,
        timeoutMs: Math.max(1, Math.floor(waitTimeoutMs)),
        callGateway: params.callGateway,
      });
      const entry = params.runs.get(runId);
      if (!entry || (expectedEntry && entry !== expectedEntry)) {
        return;
      }
      if (wait.status === "pending") {
        return;
      }
      if (wait.yielded === true) {
        if (
          markSubagentRunPausedAfterYield({
            entry,
            startedAt: wait.startedAt,
            endedAt: wait.endedAt,
          })
        ) {
          params.persist();
        }
        return;
      }
      if (wait.status === "error" && isRecoverableAgentWaitError(wait.error)) {
        log.info("subagent wait interrupted; scheduling recovery", {
          runId,
          childSessionKey: expectedEntry?.childSessionKey ?? entry?.childSessionKey,
          error: wait.error,
        });
        await markRecovering(entry, wait.error);
        params.scheduleOrphanRecovery({ delayMs: 1_000 });
        const scheduledEntry = entry;
        setTimeout(() => {
          if (!scheduledEntry) {
            return;
          }
          const current = params.runs.get(runId);
          if (!current || current !== scheduledEntry || typeof current.endedAt === "number") {
            return;
          }
          void waitForSubagentCompletion(runId, waitTimeoutMs, scheduledEntry);
        }, RECOVERABLE_WAIT_RETRY_DELAY_MS).unref?.();
        return;
      }
      // A terminal wait result while the whole-run loop is still active is NOT truly
      // terminal: the run is between attempts (compaction / retry prep) and will resume.
      // Finalizing here would freeze an intermediate outcome (and, for overflow, the
      // "[assistant turn failed...]" placeholder) and tear down the announce listener
      // before the real final answer arrives. Defer like a recoverable wait, then re-fetch
      // a fresh snapshot once the loop settles — mirrors `completeTerminalRunWhenLoopSettled`
      // on the lifecycle path, which the primary in-process completer already honors.
      if (params.isEmbeddedPiRunLoopActive(entry.childSessionKey)) {
        const scheduledEntry = entry;
        const settled = await params.waitForEmbeddedPiRunLoopEnd(
          entry.childSessionKey,
          LOOP_SETTLE_GRACE_MS,
        );
        // Reschedule a fresh completion wait (immediately if the loop settled, else after
        // the recoverable delay) so it re-reads the true terminal snapshot. Guard against
        // a superseding run or an already-finalized entry, matching the recoverable path.
        setTimeout(
          () => {
            const current = params.runs.get(runId);
            if (!current || current !== scheduledEntry || typeof current.endedAt === "number") {
              return;
            }
            void waitForSubagentCompletion(runId, waitTimeoutMs, scheduledEntry);
          },
          settled ? 0 : RECOVERABLE_WAIT_RETRY_DELAY_MS,
        ).unref?.();
        return;
      }
      let mutated = false;
      if (typeof wait.startedAt === "number") {
        entry.startedAt = wait.startedAt;
        if (typeof entry.sessionStartedAt !== "number") {
          entry.sessionStartedAt = wait.startedAt;
        }
        mutated = true;
      }
      if (typeof wait.endedAt === "number") {
        entry.endedAt = wait.endedAt;
        mutated = true;
      }
      if (!entry.endedAt) {
        entry.endedAt = Date.now();
        mutated = true;
      }
      const waitError = typeof wait.error === "string" ? wait.error : undefined;
      const baseOutcome: SubagentRunOutcome =
        wait.status === "error"
          ? { status: "error", error: waitError }
          : wait.status === "timeout"
            ? { status: "timeout" }
            : { status: "ok" };
      const outcome = withSubagentOutcomeTiming(baseOutcome, {
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
      });
      if (shouldUpdateRunOutcome(entry.outcome, outcome)) {
        entry.outcome = outcome;
        mutated = true;
      }
      if (mutated) {
        params.persist();
      }
      await params.completeSubagentRun({
        runId,
        endedAt: entry.endedAt,
        outcome,
        reason:
          wait.status === "error" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
      });
    } catch {
      // ignore
    }
  };

  const markSubagentRunForSteerRestart = (runId: string) => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = params.runs.get(key);
    if (!entry) {
      return false;
    }
    if (entry.suppressAnnounceReason === "steer-restart") {
      return true;
    }
    entry.suppressAnnounceReason = "steer-restart";
    params.persist();
    return true;
  };

  const clearSubagentRunSteerRestart = (runId: string) => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = params.runs.get(key);
    if (!entry) {
      return false;
    }
    if (entry.suppressAnnounceReason !== "steer-restart") {
      return true;
    }
    entry.suppressAnnounceReason = undefined;
    params.persist();
    // If the interrupted run already finished while suppression was active, retry
    // cleanup now so completion output is not lost when restart dispatch fails.
    params.resumedRuns.delete(key);
    if (typeof entry.endedAt === "number" && !entry.cleanupCompletedAt) {
      params.resumeSubagentRun(key);
    }
    return true;
  };

  const persistRecoveryState = () => {
    if (params.persist() === false) {
      throw new Error("Failed to persist subagent recovery remap state.");
    }
  };

  const completeRecoveryRemap = async (next: SubagentRunRecord): Promise<void> => {
    const recoveryRemap = next.recoveryRemap;
    if (!recoveryRemap) {
      return;
    }
    const { previousRunId, nextRunId } = recoveryRemap;
    if (next.runId !== nextRunId) {
      throw new Error("Recovery remap target does not match the persisted run record.");
    }
    const previous = params.runs.get(previousRunId);
    if (previous) {
      const previousLogicalRunId = previous.logicalRunId ?? previous.runId;
      const nextLogicalRunId = next.logicalRunId ?? next.runId;
      if (
        previousLogicalRunId !== nextLogicalRunId ||
        (previous.taskId && next.taskId && previous.taskId !== next.taskId)
      ) {
        throw new Error("Recovery remap identity does not match its source run.");
      }
    }
    const now = Date.now();

    const createReplacementTask = () => {
      try {
        setDetachedTaskDeliveryStatusByRunId({
          runId: previousRunId,
          runtime: "subagent",
          sessionKey: next.childSessionKey,
          deliveryStatus: "not_applicable",
        });
        finalizeTaskRunByRunId({
          runId: previousRunId,
          runtime: "subagent",
          sessionKey: next.childSessionKey,
          status: "cancelled",
          endedAt: now,
          lastEventAt: now,
          terminalSummary: "Superseded by a recovered attempt.",
        });
      } catch (error) {
        log.warn("Failed to retire superseded subagent background task", {
          previousRunId,
          nextRunId,
          error,
        });
      }
      next.taskId = createLogicalSubagentTask({ ...next, taskId: undefined }, now).taskId;
    };

    if (recoveryRemap.phase === "prepared") {
      try {
        const rebound = rebindActiveTaskRun({
          taskId: next.taskId,
          previousRunId,
          nextRunId,
          runtime: "subagent",
          sessionKey: next.childSessionKey,
          lastEventAt: now,
          progressSummary: "Recovered; resumed execution.",
          recoverTerminal: true,
        });
        const reboundTask = rebound[0];
        if (reboundTask) {
          next.taskId = reboundTask.taskId;
        } else if (next.taskId) {
          throw new Error(
            `Background task ${next.taskId} could not be rebound for recovered subagent run.`,
          );
        } else {
          createReplacementTask();
        }
      } catch (error) {
        log.warn("Failed to rebind background task for recovered subagent run", {
          previousRunId,
          nextRunId,
          error,
        });
        throw error;
      }
      recoveryRemap.phase = "task_rebound";
      persistRecoveryState();
    }

    if (recoveryRemap.phase === "task_rebound") {
      await persistSubagentSessionTiming(next);
      recoveryRemap.phase = "session_reconciled";
      persistRecoveryState();
    }

    if (previousRunId !== nextRunId) {
      params.clearPendingLifecycleState(previousRunId);
      params.runs.delete(previousRunId);
      params.resumedRuns.delete(previousRunId);
    }
    next.recoveryRemap = undefined;
    try {
      persistRecoveryState();
    } catch (error) {
      next.recoveryRemap = recoveryRemap;
      throw error;
    }
  };

  const activateRecoveredRun = (next: SubagentRunRecord) => {
    const cfg = params.getRuntimeConfig();
    const waitTimeoutMs = params.resolveSubagentWaitTimeoutMs(cfg, next.runTimeoutSeconds ?? 0);
    params.ensureListener();
    params.startSweeper();
    params.resumedRuns.add(next.runId);
    void waitForSubagentCompletion(next.runId, waitTimeoutMs, next);
  };

  const replaceSubagentRunAfterSteer = async (replaceParams: {
    previousRunId: string;
    nextRunId: string;
    fallback?: SubagentRunRecord;
    runTimeoutSeconds?: number;
    preserveFrozenResultFallback?: boolean;
  }) => {
    const previousRunId = replaceParams.previousRunId.trim();
    const nextRunId = replaceParams.nextRunId.trim();
    if (!previousRunId || !nextRunId) {
      return false;
    }

    const existingNext = nextRunId === previousRunId ? undefined : params.runs.get(nextRunId);
    if (existingNext) {
      if (
        existingNext.recoveryRemap?.previousRunId === previousRunId &&
        existingNext.recoveryRemap.nextRunId === nextRunId
      ) {
        try {
          await completeRecoveryRemap(existingNext);
          activateRecoveredRun(existingNext);
          return true;
        } catch {
          return false;
        }
      }
      const previousForIdentity = params.runs.get(previousRunId) ?? replaceParams.fallback;
      if (
        previousForIdentity &&
        (existingNext.logicalRunId ?? existingNext.runId) ===
          (previousForIdentity.logicalRunId ?? previousForIdentity.runId) &&
        (!previousForIdentity.taskId || existingNext.taskId === previousForIdentity.taskId)
      ) {
        return true;
      }
      return false;
    }

    const previous = params.runs.get(previousRunId);
    const source = previous ?? replaceParams.fallback;
    if (!source) {
      return false;
    }
    if (
      source.endedReason === SUBAGENT_ENDED_REASON_KILLED ||
      source.suppressAnnounceReason === "killed"
    ) {
      return false;
    }
    params.clearPendingLifecycleState(previousRunId);
    params.clearPendingLifecycleState(nextRunId);

    const now = Date.now();
    const cfg = params.getRuntimeConfig();
    const archiveAfterMs = resolveArchiveAfterMs(cfg);
    const spawnMode = source.spawnMode === "session" ? "session" : "run";
    const archiveAtMs =
      spawnMode === "session" || source.cleanup === "keep"
        ? undefined
        : archiveAfterMs
          ? now + archiveAfterMs
          : undefined;
    const runTimeoutSeconds = replaceParams.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
    const preserveFrozenResultFallback = replaceParams.preserveFrozenResultFallback === true;
    const sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
    const accumulatedRuntimeMs =
      getSubagentSessionRuntimeMs(
        source,
        typeof source.endedAt === "number" ? source.endedAt : now,
      ) ?? 0;

    const next: SubagentRunRecord = {
      ...source,
      runId: nextRunId,
      logicalRunId: source.logicalRunId ?? source.runId,
      createdAt: now,
      startedAt: now,
      sessionStartedAt,
      accumulatedRuntimeMs,
      endedAt: undefined,
      endedReason: undefined,
      pauseReason: undefined,
      recoveryState: undefined,
      recoveryStartedAt: undefined,
      recoveryRemap: {
        previousRunId,
        nextRunId,
        phase: "prepared",
        preparedAt: now,
      },
      endedHookEmittedAt: undefined,
      wakeOnDescendantSettle: undefined,
      outcome: undefined,
      frozenResultText: undefined,
      frozenResultCapturedAt: undefined,
      fallbackFrozenResultText: preserveFrozenResultFallback ? source.frozenResultText : undefined,
      fallbackFrozenResultCapturedAt: preserveFrozenResultFallback
        ? source.frozenResultCapturedAt
        : undefined,
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      completionAnnouncedAt: undefined,
      suppressAnnounceReason: undefined,
      announceRetryCount: undefined,
      lastAnnounceRetryAt: undefined,
      spawnMode,
      archiveAtMs,
      runTimeoutSeconds,
    };
    params.runs.set(nextRunId, next);
    try {
      persistRecoveryState();
      await completeRecoveryRemap(next);
      if (previousRunId !== nextRunId && shouldDeleteAttachments(source)) {
        void safeRemoveAttachmentsDir(source);
      }
      activateRecoveredRun(next);
      return true;
    } catch (error) {
      log.warn("Subagent recovery remap remains pending for startup repair", {
        previousRunId,
        nextRunId,
        phase: next.recoveryRemap?.phase,
        error,
      });
      return false;
    }
  };

  const repairInterruptedRecoveryRemaps = async (): Promise<number> => {
    let repaired = 0;
    for (const entry of [...params.runs.values()]) {
      if (!entry.recoveryRemap) {
        continue;
      }
      try {
        await completeRecoveryRemap(entry);
        activateRecoveredRun(entry);
        repaired += 1;
      } catch (error) {
        log.warn("Failed to repair interrupted subagent recovery remap", {
          runId: entry.runId,
          phase: entry.recoveryRemap?.phase,
          error,
        });
      }
    }
    return repaired;
  };

  const registerSubagentRun = (registerParams: RegisterSubagentRunParams) => {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return;
    }
    const now = Date.now();
    const cfg = params.getRuntimeConfig();
    const archiveAfterMs = resolveArchiveAfterMs(cfg);
    const spawnMode = registerParams.spawnMode === "session" ? "session" : "run";
    const archiveAtMs =
      spawnMode === "session" || registerParams.cleanup === "keep"
        ? undefined
        : archiveAfterMs
          ? now + archiveAfterMs
          : undefined;
    const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = params.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
    const entry: SubagentRunRecord = {
      runId,
      logicalRunId: runId,
      taskId: registerParams.taskId,
      stageKey: registerParams.stageKey,
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey,
      requesterOrigin,
      requesterDisplayKey: registerParams.requesterDisplayKey,
      task: registerParams.task,
      cleanup: registerParams.cleanup,
      expectsCompletionMessage: registerParams.expectsCompletionMessage,
      spawnMode,
      label: registerParams.label,
      model: registerParams.model,
      agentDir: registerParams.agentDir,
      workspaceDir: registerParams.workspaceDir,
      runTimeoutSeconds,
      createdAt: now,
      startedAt: now,
      sessionStartedAt: now,
      accumulatedRuntimeMs: 0,
      archiveAtMs,
      cleanupHandled: false,
      completionAnnouncedAt: undefined,
      wakeOnDescendantSettle: undefined,
      attachmentsDir: registerParams.attachmentsDir,
      attachmentsRootDir: registerParams.attachmentsRootDir,
      retainAttachmentsOnKeep: registerParams.retainAttachmentsOnKeep,
    };
    params.runs.set(runId, entry);
    try {
      entry.taskId = createLogicalSubagentTask(entry, now).taskId;
    } catch (error) {
      log.warn("Failed to create background task for subagent run", {
        runId: registerParams.runId,
        error,
      });
      if (registerParams.taskId) {
        params.runs.delete(runId);
        throw error;
      }
    }
    params.ensureListener();
    params.persist();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    params.startSweeper();
    // Wait for subagent completion via gateway RPC (cross-process).
    // The in-process lifecycle listener is a fallback for embedded runs.
    void waitForSubagentCompletion(runId, waitTimeoutMs, entry);
  };

  const releaseSubagentRun = (runId: string) => {
    params.clearPendingLifecycleState(runId);
    const entry = params.runs.get(runId);
    if (entry) {
      if (shouldDeleteAttachments(entry)) {
        void safeRemoveAttachmentsDir(entry);
      }
      void params.notifyContextEngineSubagentEnded({
        childSessionKey: entry.childSessionKey,
        reason: "released",
        agentDir: entry.agentDir,
        workspaceDir: entry.workspaceDir,
      });
    }
    const didDelete = params.runs.delete(runId);
    if (didDelete) {
      params.persist();
    }
    if (params.runs.size === 0) {
      params.stopSweeper();
    }
  };

  const markSubagentRunTerminated = (markParams: {
    runId?: string;
    childSessionKey?: string;
    reason?: string;
  }): number => {
    const runIds = new Set<string>();
    const exactRunId = typeof markParams.runId === "string" ? markParams.runId.trim() : "";
    if (exactRunId) {
      runIds.add(exactRunId);
    } else if (
      typeof markParams.childSessionKey === "string" &&
      markParams.childSessionKey.trim()
    ) {
      for (const [runId, entry] of params.runs.entries()) {
        if (entry.childSessionKey === markParams.childSessionKey.trim()) {
          runIds.add(runId);
        }
      }
    }
    if (runIds.size === 0) {
      return 0;
    }

    const now = Date.now();
    const reason = markParams.reason?.trim() || "killed";
    let updated = 0;
    const entriesByChildSessionKey = new Map<string, SubagentRunRecord>();
    for (const runId of runIds) {
      params.clearPendingLifecycleState(runId);
      const entry = params.runs.get(runId);
      if (!entry) {
        continue;
      }
      if (
        resolveSubagentWorkflowProjection(
          entry,
          params.countPendingDescendantRuns(entry.childSessionKey),
        ).terminal
      ) {
        continue;
      }
      entry.endedAt = now;
      entry.outcome = withSubagentOutcomeTiming(
        { status: "error", error: reason },
        {
          startedAt: entry.startedAt,
          endedAt: now,
        },
      );
      entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
      entry.recoveryState = undefined;
      entry.recoveryStartedAt = undefined;
      entry.cleanupHandled = true;
      entry.cleanupCompletedAt = now;
      entry.suppressAnnounceReason = "killed";
      const taskRunIds = new Set([
        entry.runId,
        entry.recoveryRemap?.previousRunId,
        entry.recoveryRemap?.nextRunId,
      ]);
      // An operator kill supersedes any crash-repair intent. Clearing the
      // remap prevents restart repair from reviving explicitly cancelled work.
      entry.recoveryRemap = undefined;
      // A killed subagent no longer emits a reliable raw agent lifecycle event.
      // The subagent registry owns the logical task, so retire it here before
      // cleanup can make the run disappear from the owner registry.
      for (const taskRunId of taskRunIds) {
        if (!taskRunId) {
          continue;
        }
        try {
          setDetachedTaskDeliveryStatusByRunId({
            runId: taskRunId,
            runtime: "subagent",
            sessionKey: entry.childSessionKey,
            deliveryStatus: "not_applicable",
          });
        } catch (error) {
          log.warn("Failed to suppress delivery for terminated subagent task", {
            runId: taskRunId,
            error,
          });
        }
      }
      try {
        if (entry.taskId) {
          forceFinalizeTaskRunById({
            taskId: entry.taskId,
            status: "cancelled",
            endedAt: now,
            lastEventAt: now,
            error: reason,
            terminalSummary: "Subagent run was terminated.",
            terminalOutcome: null,
          });
        } else {
          for (const taskRunId of taskRunIds) {
            if (!taskRunId) {
              continue;
            }
            finalizeTaskRunByRunId({
              runId: taskRunId,
              runtime: "subagent",
              sessionKey: entry.childSessionKey,
              status: "cancelled",
              endedAt: now,
              lastEventAt: now,
              error: reason,
              terminalSummary: "Subagent run was terminated.",
            });
          }
        }
      } catch (error) {
        log.warn("Failed to cancel background task for terminated subagent run", {
          runId: entry.runId,
          error,
        });
      }
      if (!entriesByChildSessionKey.has(entry.childSessionKey)) {
        entriesByChildSessionKey.set(entry.childSessionKey, entry);
      }
      updated += 1;
    }
    if (updated > 0) {
      params.persist();
      for (const entry of entriesByChildSessionKey.values()) {
        const emitEndedHook = () =>
          emitSubagentEndedHookOnce({
            entry,
            reason: SUBAGENT_ENDED_REASON_KILLED,
            sendFarewell: true,
            accountId: entry.requesterOrigin?.accountId,
            outcome: SUBAGENT_ENDED_OUTCOME_KILLED,
            error: reason,
            inFlightRunIds: params.endedHookInFlightRunIds,
            persist: () => params.persist(),
          });
        void persistSubagentSessionTiming(entry).catch((err) => {
          log.warn("failed to persist killed subagent session timing", {
            err,
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
          });
        });
        if (shouldDeleteAttachments(entry)) {
          void safeRemoveAttachmentsDir(entry);
        }
        params.completeCleanupBookkeeping({
          runId: entry.runId,
          entry,
          cleanup: entry.cleanup,
          completedAt: now,
        });
        if (getGlobalHookRunner()) {
          void emitEndedHook().catch(() => {
            // Hook failures should not break termination flow.
          });
          continue;
        }
        const cfg = params.getRuntimeConfig();
        void Promise.resolve(
          params.ensureRuntimePluginsLoaded({
            config: cfg,
            workspaceDir: entry.workspaceDir,
            allowGatewaySubagentBinding: true,
          }),
        )
          .then(emitEndedHook)
          .catch(() => {
            // Hook failures should not break termination flow.
          });
      }
    }
    return updated;
  };

  return {
    clearSubagentRunSteerRestart,
    markSubagentRunForSteerRestart,
    markSubagentRunTerminated,
    registerSubagentRun,
    repairInterruptedRecoveryRemaps,
    releaseSubagentRun,
    replaceSubagentRunAfterSteer,
    waitForSubagentCompletion,
  };
}
