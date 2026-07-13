import type { TaskRecord } from "./task-registry.types.js";

export const TASK_STAGE_KEY_MAX_LENGTH = 256;

export class TaskStageConflictError extends Error {
  readonly code = "stage_conflict" as const;

  constructor(public readonly incumbent: TaskRecord) {
    super(`Stage ${incumbent.stageKey ?? ""} already has an active task.`);
    this.name = "TaskStageConflictError";
  }
}

export function isTaskStageConflictError(error: unknown): error is TaskStageConflictError {
  return error instanceof TaskStageConflictError;
}
