import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
  sanitizeForConsole,
} from "./pi-embedded-error-observation.js";
import { classifyFailoverReason, formatAssistantErrorText } from "./pi-embedded-helpers.js";
import { hasCommittedMessagingToolDeliveryEvidence } from "./pi-embedded-runner/delivery-evidence.js";
import { isIncompleteTerminalAssistantTurn } from "./pi-embedded-runner/run/incomplete-turn.js";
import { PREEMPTIVE_OVERFLOW_ERROR_TEXT } from "./pi-embedded-runner/run/preemptive-compaction.js";
import { PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE } from "./pi-embedded-runner/tool-result-context-guard.js";
import {
  consumePendingToolMediaReply,
  hasAssistantVisibleReply,
} from "./pi-embedded-subscribe.handlers.messages.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { isPromiseLike } from "./pi-embedded-subscribe.promise.js";
import { isAssistantMessage } from "./pi-embedded-utils.js";

/**
 * Synthetic context-overflow error messages produced by openclaw's own
 * preemptive guards (the tool-loop char guard in `tool-result-context-guard.ts`
 * and the pre-prompt token-budget precheck in `run/preemptive-compaction.ts`).
 *
 * When the last assistant turn ended with one of these as its `errorMessage`,
 * the embedded runner is about to run an overflow-recovery compaction + retry
 * (see `pi-embedded-runner/run.ts` overflow recovery branch around line 1538).
 * Compaction is neither success nor failure — it is a recoverable internal
 * pause. The requester (parent agent for subagent runs) must not be told the
 * subagent has "ended in error" mid-recovery, otherwise it may treat the
 * subagent as terminated and spawn a replacement before the retry completes.
 *
 * Local `emitAgentEvent` continues to fire for observability; only the
 * requester-facing `onAgentEvent` is suppressed.
 */
const SYNTHETIC_OVERFLOW_RECOVERY_ERROR_MESSAGES = new Set<string>([
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
]);

function isRecoverableOverflowSynthetic(errorMessage: string | undefined): boolean {
  if (typeof errorMessage !== "string" || errorMessage.length === 0) {
    return false;
  }
  return SYNTHETIC_OVERFLOW_RECOVERY_ERROR_MESSAGES.has(errorMessage);
}

export {
  handleCompactionEnd,
  handleCompactionStart,
} from "./pi-embedded-subscribe.handlers.compaction.js";

export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.log.debug(`embedded run agent start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt: Date.now(),
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "lifecycle",
    data: { phase: "start" },
  });
}

export function handleAgentEnd(ctx: EmbeddedPiSubscribeContext): void | Promise<void> {
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";
  let lifecycleErrorText: string | undefined;
  const hasAssistantVisibleText =
    Array.isArray(ctx.state.assistantTexts) &&
    ctx.state.assistantTexts.some((text) => hasAssistantVisibleReply({ text }));
  const hadDeterministicSideEffect =
    ctx.state.hadDeterministicSideEffect === true ||
    hasCommittedMessagingToolDeliveryEvidence(ctx.state) ||
    (ctx.state.successfulCronAdds ?? 0) > 0;
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText,
    lastAssistant: isAssistantMessage(lastAssistant) ? lastAssistant : null,
  });
  const replayInvalid =
    ctx.state.replayState.replayInvalid || incompleteTerminalAssistant ? true : undefined;
  // Tool-use terminal guard: when the last assistant message ended with a
  // tool-call stop reason, the turn is incomplete even when pre-tool text
  // exists — mark as abandoned so lifecycle consumers do not see a working
  // end state for an interrupted tool chain. (#76477)
  const derivedWorkingTerminalState = isError
    ? "blocked"
    : replayInvalid &&
        !hadDeterministicSideEffect &&
        (!hasAssistantVisibleText || incompleteTerminalAssistant)
      ? "abandoned"
      : ctx.state.livenessState;
  const livenessState =
    ctx.state.livenessState === "working" ? derivedWorkingTerminalState : ctx.state.livenessState;

  // A subagent run is one logical run made of multiple attempts: run.ts stitches
  // compaction-continuation, empty-response, reasoning-only, and tool-use
  // recovery retries together under a single runId, and pi-agent-core emits
  // `agent_end` once per attempt. An *intermediate* attempt that produced no
  // usable final answer (no visible assistant text or an interrupted tool-use
  // turn, no deterministic side effect, not an error, not a yield) must not be
  // reported to the requester as a terminal completion — the runner is about to
  // start another attempt. Flag those ends so requesters (the subagent registry)
  // can defer completion until the run truly settles. This is intentionally a
  // superset of run.ts's exact retry conditions: a false positive only delays a
  // genuinely-terminal empty run by the requester's grace window, never hangs it.
  const mayContinue =
    !isError &&
    ctx.state.yielded !== true &&
    !hadDeterministicSideEffect &&
    (!hasAssistantVisibleText || incompleteTerminalAssistant);

  if (isError && lastAssistant) {
    const friendlyError = formatAssistantErrorText(lastAssistant, {
      cfg: ctx.params.config,
      sessionKey: ctx.params.sessionKey,
      provider: lastAssistant.provider,
      model: lastAssistant.model,
    });
    const rawError = lastAssistant.errorMessage?.trim();
    const failoverReason = classifyFailoverReason(rawError ?? "", {
      provider: lastAssistant.provider,
    });
    const errorText = (friendlyError || lastAssistant.errorMessage || "LLM request failed.").trim();
    const observedError = buildApiErrorObservationFields(rawError, {
      provider: lastAssistant.provider,
    });
    const safeErrorText =
      buildTextObservationFields(errorText, {
        provider: lastAssistant.provider,
      }).textPreview ?? "LLM request failed.";
    lifecycleErrorText = safeErrorText;
    const safeRunId = sanitizeForConsole(ctx.params.runId) ?? "-";
    const safeModel = sanitizeForConsole(lastAssistant.model) ?? "unknown";
    const safeProvider = sanitizeForConsole(lastAssistant.provider) ?? "unknown";
    const safeRawErrorPreview = sanitizeForConsole(observedError.rawErrorPreview);
    const shouldSuppressRawErrorConsoleSuffix =
      observedError.providerRuntimeFailureKind === "auth_html_403" ||
      observedError.providerRuntimeFailureKind === "auth_scope" ||
      observedError.providerRuntimeFailureKind === "auth_refresh";
    const rawErrorConsoleSuffix =
      safeRawErrorPreview && !shouldSuppressRawErrorConsoleSuffix
        ? ` rawError=${safeRawErrorPreview}`
        : "";
    ctx.log.warn("embedded run agent end", {
      event: "embedded_run_agent_end",
      tags: ["error_handling", "lifecycle", "agent_end", "assistant_error"],
      runId: ctx.params.runId,
      isError: true,
      error: safeErrorText,
      failoverReason,
      model: lastAssistant.model,
      provider: lastAssistant.provider,
      ...observedError,
      consoleMessage: `embedded run agent end: runId=${safeRunId} isError=true model=${safeModel} provider=${safeProvider} error=${safeErrorText}${rawErrorConsoleSuffix}`,
    });
  } else {
    ctx.log.debug(`embedded run agent end: runId=${ctx.params.runId} isError=${isError}`);
  }

  const emitLifecycleTerminal = () => {
    const terminalMeta = {
      ...(ctx.state.terminalStopReason ? { stopReason: ctx.state.terminalStopReason } : {}),
      ...(ctx.state.yielded === true ? { yielded: true } : {}),
    };
    if (isError) {
      // Suppress the requester-facing terminal event when the failure shape is
      // a recoverable openclaw-internal overflow (either the tool-loop char
      // guard or the pre-prompt token-budget precheck). The embedded runner
      // is about to compact and retry; surfacing `phase: "error"` to the
      // requester now causes parent agents to misread the subagent as
      // terminated mid-recovery (see openclaw#73864 / RGS-RES-001 incident).
      // The flag `ctx.state.pendingOverflowRecovery` (true while compaction
      // is in flight) acts as a secondary gate for any subsequent agent_end
      // emitted during that window.
      const suppressRequesterTerminal =
        isRecoverableOverflowSynthetic(lastAssistant?.errorMessage) ||
        ctx.state.pendingOverflowRecovery === true;
      emitAgentEvent({
        runId: ctx.params.runId,
        stream: "lifecycle",
        data: {
          phase: "error",
          error: lifecycleErrorText ?? "LLM request failed.",
          ...terminalMeta,
          ...(livenessState ? { livenessState } : {}),
          ...(replayInvalid ? { replayInvalid } : {}),
          endedAt: Date.now(),
          ...(suppressRequesterTerminal ? { recoverableOverflow: true } : {}),
        },
      });
      if (!suppressRequesterTerminal) {
        void ctx.params.onAgentEvent?.({
          stream: "lifecycle",
          data: {
            phase: "error",
            error: lifecycleErrorText ?? "LLM request failed.",
            ...terminalMeta,
            ...(livenessState ? { livenessState } : {}),
            ...(replayInvalid ? { replayInvalid } : {}),
          },
        });
      } else {
        ctx.log.debug(
          `embedded run agent end: suppressing requester-facing phase=error for recoverable overflow runId=${ctx.params.runId}`,
        );
      }
      return;
    }
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        ...terminalMeta,
        ...(livenessState ? { livenessState } : {}),
        ...(replayInvalid ? { replayInvalid } : {}),
        ...(mayContinue ? { mayContinue: true } : {}),
        endedAt: Date.now(),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "end",
        ...terminalMeta,
        ...(livenessState ? { livenessState } : {}),
        ...(replayInvalid ? { replayInvalid } : {}),
        ...(mayContinue ? { mayContinue: true } : {}),
      },
    });
  };

  const finalizeAgentEnd = () => {
    ctx.state.blockState.thinking = false;
    ctx.state.blockState.final = false;
    ctx.state.blockState.inlineCode = createInlineCodeState();

    if (ctx.state.pendingCompactionRetry > 0) {
      ctx.resolveCompactionRetry();
    } else {
      ctx.maybeResolveCompactionWait();
    }
  };

  const flushPendingMediaAndChannel = () => {
    if (ctx.params.onBlockReply) {
      const pendingToolMediaReply = consumePendingToolMediaReply(ctx.state);
      if (pendingToolMediaReply && hasAssistantVisibleReply(pendingToolMediaReply)) {
        ctx.emitBlockReply(pendingToolMediaReply);
      }
    }

    const postMediaFlushResult = ctx.flushBlockReplyBuffer();
    if (isPromiseLike<void>(postMediaFlushResult)) {
      return postMediaFlushResult.then(() => {
        const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
        if (isPromiseLike<void>(onBlockReplyFlushResult)) {
          return onBlockReplyFlushResult;
        }
        return undefined;
      });
    }

    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult;
    }
    return undefined;
  };

  let lifecycleTerminalEmitted = false;
  const emitLifecycleTerminalOnce = (): void | Promise<void> => {
    if (lifecycleTerminalEmitted) {
      return;
    }
    lifecycleTerminalEmitted = true;
    let beforeLifecycleTerminal: void | Promise<void> = undefined;
    try {
      beforeLifecycleTerminal = ctx.params.onBeforeLifecycleTerminal?.();
    } catch (err) {
      ctx.log.debug(`before lifecycle terminal failed: ${String(err)}`);
    }
    if (isPromiseLike<void>(beforeLifecycleTerminal)) {
      return Promise.resolve(beforeLifecycleTerminal)
        .catch((err) => {
          ctx.log.debug(`before lifecycle terminal failed: ${String(err)}`);
        })
        .then(() => {
          emitLifecycleTerminal();
        });
    }
    emitLifecycleTerminal();
  };

  try {
    const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer();
    finalizeAgentEnd();
    const flushPendingMediaAndChannelResult = isPromiseLike<void>(flushBlockReplyBufferResult)
      ? Promise.resolve(flushBlockReplyBufferResult).then(() => flushPendingMediaAndChannel())
      : flushPendingMediaAndChannel();

    if (isPromiseLike<void>(flushPendingMediaAndChannelResult)) {
      return Promise.resolve(flushPendingMediaAndChannelResult).then(
        () => emitLifecycleTerminalOnce(),
        (error) => {
          const emitted = emitLifecycleTerminalOnce();
          if (isPromiseLike<void>(emitted)) {
            return Promise.resolve(emitted).then(() => {
              throw error;
            });
          }
          throw error;
        },
      );
    }
  } catch (error) {
    const emitted = emitLifecycleTerminalOnce();
    if (isPromiseLike<void>(emitted)) {
      return Promise.resolve(emitted).then(() => {
        throw error;
      });
    }
    throw error;
  }

  return emitLifecycleTerminalOnce();
}
