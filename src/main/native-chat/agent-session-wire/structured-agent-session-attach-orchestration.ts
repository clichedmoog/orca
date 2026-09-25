import { recoverStructuredRewind } from './structured-rewind-recovery'
import { recoverInterruptedCompaction } from './structured-compaction-recovery'
// The host's attach, lifted out of the host class.
//
// Attach is the one operation that touches every collaborator the host owns — the lease
// reconciler, the recovery resolver, the event sink, the journal, the subscriber set and the task
// queue — so leaving it inline made the host grow every time any of them did. The host keeps the
// state; this owns the ordering between them.

import { randomUUID } from 'node:crypto'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult,
  AgentSessionTurnActivity
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'
import { stampFailedCreateOwnerVerdict } from './structured-agent-session-failed-create-refusal'
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv
} from './structured-agent-session-launch-env'
import { refuseAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { retryPendingStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'
import { settleStaleSessionStateOnAcquire } from './structured-agent-session-stale-turn-verdict'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  addAgentSessionCreatePhaseAttributes,
  withAgentSessionCreatePhase,
  withAgentSessionSpan,
  type AgentSessionCreatePhaseRecorder
} from '../../observability/agent-session-instrumentation'

export type StructuredAgentSessionAttachOptions = {
  recordPhase?: AgentSessionCreatePhaseRecorder
}

/**
 * The attach itself, for a caller already inside the session's serialize.
 *
 * That is every caller that has to know what the session looks like RIGHT NOW: the delivery loop,
 * and an operation that needs the provider. They run their check and this attach in one serialized
 * step, so "the session has no child" is still true when
 * the attach starts. `attachStructuredAgentSession` is this under `serialize`, for a client.
 */
export function attachStructuredAgentSessionUnderSerialize(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionAttachOptions = {}
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  return context.tasks.trackAttach(runAttach(context, callerKey, params, options))
}

export function attachStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  // Tracked from enqueue, not from its turn on the queue: a quit drains a queued attach before it
  // evicts, so no child is spawned behind the eviction and orphaned.
  const run = (recordPhase?: AgentSessionCreatePhaseRecorder) =>
    context.tasks.trackAttach(
      context.serialize(sessionId, () => runAttach(context, callerKey, params, { recordPhase }))
    )
  if (params.envelope.expectedRuntimeFence !== null) {
    return run()
  }
  return withAgentSessionSpan(async (span) => {
    const startedAtMs = Date.now()
    const phases: Parameters<AgentSessionCreatePhaseRecorder>[0][] = []
    try {
      return await run((timing) => phases.push(timing))
    } finally {
      addAgentSessionCreatePhaseAttributes(span, {
        totalDurationMs: Math.max(0, Date.now() - startedAtMs),
        phases
      })
    }
  })
}

async function runAttach(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionAttachOptions
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  const recordPhase = options.recordPhase
  const unreconciled = await withAgentSessionCreatePhase('reconcile_leases', recordPhase, () =>
    context.reconcileLeases(sessionId)
  )
  if (unreconciled) {
    return refuseAgentSessionMutation(unreconciled)
  }
  await withAgentSessionCreatePhase('resolve_recovery', recordPhase, () =>
    context.runtimeState.resolveRecovery(sessionId)
  )
  // Retries a durable provider-exit journal settlement before a new owner is reserved. Answers
  // settled when the record has none pending, so every attach can ask unconditionally.
  const settled = await withAgentSessionCreatePhase('settlement_retry', recordPhase, () =>
    retryPendingStructuredAgentSessionSettlement({
      deps: context.deps,
      sessions: context.sessions,
      sessionId,
      params,
      now: () => context.now()
    })
  )
  if (!settled) {
    return refuseAgentSessionMutation({
      code: 'agent_session_ownership_unknown',
      message: 'The provider-exit terminal journal settlement is still pending; retry attach.'
    })
  }
  const probe = await withAgentSessionCreatePhase('probe_owner', recordPhase, () =>
    context.runtimeState.probeOwner(sessionId)
  )
  // A child this attach spawns writes through a sink this attempt owns. Only a successful
  // attach makes it the session's; any other exit closes it with whatever the child queued.
  const attemptSink = context.runtimeState.mintEventSink(sessionId)
  let attemptSinkAdopted = false
  let indexed: StructuredAgentSessionHostSession | null = null
  let attachedOk = false
  const attached = stampFailedCreateOwnerVerdict(
    context.deps.store,
    callerKey,
    params.envelope,
    await performAttach({
      store: context.deps.store,
      adapter: context.deps.adapter,
      journalRoot: context.deps.journalRoot,
      eventSink: attemptSink.sink,
      // The superseded child's writes settle into its own journal before a new child starts.
      onAcquiring: async () => {
        const barrier = await context.runtimeState.currentEventSink(sessionId)?.drained()
        if (barrier && !barrier.ok) {
          throw barrier.error
        }
      },
      authority: {
        spawnToken: () => context.deps.mintSpawnToken?.() ?? randomUUID(),
        claimKeyId: context.deps.claimKeyId,
        handoffOperationId: params.envelope.clientOperationId,
        probe,
        ...(await pinnedAgentSessionLaunchArgs(context.deps.resolveLaunchArgs, params)),
        ...(await pinnedAgentSessionLaunchEnv(context.deps.resolveLaunchEnv, params))
      },
      callerKey,
      params,
      now: () => context.now(),
      recordPhase,
      // A failed attach leaves the conversation open, with its queued messages, for the failure
      // to be written into; only the attempt's own sink is discarded, in the `finally` below.
      openConversation: async (id) => {
        const conversation = await context.openConversation(id)
        if (!conversation) {
          throw new Error('agent_session_identity_required')
        }
        return conversation.journal
      },
      onAttached: async (attached, acquisitionGeneration, acquiredOwner, providerChildPhase) => {
        const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
        const previous = context.sessions.get(sessionId)
        const previousFence = previous?.fence
        // A re-attach to a live child keeps the sink that child already writes through.
        const eventSink = acquiredOwner
          ? attemptSink
          : (context.runtimeState.currentEventSink(sessionId) ?? attemptSink)
        // The journal is the conversation's own open one, so a throw here leaves it indexed.
        if (acquiredOwner) {
          // Before the drain: the buffered events are the new child's, never a stale row's.
          await settleStaleSessionStateOnAcquire({
            journal: attached.journal,
            sessionId,
            fence,
            acquisitionGeneration
          })
        }
        await bindAndDrain(eventSink, attached.journal, fence, (activity) =>
          context.subscribers.publish(sessionId, attached.journal, activity)
        )
        context.runtimeState.adoptEventSink(sessionId, eventSink)
        attemptSinkAdopted = eventSink === attemptSink
        indexed = {
          journal: attached.journal,
          params,
          fence,
          hasProviderChild: true,
          // A re-attach to a live child keeps what that child already proved.
          providerChildPhase: acquiredOwner
            ? providerChildPhase
            : (previous?.providerChildPhase ?? 'ready'),
          acquisitionGeneration: acquisitionGeneration ?? previous?.acquisitionGeneration ?? null
        }
        context.sessions.set(sessionId, indexed)
        await recoverStructuredRewind(
          context.deps.store,
          sessionId,
          attached.journal,
          fence,
          context.deps.adapter,
          context.now
        )
        await recoverInterruptedCompaction(context.deps.store, sessionId, attached.journal, fence)
        if (previousFence !== undefined && previousFence !== fence) {
          context.subscribers.snapshot(sessionId, attached.journal)
        } else {
          context.subscribers.publish(sessionId, attached.journal)
        }
      }
    })
      .then((result) => {
        attachedOk = result.ok
        return result
      })
      .finally(() => {
        const releasedIndexedChild =
          !attachedOk && indexed !== null && context.sessions.get(sessionId) === indexed
        if (releasedIndexedChild && indexed) {
          // The failure path released the child this attempt indexed; the conversation stays.
          indexed.hasProviderChild = false
          indexed.providerChildPhase = 'ready'
          context.runtimeState.currentEventSink(sessionId)?.close()
          context.runtimeState.discardEventSink(sessionId)
          context.publishStatus?.(sessionId)
        }
        if (!attemptSinkAdopted || releasedIndexedChild) {
          attemptSink.close()
          followRecordFence(context, sessionId)
        }
      })
  )
  return attached
}

/** A failed attempt still moved the record's fence when it reserved; the conversation it leaves
 *  open writes its failure row and rejections at that fence, not the one it opened at. */
function followRecordFence(context: StructuredAgentSessionAttachContext, sessionId: string): void {
  const conversation = context.sessions.get(sessionId)
  const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence
  if (conversation && !conversation.hasProviderChild && fence !== undefined) {
    conversation.fence = Math.max(conversation.fence, fence)
  }
}

/** Binds the sink to the journal and waits for the barrier the host publishes
 *  behind. It throws by design when a sink barrier fails. */
async function bindAndDrain(
  eventSink: DeferredStructuredAgentSessionEventSink,
  journal: AgentSessionJournal,
  fence: number,
  publish: (activity?: AgentSessionTurnActivity | null) => void
): Promise<void> {
  eventSink.bind({ journal, fence, publish })
  const barrier = await eventSink.drained()
  if (!barrier.ok) {
    throw barrier.error
  }
}
