import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway as defaultCallGateway } from "../gateway/call.js";
import { resolveExternalBestEffortDeliveryTarget } from "../infra/outbound/best-effort-delivery.js";
import { defaultRuntime } from "../runtime.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type SubagentActivityPhase = "start" | "finish";

const MAX_ACTIVITY_NAME_LENGTH = 60;

function truncateActivityName(value: string): string {
  return value.length > MAX_ACTIVITY_NAME_LENGTH
    ? `${value.slice(0, MAX_ACTIVITY_NAME_LENGTH - 1)}…`
    : value;
}

/**
 * Human-meaningful subagent name for activity notifications: the explicit
 * `label` when set, else the first line of the `task` (truncated), else a
 * generic fallback. Never surfaces raw task bodies beyond the first line.
 */
export function resolveSubagentActivityName(params: { label?: string; task?: string }): string {
  const label = params.label?.trim();
  if (label) {
    return truncateActivityName(label);
  }
  const firstLine = (params.task ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) {
    return "subagent";
  }
  return truncateActivityName(firstLine);
}

export function buildSubagentActivityMessage(params: {
  phase: SubagentActivityPhase;
  level: number;
  name: string;
}): string {
  const icon = params.phase === "start" ? "🚀" : "✅";
  const verb = params.phase === "start" ? "started" : "finished";
  return `${icon} Subagent ${verb} (level ${params.level}): ${params.name}`;
}

/** Default ENABLED: only disabled when explicitly set to false. */
export function isSubagentActivityNotifyEnabled(cfg: OpenClawConfig): boolean {
  return cfg.agents?.defaults?.subagents?.notifyActivity !== false;
}

type SubagentActivityNotifyDeps = {
  callGateway: typeof defaultCallGateway;
};

const defaultDeps: SubagentActivityNotifyDeps = {
  callGateway: defaultCallGateway,
};

let deps: SubagentActivityNotifyDeps = defaultDeps;

/**
 * Best-effort, channel-agnostic status ping to the originating user chat when a
 * subagent starts or finishes. Carries ONLY status + name + level — never the
 * subagent's result text — so the parent-voice result delivery path is untouched
 * (see commit c20fe0346d). No-ops silently when there is no deliverable external
 * origin (nested/background/cron) or when disabled. Never throws.
 */
export async function notifySubagentActivity(params: {
  cfg: OpenClawConfig;
  phase: SubagentActivityPhase;
  level: number;
  label?: string;
  task?: string;
  origin?: DeliveryContext;
  // Used only to build a deterministic idempotency key — never sent.
  childSessionKey: string;
  childRunId: string;
}): Promise<boolean> {
  try {
    if (!isSubagentActivityNotifyEnabled(params.cfg)) {
      return false;
    }
    const target = resolveExternalBestEffortDeliveryTarget({
      channel: params.origin?.channel,
      to: params.origin?.to,
      accountId: params.origin?.accountId,
      threadId: params.origin?.threadId,
    });
    if (!target.deliver || !target.channel || !target.to) {
      // No deliverable external user-chat origin → silent no-op.
      return false;
    }
    const name = resolveSubagentActivityName({ label: params.label, task: params.task });
    const message = buildSubagentActivityMessage({
      phase: params.phase,
      level: params.level,
      name,
    });
    await deps.callGateway({
      method: "send",
      params: {
        to: target.to,
        message,
        channel: target.channel,
        accountId: target.accountId,
        threadId: target.threadId,
        idempotencyKey: `subagent-activity:v1:${params.phase}:${params.childSessionKey}:${params.childRunId}`,
      },
      timeoutMs: 10_000,
    });
    return true;
  } catch (err) {
    // Best-effort: a failed ping must never break spawn or completion.
    defaultRuntime.log(
      `[warn] subagent activity ${params.phase} ping failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentActivityNotifyDeps>) {
    deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
  },
};
