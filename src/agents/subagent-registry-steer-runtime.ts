import type { SubagentRunRecord } from "./subagent-registry.types.js";

type ReplaceSubagentRunAfterSteerParams = {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
};

type ReplaceSubagentRunAfterSteerFn = (
  params: ReplaceSubagentRunAfterSteerParams,
) => boolean | Promise<boolean>;

type FinalizeInterruptedSubagentRunParams = {
  runId?: string;
  childSessionKey?: string;
  error: string;
  endedAt?: number;
};

type FinalizeInterruptedSubagentRunFn = (
  params: FinalizeInterruptedSubagentRunParams,
) => Promise<number>;

type HasPendingSubagentRecoveryRemapFn = (params: {
  previousRunId: string;
  nextRunId: string;
}) => boolean;

let replaceSubagentRunAfterSteerImpl: ReplaceSubagentRunAfterSteerFn | null = null;
let finalizeInterruptedSubagentRunImpl: FinalizeInterruptedSubagentRunFn | null = null;
let hasPendingSubagentRecoveryRemapImpl: HasPendingSubagentRecoveryRemapFn | null = null;

export function configureSubagentRegistrySteerRuntime(params: {
  replaceSubagentRunAfterSteer: ReplaceSubagentRunAfterSteerFn;
  finalizeInterruptedSubagentRun?: FinalizeInterruptedSubagentRunFn;
  hasPendingSubagentRecoveryRemap?: HasPendingSubagentRecoveryRemapFn;
}) {
  replaceSubagentRunAfterSteerImpl = params.replaceSubagentRunAfterSteer;
  finalizeInterruptedSubagentRunImpl = params.finalizeInterruptedSubagentRun ?? null;
  hasPendingSubagentRecoveryRemapImpl = params.hasPendingSubagentRecoveryRemap ?? null;
}

export async function replaceSubagentRunAfterSteer(params: ReplaceSubagentRunAfterSteerParams) {
  return (await replaceSubagentRunAfterSteerImpl?.(params)) ?? false;
}

export async function finalizeInterruptedSubagentRun(params: FinalizeInterruptedSubagentRunParams) {
  return (await finalizeInterruptedSubagentRunImpl?.(params)) ?? 0;
}

export function hasPendingSubagentRecoveryRemap(params: {
  previousRunId: string;
  nextRunId: string;
}) {
  return hasPendingSubagentRecoveryRemapImpl?.(params) ?? false;
}
