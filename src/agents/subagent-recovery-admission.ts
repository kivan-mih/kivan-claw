import {
  claimDetachedTaskRecoveryAdmission,
  createRunningTaskRun,
  getDetachedTaskById,
  moveDetachedTaskRecoveryAdmission,
  rebindActiveTaskRun,
  restoreDetachedTaskRecoveryAdmission,
} from "../tasks/detached-task-runtime.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { isTaskStageConflictError } from "../tasks/task-stage-admission.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type PreparedSubagentRecoveryAdmission = {
  nextRunId: string;
  taskId?: string;
  originalTask?: TaskRecord;
};

export function prepareSubagentRecoveryAdmission(params: {
  entry: SubagentRunRecord;
  nextRunId: string;
}): PreparedSubagentRecoveryAdmission {
  const nextRunId = params.nextRunId.trim();
  if (!nextRunId) {
    throw new Error("Recovery run ID is required.");
  }
  const taskId = params.entry.taskId?.trim();
  if (!taskId) {
    return { nextRunId };
  }
  const task = getDetachedTaskById(taskId);
  if (!task) {
    throw new Error(`Background task ${taskId} was not found for subagent recovery.`);
  }
  if (task.recoveryAdmissionRunId) {
    if (task.runId !== params.entry.runId || task.status === "cancelled") {
      throw new Error(`Background task ${taskId} has an incompatible recovery admission.`);
    }
    return {
      nextRunId: task.recoveryAdmissionRunId,
      taskId,
    };
  }
  const admitted = claimDetachedTaskRecoveryAdmission({
    taskId,
    expectedRunId: params.entry.runId,
    recoveryRunId: nextRunId,
  });
  if (!admitted) {
    const current = getDetachedTaskById(taskId);
    if (current?.status === "cancelled") {
      throw new Error(`Background task ${taskId} was cancelled by an operator.`);
    }
    throw new Error(`Background task ${taskId} could not reserve its recovery stage.`);
  }
  return { nextRunId, taskId, originalTask: task };
}

export function movePreparedSubagentRecoveryAdmission(params: {
  entry: SubagentRunRecord;
  admission: PreparedSubagentRecoveryAdmission;
  nextRunId: string;
}): PreparedSubagentRecoveryAdmission {
  const nextRunId = params.nextRunId.trim();
  if (!params.admission.taskId || nextRunId === params.admission.nextRunId) {
    return { ...params.admission, nextRunId };
  }
  const moved = moveDetachedTaskRecoveryAdmission({
    taskId: params.admission.taskId,
    previousRecoveryRunId: params.admission.nextRunId,
    nextRecoveryRunId: nextRunId,
  });
  if (!moved) {
    throw new Error(
      `Background task ${params.admission.taskId} could not bind its accepted recovery admission.`,
    );
  }
  return { ...params.admission, nextRunId };
}

export function rollbackSubagentRecoveryAdmission(params: {
  entry: SubagentRunRecord;
  admission: PreparedSubagentRecoveryAdmission;
}): boolean {
  const original = params.admission.originalTask;
  if (!original) {
    return false;
  }
  return Boolean(
    restoreDetachedTaskRecoveryAdmission({
      originalTask: original,
      recoveryRunId: params.admission.nextRunId,
    }),
  );
}

export function quarantineUncertainSubagentRecovery(params: {
  entry: SubagentRunRecord;
  runId: string;
  reason: string;
}): boolean {
  const taskId = params.entry.taskId?.trim();
  if (taskId) {
    const current = getDetachedTaskById(taskId);
    const rebound = current?.runId
      ? rebindActiveTaskRun({
          taskId,
          previousRunId: current.runId,
          nextRunId: params.runId,
          runtime: "subagent",
          sessionKey: params.entry.childSessionKey,
          lastEventAt: Date.now(),
          progressSummary: params.reason,
          recoverTerminal: true,
        })[0]
      : undefined;
    if (rebound) {
      return true;
    }
  }
  const stageKey = params.entry.stageKey?.trim();
  if (!stageKey) {
    return false;
  }
  try {
    createRunningTaskRun({
      runtime: "subagent",
      sourceId: params.entry.logicalRunId ?? params.entry.runId,
      stageKey,
      ownerKey: params.entry.requesterSessionKey,
      scopeKind: "session",
      requesterOrigin: params.entry.requesterOrigin,
      childSessionKey: params.entry.childSessionKey,
      runId: params.runId,
      label: params.entry.label,
      task: params.entry.task,
      deliveryStatus: "not_applicable",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: params.reason,
    });
    return true;
  } catch (error) {
    // An incumbent conflict is itself a durable stage block.
    return isTaskStageConflictError(error);
  }
}

export function isSubagentRecoveryStageDurablyBlocked(entry: SubagentRunRecord): boolean {
  const taskId = entry.taskId?.trim();
  if (!taskId) {
    return false;
  }
  const task = getDetachedTaskById(taskId);
  return Boolean(
    (task?.status === "queued" || task?.status === "running") &&
    (task.runId === entry.runId || task.recoveryAdmissionRunId === entry.runId),
  );
}
