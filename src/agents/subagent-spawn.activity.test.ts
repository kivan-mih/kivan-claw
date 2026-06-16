import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as activityNotify from "./subagent-activity-notify.js";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  updateSessionStoreMock: vi.fn(),
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

// The activity helper uses its own callGateway, independent of the spawn module's
// injected gateway. Mock that seam so we can observe the start ping directly.
const activitySend = vi.fn(async (_opts: unknown) => ({ messageId: "ping" }));

async function spawn(params?: { label?: string; agentChannel?: string; agentTo?: string }) {
  return await spawnSubagentDirect(
    { task: "do thing", ...(params?.label ? { label: params.label } : {}), context: "isolated" },
    {
      agentSessionKey: "main",
      agentChannel: params?.agentChannel ?? "discord",
      agentTo: params?.agentTo,
    },
  );
}

beforeAll(async () => {
  ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
    callGatewayMock: hoisted.callGatewayMock,
    getRuntimeConfig: () => hoisted.configOverride,
    updateSessionStoreMock: hoisted.updateSessionStoreMock,
    hookRunner: {
      hasHooks: () => false,
      runSubagentSpawning: vi.fn(async () => undefined),
      runSubagentSpawned: vi.fn(async () => {}),
      runSubagentEnded: vi.fn(async () => {}),
    },
    resetModules: false,
    sessionStorePath: "/tmp/subagent-spawn-activity-session-store.json",
  }));
});

afterEach(() => {
  resetSubagentRegistryForTests();
  activityNotify.__testing.setDepsForTest();
});

beforeEach(() => {
  resetSubagentRegistryForTests();
  hoisted.callGatewayMock.mockReset();
  hoisted.updateSessionStoreMock.mockReset();
  activitySend.mockClear();
  activityNotify.__testing.setDepsForTest({ callGateway: activitySend as never });
  hoisted.configOverride = createSubagentSpawnTestConfig(undefined, {
    session: { mainKey: "main", scope: "per-sender" },
  });
  const store: Record<string, Record<string, unknown>> = {};
  hoisted.updateSessionStoreMock.mockImplementation(
    async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      return store;
    },
  );
  hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent") {
      return { runId: "run-1", status: "accepted", acceptedAt: 1_001 };
    }
    return {};
  });
});

describe("subagent start activity ping", () => {
  it("sends a level-1 start ping to the originating chat", async () => {
    const result = await spawn({ label: "research-helper", agentTo: "channel:123" });
    expect(result).toMatchObject({ status: "accepted" });

    // Start ping is fire-and-forget; flush the microtask queue.
    await Promise.resolve();

    expect(activitySend).toHaveBeenCalledTimes(1);
    const call = activitySend.mock.calls[0]?.[0] as {
      method?: string;
      params?: Record<string, unknown>;
    };
    expect(call.method).toBe("send");
    expect(call.params?.channel).toBe("discord");
    expect(call.params?.to).toBe("channel:123");
    expect(call.params?.message).toBe("🚀 Subagent started (level 1): research-helper");
    expect(String(call.params?.idempotencyKey)).toMatch(
      /^subagent-activity:v1:start:agent:main:subagent:/,
    );
  });

  it("no-ops when the spawn has no deliverable chat origin", async () => {
    const result = await spawn({ label: "research-helper" }); // no agentTo
    expect(result).toMatchObject({ status: "accepted" });

    await Promise.resolve();
    expect(activitySend).not.toHaveBeenCalled();
  });
});
