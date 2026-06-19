import {
  getActiveReplyRunCount,
  listActiveReplyRunSessionIds,
} from "../../auto-reply/reply/reply-run-registry.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

export type EmbeddedPiQueueHandle = {
  kind?: "embedded";
  queueMessage: (text: string, options?: EmbeddedPiQueueMessageOptions) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: () => void;
};

export type EmbeddedPiQueueMessageOptions = {
  steeringMode?: "all" | "one-at-a-time";
  debounceMs?: number;
};

export type ActiveEmbeddedRunSnapshot = {
  transcriptLeafId: string | null;
  messages?: unknown[];
  inFlightPrompt?: string;
};

export type EmbeddedRunModelSwitchRequest = {
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

export type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};

const EMBEDDED_RUN_STATE_KEY = Symbol.for("openclaw.embeddedRunState");

const embeddedRunState = resolveGlobalSingleton(EMBEDDED_RUN_STATE_KEY, () => ({
  activeRuns: new Map<string, EmbeddedPiQueueHandle>(),
  snapshots: new Map<string, ActiveEmbeddedRunSnapshot>(),
  sessionIdsByKey: new Map<string, string>(),
  waiters: new Map<string, Set<EmbeddedRunWaiter>>(),
  modelSwitchRequests: new Map<string, EmbeddedRunModelSwitchRequest>(),
  // Whole-run loop activity, keyed by sessionKey -> owning runId. Unlike
  // `activeRuns` (which is set/cleared per *attempt*), this stays set for the
  // entire `runEmbeddedPiAgent` loop so completion gates can tell a run is still
  // working across inter-attempt gaps (compaction / retry prep). sessionKey is
  // used (not sessionId) because compaction can rotate the sessionId mid-run.
  runLoops: new Map<string, string>(),
  runLoopWaiters: new Map<string, Set<EmbeddedRunWaiter>>(),
}));

export const ACTIVE_EMBEDDED_RUNS =
  embeddedRunState.activeRuns ??
  (embeddedRunState.activeRuns = new Map<string, EmbeddedPiQueueHandle>());
export const ACTIVE_EMBEDDED_RUN_SNAPSHOTS =
  embeddedRunState.snapshots ??
  (embeddedRunState.snapshots = new Map<string, ActiveEmbeddedRunSnapshot>());
export const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY =
  embeddedRunState.sessionIdsByKey ??
  (embeddedRunState.sessionIdsByKey = new Map<string, string>());
export const EMBEDDED_RUN_WAITERS =
  embeddedRunState.waiters ??
  (embeddedRunState.waiters = new Map<string, Set<EmbeddedRunWaiter>>());
export const EMBEDDED_RUN_MODEL_SWITCH_REQUESTS =
  embeddedRunState.modelSwitchRequests ??
  (embeddedRunState.modelSwitchRequests = new Map<string, EmbeddedRunModelSwitchRequest>());
export const ACTIVE_EMBEDDED_RUN_LOOPS =
  embeddedRunState.runLoops ?? (embeddedRunState.runLoops = new Map<string, string>());
export const EMBEDDED_RUN_LOOP_WAITERS =
  embeddedRunState.runLoopWaiters ??
  (embeddedRunState.runLoopWaiters = new Map<string, Set<EmbeddedRunWaiter>>());

export function getActiveEmbeddedRunCount(): number {
  let activeCount = ACTIVE_EMBEDDED_RUNS.size;
  for (const sessionId of listActiveReplyRunSessionIds()) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      activeCount += 1;
    }
  }
  return Math.max(activeCount, getActiveReplyRunCount());
}
