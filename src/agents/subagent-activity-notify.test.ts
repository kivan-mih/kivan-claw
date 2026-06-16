import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  __testing,
  buildSubagentActivityMessage,
  isSubagentActivityNotifyEnabled,
  notifySubagentActivity,
  resolveSubagentActivityName,
} from "./subagent-activity-notify.js";

const baseCfg = { session: { mainKey: "main", scope: "per-sender" } } as unknown as OpenClawConfig;
const externalOrigin = { channel: "telegram", to: "telegram:12345", accountId: "acct-1" };

function installCallGateway(impl: (req: unknown) => Promise<unknown>) {
  const spy = vi.fn(impl);
  __testing.setDepsForTest({ callGateway: spy as never });
  return spy;
}

afterEach(() => {
  __testing.setDepsForTest();
});

describe("resolveSubagentActivityName", () => {
  it("prefers the label when set", () => {
    expect(resolveSubagentActivityName({ label: "research-helper", task: "long task text" })).toBe(
      "research-helper",
    );
  });

  it("falls back to a truncated first line of the task", () => {
    const task = `${"x".repeat(80)}\nsecond line`;
    const name = resolveSubagentActivityName({ task });
    expect(name.endsWith("…")).toBe(true);
    expect(name.length).toBe(60);
    expect(name).not.toContain("second line");
  });

  it("returns 'subagent' when neither label nor task is usable", () => {
    expect(resolveSubagentActivityName({})).toBe("subagent");
    expect(resolveSubagentActivityName({ label: "   ", task: "   " })).toBe("subagent");
  });
});

describe("buildSubagentActivityMessage", () => {
  it("formats the start message with level", () => {
    expect(
      buildSubagentActivityMessage({ phase: "start", level: 1, name: "research-helper" }),
    ).toBe("🚀 Subagent started (level 1): research-helper");
  });

  it("formats the finish message with level", () => {
    expect(buildSubagentActivityMessage({ phase: "finish", level: 2, name: "deep-dive" })).toBe(
      "✅ Subagent finished (level 2): deep-dive",
    );
  });
});

describe("isSubagentActivityNotifyEnabled", () => {
  it("defaults to enabled", () => {
    expect(isSubagentActivityNotifyEnabled(baseCfg)).toBe(true);
  });

  it("is disabled only when explicitly set to false", () => {
    const cfg = {
      agents: { defaults: { subagents: { notifyActivity: false } } },
    } as unknown as OpenClawConfig;
    expect(isSubagentActivityNotifyEnabled(cfg)).toBe(false);
  });
});

describe("notifySubagentActivity", () => {
  it("sends a status-only start ping with a deterministic idempotency key", async () => {
    const send = installCallGateway(async () => ({ messageId: "m1" }));
    const ok = await notifySubagentActivity({
      cfg: baseCfg,
      phase: "start",
      level: 1,
      label: "research-helper",
      origin: externalOrigin,
      childSessionKey: "agent:main:subagent:abc",
      childRunId: "run-1",
    });

    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]?.[0] as { method?: string; params?: Record<string, unknown> };
    expect(call.method).toBe("send");
    expect(call.params?.channel).toBe("telegram");
    expect(call.params?.to).toBe("telegram:12345");
    expect(call.params?.accountId).toBe("acct-1");
    expect(call.params?.message).toBe("🚀 Subagent started (level 1): research-helper");
    expect(call.params?.idempotencyKey).toBe(
      "subagent-activity:v1:start:agent:main:subagent:abc:run-1",
    );
  });

  it("uses a distinct idempotency key for finish vs start", async () => {
    const send = installCallGateway(async () => ({}));
    await notifySubagentActivity({
      cfg: baseCfg,
      phase: "finish",
      level: 1,
      label: "x",
      origin: externalOrigin,
      childSessionKey: "agent:main:subagent:abc",
      childRunId: "run-1",
    });
    const call = send.mock.calls[0]?.[0] as { params?: { idempotencyKey?: string } };
    expect(call.params?.idempotencyKey).toBe(
      "subagent-activity:v1:finish:agent:main:subagent:abc:run-1",
    );
  });

  it("no-ops when the origin has no deliverable target (missing 'to')", async () => {
    const send = installCallGateway(async () => ({}));
    const ok = await notifySubagentActivity({
      cfg: baseCfg,
      phase: "start",
      level: 1,
      label: "x",
      origin: { channel: "telegram" },
      childSessionKey: "k",
      childRunId: "r",
    });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops when the origin is an internal (non-deliverable) channel", async () => {
    const send = installCallGateway(async () => ({}));
    const ok = await notifySubagentActivity({
      cfg: baseCfg,
      phase: "finish",
      level: 2,
      task: "t",
      origin: { channel: "webchat", to: "session:abc" },
      childSessionKey: "k",
      childRunId: "r",
    });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops when the origin is undefined (nested/cron with no chat)", async () => {
    const send = installCallGateway(async () => ({}));
    const ok = await notifySubagentActivity({
      cfg: baseCfg,
      phase: "finish",
      level: 3,
      task: "t",
      origin: undefined,
      childSessionKey: "k",
      childRunId: "r",
    });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops when disabled via config", async () => {
    const send = installCallGateway(async () => ({}));
    const cfg = {
      agents: { defaults: { subagents: { notifyActivity: false } } },
    } as unknown as OpenClawConfig;
    const ok = await notifySubagentActivity({
      cfg,
      phase: "start",
      level: 1,
      label: "x",
      origin: externalOrigin,
      childSessionKey: "k",
      childRunId: "r",
    });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("suppresses send failures and returns false (never throws)", async () => {
    installCallGateway(async () => {
      throw new Error("gateway closed (1006)");
    });
    await expect(
      notifySubagentActivity({
        cfg: baseCfg,
        phase: "finish",
        level: 1,
        label: "x",
        origin: externalOrigin,
        childSessionKey: "k",
        childRunId: "r",
      }),
    ).resolves.toBe(false);
  });
});
