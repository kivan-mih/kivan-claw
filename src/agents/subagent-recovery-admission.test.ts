import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTaskRecord,
  finalizeTaskRunByRunId,
  getTaskById,
  reloadTaskRegistryFromStore,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import { isTaskStageConflictError } from "../tasks/task-stage-admission.js";
import {
  prepareSubagentRecoveryAdmission,
  rollbackSubagentRecoveryAdmission,
} from "./subagent-recovery-admission.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

describe("subagent recovery admission", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-admission-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetTaskRegistryForTests();
  });

  afterEach(async () => {
    resetTaskRegistryForTests({ persist: false });
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function createRun(taskId: string): SubagentRunRecord {
    return {
      runId: "run-recovery-old",
      taskId,
      stageKey: "implementation",
      childSessionKey: "agent:main:subagent:recovery-admission",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "recover guarded work",
      cleanup: "keep",
      createdAt: Date.now() - 1_000,
      startedAt: Date.now() - 900,
    };
  }

  it("rejects an operator-cancelled task before recovery dispatch", () => {
    const task = createTaskRecord({
      runtime: "subagent",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:recovery-admission",
      runId: "run-recovery-old",
      stageKey: "implementation",
      task: "recover guarded work",
      status: "cancelled",
    });

    expect(() =>
      prepareSubagentRecoveryAdmission({
        entry: createRun(task.taskId),
        nextRunId: "run-recovery-new",
      }),
    ).toThrow(/cancelled by an operator/i);
    expect(getTaskById(task.taskId)).toMatchObject({
      runId: "run-recovery-old",
      status: "cancelled",
    });
  });

  it("rejects recovery before dispatch when another task owns the stage", () => {
    const task = createTaskRecord({
      runtime: "subagent",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:recovery-admission",
      runId: "run-recovery-old",
      stageKey: "implementation",
      task: "recover guarded work",
      status: "failed",
    });
    const incumbent = createTaskRecord({
      runtime: "subagent",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:incumbent",
      runId: "run-incumbent",
      stageKey: "implementation",
      task: "replacement already owns the stage",
      status: "running",
    });

    try {
      prepareSubagentRecoveryAdmission({
        entry: createRun(task.taskId),
        nextRunId: "run-recovery-new",
      });
      throw new Error("Expected stage admission to reject recovery.");
    } catch (error) {
      expect(isTaskStageConflictError(error)).toBe(true);
    }
    expect(getTaskById(task.taskId)).toMatchObject({ status: "failed" });
    expect(getTaskById(incumbent.taskId)).toMatchObject({
      runId: "run-incumbent",
      status: "running",
    });
  });

  it("reuses one durable admission across concurrent calls and restart", () => {
    const task = createTaskRecord({
      runtime: "subagent",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:recovery-admission",
      runId: "run-recovery-old",
      stageKey: "implementation",
      task: "recover guarded work",
      status: "running",
    });
    const entry = createRun(task.taskId);

    const first = prepareSubagentRecoveryAdmission({
      entry,
      nextRunId: "run-recovery-admission-1",
    });
    const concurrent = prepareSubagentRecoveryAdmission({
      entry,
      nextRunId: "run-recovery-admission-2",
    });

    expect(first.nextRunId).toBe("run-recovery-admission-1");
    expect(concurrent).toMatchObject({
      nextRunId: "run-recovery-admission-1",
      taskId: task.taskId,
    });
    expect(concurrent.originalTask).toBeUndefined();
    expect(getTaskById(task.taskId)).toMatchObject({
      runId: "run-recovery-old",
      status: "queued",
      recoveryAdmissionRunId: "run-recovery-admission-1",
    });
    expect(getTaskById(task.taskId)?.stageLeaseExpiresAt).toBeUndefined();

    reloadTaskRegistryFromStore();
    const afterRestart = prepareSubagentRecoveryAdmission({
      entry,
      nextRunId: "run-recovery-admission-3",
    });
    expect(afterRestart).toMatchObject({
      nextRunId: "run-recovery-admission-1",
      taskId: task.taskId,
    });
    expect(() =>
      createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:subagent:duplicate",
        runId: "run-duplicate",
        stageKey: "implementation",
        task: "duplicate recovery stage",
        status: "running",
      }),
    ).toThrow();
  });

  it("clears terminal fields while admitted and restores them on proven rollback", () => {
    const endedAt = Date.now() - 1_000;
    const task = createTaskRecord({
      runtime: "subagent",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:recovery-admission",
      runId: "run-recovery-old",
      stageKey: "implementation",
      task: "recover guarded work",
      status: "failed",
      deliveryStatus: "delivered",
      lastEventAt: endedAt,
      terminalSummary: "old failure",
      terminalOutcome: "blocked",
    });
    finalizeTaskRunByRunId({
      runId: "run-recovery-old",
      runtime: "subagent",
      sessionKey: "agent:main:subagent:recovery-admission",
      status: "failed",
      endedAt,
      lastEventAt: endedAt,
      error: "old error",
      terminalSummary: "old failure",
      terminalOutcome: "blocked",
    });
    const entry = createRun(task.taskId);

    const admission = prepareSubagentRecoveryAdmission({
      entry,
      nextRunId: "run-recovery-terminal",
    });
    const admitted = getTaskById(task.taskId);
    expect(admitted).toMatchObject({
      status: "queued",
      deliveryStatus: "pending",
      recoveryAdmissionRunId: "run-recovery-terminal",
    });
    expect(admitted).not.toHaveProperty("endedAt");
    expect(admitted).not.toHaveProperty("error");
    expect(admitted).not.toHaveProperty("cleanupAfter");
    expect(admitted).not.toHaveProperty("terminalSummary");
    expect(admitted).not.toHaveProperty("terminalOutcome");

    expect(rollbackSubagentRecoveryAdmission({ entry, admission })).toBe(true);
    expect(getTaskById(task.taskId)).toMatchObject({
      status: "failed",
      deliveryStatus: "delivered",
      terminalSummary: "old failure",
      terminalOutcome: "blocked",
    });
  });
});
