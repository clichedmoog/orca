// The host's half of a session's lifetime: stopping its agent, and closing its conversation.
//
// Two operations, because they end two different things. Stopping the agent ends the provider
// child and hands the lease back; the conversation — its open journal, its status row and its
// readers — stays, and the next send starts a new child. Closing the conversation drops the open
// journal handle, a cache the next read or write reopens.
//
// Both are written for a caller already inside the session's serialize: the queue is not
// reentrant, so every public entry point takes it once and calls these.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { DISPATCH_REJECTED_PROVIDER_CLOSED } from '../../../shared/structured-agent-session-dispatch-rejection'
import {
  evictStructuredAgentSession,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
import { withStructuredAgentSessionEvictionDeadline } from './structured-agent-session-eviction-deadline'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { releaseStoredStructuredAgentSessionOwner } from './structured-agent-session-lease-release'
import { settleStructuredAgentSessionDeadGeneration } from './structured-agent-session-dead-generation-settlement'

export type StructuredAgentSessionLifetimeContext = {
  deps: StructuredAgentSessionHostDeps
  runtimeState: StructuredAgentSessionHostRuntimeState
  sessions: Map<string, StructuredAgentSessionHostSession>
  now: () => number
  /** Re-projects the session's status: a stopped agent leaves its chat listed, idle. */
  publishStatus: (sessionId: string) => void
  /** Quit-only snapshot taken immediately before the provider child is stopped. */
  restartWitness?: {
    beforeStop: (sessionId: string) => void
    stopped: (sessionId: string) => void
  }
}

/** The wind-down this host owes for the session's child. A live child always owes one, whatever a
 *  previous childless stop recorded: a remembered `false` must never outrank the child in front
 *  of it. */
function owesProviderChildWindDown(session: StructuredAgentSessionHostSession): boolean {
  return session.hasProviderChild || session.owesProviderChildWindDown === true
}

/**
 * The agent goes to rest; the conversation stays. Runs the eviction steps under a deadline. A step
 * that fails — or runs out of time — aborts the rest and leaves the wind-down owed, so the next
 * stop is a real retry.
 */
export async function stopStructuredAgentSessionAgentUnderSerialize(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): Promise<void> {
  const session = context.sessions.get(sessionId)
  if (!session) {
    return
  }
  // The obligation OUTLIVES the child. `hasProviderChild` is retired the instant the adapter
  // proves the exit, so a step that aborts after that point would otherwise leave the retry
  // reading "no child here" and skipping the settlement and the lease release it still owes.
  const owesWindDown = owesProviderChildWindDown(session)
  session.owesProviderChildWindDown = owesWindDown
  let settlementError: unknown
  const eviction: StructuredAgentSessionEvictionContext = {
    sessionId,
    // The retry must not re-stop a child the adapter already proved gone, so this stays honest.
    hasProviderChild: session.hasProviderChild,
    owesProviderChildWindDown: owesWindDown,
    eventSink: context.runtimeState.eventSinkFor(sessionId),
    adapter: context.deps.adapter,
    ...(context.restartWitness
      ? { beforeProviderChildStop: () => context.restartWitness?.beforeStop(sessionId) }
      : {}),
    // Host state must not disagree with the adapter for the steps in between.
    onProviderChildStopped: () => {
      session.hasProviderChild = false
      context.restartWitness?.stopped(sessionId)
    },
    acknowledgeRelease: () => context.deps.adapter.acknowledgeSessionRelease?.(sessionId),
    discardSink: () => context.runtimeState.discardEventSink(sessionId),
    settleWork: async () => {
      const settled = await settleStructuredAgentSessionDeadGeneration({
        journal: session.journal,
        sessionId,
        fence: session.fence,
        settlementId: `expected-close:${sessionId}:${session.fence}:${session.acquisitionGeneration ?? 'unknown'}`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: context.now() },
        showUnexpectedExitOutcome: false,
        queuedRejection: DISPATCH_REJECTED_PROVIDER_CLOSED,
        onError: (id, error) => {
          settlementError = error
          context.deps.onEventSinkError?.({ sessionId: id, error })
        }
      })
      if (!settled) {
        // Without the cause the log names the step and nothing else.
        throw new Error('dead generation work settlement failed', { cause: settlementError })
      }
    },
    releaseLease: async () => {
      await releaseStoredStructuredAgentSessionOwner({
        store: context.deps.store,
        sessionId,
        hasProviderChild: owesWindDown,
        expectedFence: session.fence,
        now: context.now()
      })
      session.owesProviderChildWindDown = false
      // The conversation stays open, so it writes at whatever fence the release left.
      session.fence = Math.max(
        session.fence,
        context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? session.fence
      )
      context.publishStatus(sessionId)
    }
  }
  await evictStructuredAgentSession(
    eviction,
    withStructuredAgentSessionEvictionDeadline(STRUCTURED_AGENT_SESSION_EVICTION_STEPS)
  )
}

/** Whether the conversation's handle is only a cache now: no child, no wind-down owed, and nothing
 *  queued or waiting on the provider. */
export function structuredAgentSessionConversationClosable(
  session: StructuredAgentSessionHostSession
): boolean {
  const submissions = session.journal.submissions()
  return (
    !owesProviderChildWindDown(session) &&
    !submissions.some(isQueuedAgentJournalSubmission) &&
    session.journal.pendingSubmissions().length === 0
  )
}

/**
 * Drops the conversation's open handle. The entry leaves the map BEFORE the handle closes, so a
 * lock-free reader sees an open handle or none — never one that is closing — and one arriving
 * after the delete waits behind this step and reopens. Answers false, closing nothing, when the
 * handle is still more than a cache.
 */
export async function closeStructuredAgentSessionConversationUnderSerialize(
  context: Pick<StructuredAgentSessionLifetimeContext, 'sessions'> & {
    /** The status row outlives the handle; see `StructuredAgentSessionClientDelivery`. */
    closeStatus: (sessionId: string) => void
  },
  sessionId: string
): Promise<boolean> {
  const session = context.sessions.get(sessionId)
  if (!session || !structuredAgentSessionConversationClosable(session)) {
    return false
  }
  context.sessions.delete(sessionId)
  context.closeStatus(sessionId)
  await session.journal.close()
  return true
}

/** Stops every provider child owned by this host while keeping failed stops reachable. A session
 *  whose child is already stopped but whose wind-down aborted is still in scope — that is the
 *  retry. */
export async function evictOwnedStructuredAgentSessions(
  context: StructuredAgentSessionLifetimeContext & {
    serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
  },
  retainOnFailure: Set<string>
): Promise<void> {
  const ownedSessionIds = [...context.sessions]
    .filter(([, session]) => owesProviderChildWindDown(session))
    .map(([sessionId]) => sessionId)
  // Retained up front and cleared only once a stop settles: the quit phase is bounded, and a
  // timeout leaves these still running. Closing their journals underneath them is the one outcome
  // the retain set exists to prevent.
  for (const sessionId of ownedSessionIds) {
    retainOnFailure.add(sessionId)
  }
  const failures: unknown[] = []
  await Promise.all(
    ownedSessionIds.map(async (sessionId) => {
      try {
        await context.serialize(sessionId, () =>
          stopStructuredAgentSessionAgentUnderSerialize(context, sessionId)
        )
        retainOnFailure.delete(sessionId)
      } catch (error) {
        failures.push(error)
      }
    })
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'structured agent-session child eviction failed')
  }
}
