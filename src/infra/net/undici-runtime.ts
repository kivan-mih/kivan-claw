import { createRequire } from "node:module";
import { resolveUndiciAutoSelectFamilyConnectOptions } from "./undici-family-policy.js";

export const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

export type UndiciRuntimeDeps = {
  Agent: typeof import("undici").Agent;
  EnvHttpProxyAgent: typeof import("undici").EnvHttpProxyAgent;
  FormData?: typeof import("undici").FormData;
  ProxyAgent: typeof import("undici").ProxyAgent;
  fetch: typeof import("undici").fetch;
};

type UndiciAgentOptions = ConstructorParameters<UndiciRuntimeDeps["Agent"]>[0];
type UndiciEnvHttpProxyAgentOptions = ConstructorParameters<
  UndiciRuntimeDeps["EnvHttpProxyAgent"]
>[0];
type UndiciProxyAgentOptions = ConstructorParameters<UndiciRuntimeDeps["ProxyAgent"]>[0];

// Guarded fetch dispatchers intentionally stay on HTTP/1.1. Undici 8 enables
// HTTP/2 ALPN by default, but our guarded paths rely on dispatcher overrides
// that have not been reliable on the HTTP/2 path yet.
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({
  allowH2: false as const,
});

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function applyMissingConnectOptions(
  connect: Record<string, unknown>,
  defaults: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in connect)) {
      connect[key] = value;
    }
  }
}

function isUndiciRuntimeDeps(value: unknown): value is UndiciRuntimeDeps {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UndiciRuntimeDeps).Agent === "function" &&
    typeof (value as UndiciRuntimeDeps).EnvHttpProxyAgent === "function" &&
    typeof (value as UndiciRuntimeDeps).ProxyAgent === "function" &&
    typeof (value as UndiciRuntimeDeps).fetch === "function"
  );
}

export function loadUndiciRuntimeDeps(): UndiciRuntimeDeps {
  const override = (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY];
  if (isUndiciRuntimeDeps(override)) {
    return override;
  }

  const require = createRequire(import.meta.url);
  const undici = require("undici") as typeof import("undici");
  return {
    Agent: undici.Agent,
    EnvHttpProxyAgent: undici.EnvHttpProxyAgent,
    FormData: undici.FormData,
    ProxyAgent: undici.ProxyAgent,
    fetch: undici.fetch,
  };
}

export type DispatcherTimeoutSpec = {
  bodyTimeoutMs?: number;
  headersTimeoutMs?: number;
  connectTimeoutMs?: number;
};

function normalizeDispatcherTimeoutSpec(
  spec: number | DispatcherTimeoutSpec | undefined,
): DispatcherTimeoutSpec | undefined {
  if (spec === undefined) {
    return undefined;
  }
  if (typeof spec === "number") {
    if (!Number.isFinite(spec) || spec <= 0) {
      return undefined;
    }
    const value = Math.floor(spec);
    return { bodyTimeoutMs: value, headersTimeoutMs: value, connectTimeoutMs: value };
  }
  const out: DispatcherTimeoutSpec = {};
  if (
    typeof spec.bodyTimeoutMs === "number" &&
    Number.isFinite(spec.bodyTimeoutMs) &&
    spec.bodyTimeoutMs > 0
  ) {
    out.bodyTimeoutMs = Math.floor(spec.bodyTimeoutMs);
  }
  if (
    typeof spec.headersTimeoutMs === "number" &&
    Number.isFinite(spec.headersTimeoutMs) &&
    spec.headersTimeoutMs > 0
  ) {
    out.headersTimeoutMs = Math.floor(spec.headersTimeoutMs);
  }
  if (
    typeof spec.connectTimeoutMs === "number" &&
    Number.isFinite(spec.connectTimeoutMs) &&
    spec.connectTimeoutMs > 0
  ) {
    out.connectTimeoutMs = Math.floor(spec.connectTimeoutMs);
  }
  if (
    out.bodyTimeoutMs === undefined &&
    out.headersTimeoutMs === undefined &&
    out.connectTimeoutMs === undefined
  ) {
    return undefined;
  }
  return out;
}

function withHttp1OnlyDispatcherOptions<T extends object | undefined>(
  options?: T,
  timeout?: number | DispatcherTimeoutSpec,
  applyTo?: { connect?: boolean; proxyTls?: boolean },
): (T extends object ? T : Record<never, never>) & { allowH2: false } {
  const base = {} as (T extends object ? T : Record<never, never>) & { allowH2: false };
  if (options) {
    Object.assign(base, options);
  }
  // Enforce HTTP/1.1-only — must come after options to prevent accidental override
  Object.assign(base, HTTP1_ONLY_DISPATCHER_OPTIONS);
  const baseRecord = base as Record<string, unknown>;
  const targets = applyTo ?? { connect: true };
  const autoSelectConnect = resolveUndiciAutoSelectFamilyConnectOptions();
  if (autoSelectConnect && targets.connect && typeof baseRecord.connect !== "function") {
    const connect = isObjectRecord(baseRecord.connect) ? baseRecord.connect : {};
    applyMissingConnectOptions(connect, autoSelectConnect);
    baseRecord.connect = connect;
  }
  if (autoSelectConnect && targets.proxyTls) {
    const proxyTls = isObjectRecord(baseRecord.proxyTls) ? baseRecord.proxyTls : {};
    applyMissingConnectOptions(proxyTls, autoSelectConnect);
    baseRecord.proxyTls = proxyTls;
  }
  const normalized = normalizeDispatcherTimeoutSpec(timeout);
  if (normalized) {
    if (normalized.bodyTimeoutMs !== undefined) {
      baseRecord.bodyTimeout = normalized.bodyTimeoutMs;
    }
    if (normalized.headersTimeoutMs !== undefined) {
      baseRecord.headersTimeout = normalized.headersTimeoutMs;
    }
    const connectTimeoutMs = normalized.connectTimeoutMs;
    if (connectTimeoutMs !== undefined) {
      if (targets.connect && typeof baseRecord.connect !== "function") {
        baseRecord.connect = {
          ...(isObjectRecord(baseRecord.connect) ? baseRecord.connect : {}),
          timeout: connectTimeoutMs,
        };
      }
      if (targets.proxyTls) {
        baseRecord.proxyTls = {
          ...(isObjectRecord(baseRecord.proxyTls) ? baseRecord.proxyTls : {}),
          timeout: connectTimeoutMs,
        };
      }
    }
  }
  return base;
}

export function createHttp1Agent(
  options?: UndiciAgentOptions,
  timeout?: number | DispatcherTimeoutSpec,
): import("undici").Agent {
  const { Agent } = loadUndiciRuntimeDeps();
  return new Agent(withHttp1OnlyDispatcherOptions(options, timeout));
}

export function createHttp1EnvHttpProxyAgent(
  options?: UndiciEnvHttpProxyAgentOptions,
  timeout?: number | DispatcherTimeoutSpec,
): import("undici").EnvHttpProxyAgent {
  const { EnvHttpProxyAgent } = loadUndiciRuntimeDeps();
  return new EnvHttpProxyAgent(
    withHttp1OnlyDispatcherOptions(options, timeout, {
      connect: true,
      proxyTls: true,
    }),
  );
}

export function createHttp1ProxyAgent(
  options: UndiciProxyAgentOptions,
  timeout?: number | DispatcherTimeoutSpec,
): import("undici").ProxyAgent {
  const { ProxyAgent } = loadUndiciRuntimeDeps();
  const normalized =
    typeof options === "string" || options instanceof URL
      ? { uri: options.toString() }
      : { ...options };
  return new ProxyAgent(
    withHttp1OnlyDispatcherOptions(normalized as object, timeout, {
      proxyTls: true,
    }) as UndiciProxyAgentOptions,
  );
}
