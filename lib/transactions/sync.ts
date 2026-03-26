import type { DatabaseConnection } from '../db/database'
import {
  applyAuthoritativeCashSnapshot,
  getLocalCashSession,
  getLocalCashSessionDashboard,
  recordLocalCashConflict,
} from '../db/repositories/agent-cash'
import { listQueueEntriesForSync, updateQueueEntryStatus } from '../db/repositories/queue'
import {
  createSyncRun,
  recordSyncConflict,
  updateSyncRun,
  upsertSyncCheckpoint,
} from '../db/repositories/sync-metadata'
import { updateLocalTransactionStatus } from '../db/repositories/transactions'
import type { QueueEntryRecord } from '../types/offline'
import {
  createMobileTransactionSyncTransport,
  TransactionSyncRequestError,
  TransactionSyncTransportError,
  type AgentCashRequest,
  type AgentCashSuccessEnvelope,
  type MobileTransactionSyncTransport,
  type TransactionIngestRequest,
  type TransactionIngestResult,
} from './client'

const CASH_SYNC_SCOPE = 'agent-cash'
const SYNCABLE_OPERATION_TYPES = ['transaction.create', 'agent.cash.reconcile.submit']

export type TransactionSyncSummary = {
  processed: number
  synced: number
  failed: number
  conflicts: number
  replayed: number
}

export type RunTransactionSyncInput = {
  transport?: MobileTransactionSyncTransport
  now?: () => string
}

type QueueOrderingContext = {
  entry: QueueEntryRecord
  actorId: string
  branchId: string
  businessDate: string | null
  queueKind: 'transaction' | 'reconciliation'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toCashSessionVersionToken(sessionId: string, version: number) {
  return `cash-session:${sessionId}:v${version}`
}

function toCollectionsMinor(envelope: AgentCashSuccessEnvelope) {
  return (
    envelope.data.totals.depositsMinor +
    envelope.data.totals.loanRepaymentsMinor +
    envelope.data.totals.cashAdjustmentsInMinor
  )
}

function toWithdrawalsMinor(envelope: AgentCashSuccessEnvelope) {
  return (
    envelope.data.totals.withdrawalsMinor +
    envelope.data.totals.loanDisbursementsMinor +
    envelope.data.totals.cashAdjustmentsOutMinor
  )
}

function getQueueBusinessDateFromTransaction(entry: QueueEntryRecord) {
  const candidates = [entry.payload.capturedAt, entry.payload.occurredAt, entry.payload.clientRecordedAt]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length >= 10) {
      return candidate.slice(0, 10)
    }
  }

  return null
}

function getTransactionConflictType(code: string) {
  return `transaction_queue_${code.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()}`
}

function getReconciliationConflictType(code: string) {
  return `agent_cash_queue_${code.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()}`
}

function toLocalCashConflictType(code: string):
  | 'no_open_session'
  | 'cash_limit_breach'
  | 'insufficient_cash_on_hand'
  | 'stale_session_version'
  | 'reconciliation_mismatch' {
  if (code === 'no_open_session') {
    return 'no_open_session'
  }

  if (code === 'cash_limit_breach') {
    return 'cash_limit_breach'
  }

  if (code === 'insufficient_cash_on_hand') {
    return 'insufficient_cash_on_hand'
  }

  if (code === 'stale_session_version') {
    return 'stale_session_version'
  }

  return 'reconciliation_mismatch'
}

async function resolveQueueOrderingContext(
  database: DatabaseConnection,
  entry: QueueEntryRecord
): Promise<QueueOrderingContext> {
  if (entry.operationType === 'transaction.create') {
    return {
      entry,
      actorId: entry.actorId,
      branchId: entry.branchId,
      businessDate: getQueueBusinessDateFromTransaction(entry),
      queueKind: 'transaction',
    }
  }

  const sessionId = typeof entry.payload.sessionId === 'string' ? entry.payload.sessionId : null
  const session = sessionId ? await getLocalCashSession(database, { sessionId }) : null

  return {
    entry,
    actorId: entry.actorId,
    branchId: entry.branchId,
    businessDate: session?.businessDate ?? null,
    queueKind: 'reconciliation',
  }
}

async function sortQueueEntriesForCashSync(database: DatabaseConnection, entries: QueueEntryRecord[]) {
  const contexts = await Promise.all(entries.map((entry) => resolveQueueOrderingContext(database, entry)))

  contexts.sort((left, right) => {
    const sameBusinessDay =
      left.actorId === right.actorId &&
      left.branchId === right.branchId &&
      left.businessDate !== null &&
      left.businessDate === right.businessDate

    if (sameBusinessDay && left.queueKind !== right.queueKind) {
      return left.queueKind === 'transaction' ? -1 : 1
    }

    const createdAtComparison = left.entry.createdAt.localeCompare(right.entry.createdAt)
    if (createdAtComparison !== 0) {
      return createdAtComparison
    }

    if (left.queueKind !== right.queueKind) {
      return left.queueKind === 'transaction' ? -1 : 1
    }

    return left.entry.operationId.localeCompare(right.entry.operationId)
  })

  return contexts.map((context) => context.entry)
}

async function resolveLocalCashSessionForTransaction(
  database: DatabaseConnection,
  entry: QueueEntryRecord
) {
  const businessDate = getQueueBusinessDateFromTransaction(entry)
  if (!businessDate) {
    return null
  }

  return getLocalCashSession(database, {
    actorId: entry.actorId,
    branchId: entry.branchId,
    businessDate,
  })
}

async function resolveLocalCashSessionForReconciliation(
  database: DatabaseConnection,
  entry: QueueEntryRecord
) {
  const sessionId = typeof entry.payload.sessionId === 'string' ? entry.payload.sessionId : null
  return sessionId ? getLocalCashSession(database, { sessionId }) : null
}

async function applyAuthoritativeEnvelope(
  database: DatabaseConnection,
  localSessionId: string | null,
  actorId: string,
  branchId: string,
  envelope: AgentCashSuccessEnvelope,
  observedAt: string
) {
  return applyAuthoritativeCashSnapshot(database, {
    localSessionId,
    actorId,
    branchId,
    businessDate: envelope.data.businessDate,
    businessTimezone: envelope.data.policy.businessTimezone,
    serverSessionId: envelope.data.sessionId,
    openingFloatMinor: envelope.data.totals.openingFloatMinor,
    maxSessionCarryMinor: envelope.data.policy.maxSessionCarryMinor,
    minimumReserveMinor: envelope.data.policy.minimumReserveMinor,
    authoritativeExpectedClosingCashMinor: envelope.data.totals.expectedClosingCashMinor,
    authoritativeCollectionsMinor: toCollectionsMinor(envelope),
    authoritativeWithdrawalsMinor: toWithdrawalsMinor(envelope),
    lastKnownServerVersion: envelope.data.serverVersion,
    observedAt,
  })
}

async function recordAuthoritativeDivergenceIfNeeded(
  database: DatabaseConnection,
  sessionId: string,
  queueEntry: QueueEntryRecord,
  envelope: AgentCashSuccessEnvelope,
  createdAt: string,
  reason: 'authoritative_divergence' | 'declared_mismatch'
) {
  const dashboard = await getLocalCashSessionDashboard(database, { sessionId })
  if (!dashboard) {
    return 0
  }

  const explicitMismatch = envelope.data.reconciliation?.mismatchMinor ?? 0
  const authoritativeDelta = dashboard.summary.authoritativeDeltaMinor ?? 0

  if (explicitMismatch === 0 && authoritativeDelta === 0) {
    return 0
  }

  await recordLocalCashConflict(database, {
    sessionId,
    queueOperationId: queueEntry.operationId,
    conflictType: 'reconciliation_mismatch',
    serverPayload: {
      action: envelope.action,
      reason,
      serverVersion: envelope.data.serverVersion,
      expectedClosingCashMinor: envelope.data.totals.expectedClosingCashMinor,
      declaredCashMinor: envelope.data.totals.declaredCashMinor ?? null,
      mismatchMinor: explicitMismatch,
    },
    localPayload: {
      projectedCashOnHandMinor: dashboard.summary.projectedCashOnHandMinor,
      authoritativeDeltaMinor: dashboard.summary.authoritativeDeltaMinor,
      queuePayload: queueEntry.payload,
    },
    createdAt,
  })

  return 1
}

async function tryRefreshCurrentState(
  database: DatabaseConnection,
  transport: MobileTransactionSyncTransport,
  entry: QueueEntryRecord,
  localSessionId: string | null,
  timestamp: string
) {
  try {
    const envelope = await transport.invokeAgentCash({
      action: 'agent.cash.current_state',
      input: {
        branchId: entry.branchId,
      },
    })

    const session = await applyAuthoritativeEnvelope(
      database,
      localSessionId,
      entry.actorId,
      entry.branchId,
      envelope,
      timestamp
    )

    return {
      envelope,
      session,
    }
  } catch (error) {
    if (error instanceof TransactionSyncRequestError || error instanceof TransactionSyncTransportError) {
      return {
        envelope: null,
        session: null,
      }
    }

    throw error
  }
}

async function recordQueueConflict(
  database: DatabaseConnection,
  entry: QueueEntryRecord,
  localSessionId: string | null,
  error: TransactionSyncRequestError,
  timestamp: string
) {
  if (localSessionId) {
    await recordLocalCashConflict(database, {
      sessionId: localSessionId,
      queueOperationId: entry.operationId,
      conflictType: toLocalCashConflictType(error.code),
      serverPayload: {
        code: error.code,
        message: error.message,
        details: error.details ?? null,
        action: error.action,
        operationId: error.operationId,
      },
      localPayload: entry.payload,
      createdAt: timestamp,
    })
  }

  await recordSyncConflict(database, {
    queueEntryId: entry.operationId,
    localTransactionId: entry.localTransactionId,
    conflictType:
      entry.operationType === 'transaction.create'
        ? getTransactionConflictType(error.code)
        : getReconciliationConflictType(error.code),
    serverPayload: {
      code: error.code,
      message: error.message,
      details: error.details ?? null,
      action: error.action,
      operationId: error.operationId,
    },
    localPayload: entry.payload,
    createdAt: timestamp,
    resolvedAt: null,
  })

  await updateQueueEntryStatus(database, entry.operationId, 'conflict', timestamp, entry.attemptCount + 1)
}

function buildTransactionIngestRequest(entry: QueueEntryRecord): TransactionIngestRequest {
  return {
    action: 'ingest_transaction',
    input: {
      queue: {
        id: entry.id,
        operationId: entry.operationId,
        operationType: entry.operationType,
        localTransactionId: entry.localTransactionId,
        actorId: entry.actorId,
        branchId: entry.branchId,
        deviceInstallationId: entry.deviceInstallationId,
        lastKnownServerVersion: entry.lastKnownServerVersion,
        payload: entry.payload,
      },
    },
  }
}

function buildReconciliationSubmitRequest(
  entry: QueueEntryRecord,
  localSession: NonNullable<Awaited<ReturnType<typeof resolveLocalCashSessionForReconciliation>>>,
  submittedAt: string
): AgentCashRequest {
  return {
    action: 'agent.cash.reconcile.submit',
    input: {
      operationId: entry.operationId,
      sessionId: localSession.serverSessionId ?? undefined,
      declaredCashMinor:
        typeof entry.payload.declaredCashMinor === 'number'
          ? entry.payload.declaredCashMinor
          : 0,
      submittedAt,
      notes: typeof entry.payload.notes === 'string' ? entry.payload.notes : undefined,
      counts: isRecord(entry.payload.counts) ? entry.payload.counts : undefined,
      lastKnownServerVersion: localSession.lastKnownServerVersion,
    },
  }
}

async function syncTransactionEntry(
  database: DatabaseConnection,
  entry: QueueEntryRecord,
  transport: MobileTransactionSyncTransport,
  timestamp: string
) {
  const localSession = await resolveLocalCashSessionForTransaction(database, entry)
  const result = await transport.invokeTransactionIngest(buildTransactionIngestRequest(entry))

  await updateLocalTransactionStatus(database, entry.localTransactionId, 'synced_pending', timestamp)

  let preservedConflicts = 0
  let lastServerVersion: string | null = null

  const currentState = await tryRefreshCurrentState(database, transport, entry, localSession?.id ?? null, timestamp)
  if (currentState.envelope) {
    lastServerVersion = currentState.envelope.data.serverVersion

    if (currentState.session) {
      preservedConflicts += await recordAuthoritativeDivergenceIfNeeded(
        database,
        currentState.session.id,
        entry,
        currentState.envelope,
        timestamp,
        'authoritative_divergence'
      )
    }
  } else if (localSession && isRecord(result.transaction.metadata.agentCash)) {
    const agentCash = result.transaction.metadata.agentCash
    if (typeof agentCash.sessionId === 'string' && typeof agentCash.projectedCashMinor === 'number') {
      const sessionVersion = typeof agentCash.sessionVersion === 'number'
        ? toCashSessionVersionToken(agentCash.sessionId, agentCash.sessionVersion)
        : localSession.lastKnownServerVersion

      await applyAuthoritativeCashSnapshot(database, {
        localSessionId: localSession.id,
        actorId: localSession.actorId,
        branchId: localSession.branchId,
        businessDate: localSession.businessDate,
        businessTimezone:
          typeof agentCash.businessTimezone === 'string' ? agentCash.businessTimezone : localSession.businessTimezone,
        serverSessionId: agentCash.sessionId,
        openingFloatMinor: localSession.openingFloatMinor,
        maxSessionCarryMinor:
          typeof agentCash.maxSessionCarryMinor === 'number' || agentCash.maxSessionCarryMinor === null
            ? (agentCash.maxSessionCarryMinor as number | null)
            : localSession.maxSessionCarryMinor,
        minimumReserveMinor:
          typeof agentCash.minimumReserveMinor === 'number'
            ? agentCash.minimumReserveMinor
            : localSession.minimumReserveMinor,
        authoritativeExpectedClosingCashMinor: agentCash.projectedCashMinor,
        authoritativeCollectionsMinor: localSession.authoritativeCollectionsMinor ?? 0,
        authoritativeWithdrawalsMinor: localSession.authoritativeWithdrawalsMinor ?? 0,
        lastKnownServerVersion: sessionVersion,
        observedAt: timestamp,
      })

      lastServerVersion = sessionVersion
    }
  }

  await updateQueueEntryStatus(database, entry.operationId, 'synced', timestamp, entry.attemptCount + 1)

  if (lastServerVersion) {
    await upsertSyncCheckpoint(database, {
      scope: CASH_SYNC_SCOPE,
      lastPulledAt: timestamp,
      serverCursor: localSession?.serverSessionId ?? null,
      lastKnownServerVersion: lastServerVersion,
    })
  }

  return {
    replayed: result.status === 'duplicate',
    preservedConflicts,
    lastServerVersion,
  }
}

async function syncReconciliationEntry(
  database: DatabaseConnection,
  entry: QueueEntryRecord,
  transport: MobileTransactionSyncTransport,
  timestamp: string
) {
  const localSession = await resolveLocalCashSessionForReconciliation(database, entry)
  if (!localSession) {
    throw new TransactionSyncRequestError(
      'no_open_session',
      'Open a local cash session before reconciliation sync can run',
      false,
      undefined,
      'agent.cash.reconcile.submit',
      entry.operationId
    )
  }

  let preservedConflicts = 0
  let envelope: AgentCashSuccessEnvelope | null = null

  try {
    envelope = await transport.invokeAgentCash(buildReconciliationSubmitRequest(entry, localSession, timestamp))
  } catch (error) {
    if (error instanceof TransactionSyncRequestError && error.code === 'stale_session_version') {
      preservedConflicts += 1
      await recordLocalCashConflict(database, {
        sessionId: localSession.id,
        queueOperationId: entry.operationId,
        conflictType: 'stale_session_version',
        serverPayload: {
          code: error.code,
          message: error.message,
          details: error.details ?? null,
        },
        localPayload: entry.payload,
        createdAt: timestamp,
      })

      const refreshed = await tryRefreshCurrentState(database, transport, entry, localSession.id, timestamp)
      if (refreshed.session) {
        envelope = await transport.invokeAgentCash(
          buildReconciliationSubmitRequest(entry, refreshed.session, timestamp)
        )
      } else {
        throw error
      }
    } else {
      throw error
    }
  }

  if (!envelope) {
    throw new TransactionSyncTransportError(
      'missing_agent_cash_reconciliation_response',
      'Agent cash reconciliation did not return an authoritative response',
      false
    )
  }

  const updatedSession = await applyAuthoritativeEnvelope(
    database,
    localSession.id,
    localSession.actorId,
    localSession.branchId,
    envelope,
    timestamp
  )

  if (updatedSession) {
    const conflictReason = (envelope.data.reconciliation?.mismatchMinor ?? 0) !== 0
      ? 'declared_mismatch'
      : 'authoritative_divergence'

    preservedConflicts += await recordAuthoritativeDivergenceIfNeeded(
      database,
      updatedSession.id,
      entry,
      envelope,
      timestamp,
      conflictReason
    )
  }

  await updateQueueEntryStatus(database, entry.operationId, 'synced', timestamp, entry.attemptCount + 1)
  await upsertSyncCheckpoint(database, {
    scope: CASH_SYNC_SCOPE,
    lastPulledAt: timestamp,
    serverCursor: envelope.data.sessionId,
    lastKnownServerVersion: envelope.data.serverVersion,
  })

  return {
    replayed: envelope.replayed,
    preservedConflicts,
    lastServerVersion: envelope.data.serverVersion,
  }
}

export async function runTransactionSync(
  database: DatabaseConnection,
  input: RunTransactionSyncInput = {}
): Promise<TransactionSyncSummary> {
  const now = input.now ?? (() => new Date().toISOString())
  const transport = input.transport ?? createMobileTransactionSyncTransport()
  const pendingEntries = await listQueueEntriesForSync(database, [...SYNCABLE_OPERATION_TYPES])
  const queueEntries = await sortQueueEntriesForCashSync(database, pendingEntries)
  const summary: TransactionSyncSummary = {
    processed: 0,
    synced: 0,
    failed: 0,
    conflicts: 0,
    replayed: 0,
  }

  let lastServerVersion: string | null = null
  const syncRun = await createSyncRun(database, {
    status: 'started',
    startedAt: now(),
    completedAt: null,
    errorMessage: null,
    lastKnownServerVersion: null,
  })

  for (const entry of queueEntries) {
    const processingTimestamp = now()
    await updateQueueEntryStatus(
      database,
      entry.operationId,
      'processing',
      processingTimestamp,
      entry.attemptCount + 1
    )

    try {
      const outcome = entry.operationType === 'transaction.create'
        ? await syncTransactionEntry(database, entry, transport, processingTimestamp)
        : await syncReconciliationEntry(database, entry, transport, processingTimestamp)

      lastServerVersion = outcome.lastServerVersion ?? lastServerVersion
      summary.synced += 1
      summary.conflicts += outcome.preservedConflicts

      if (outcome.replayed) {
        summary.replayed += 1
      }
    } catch (error) {
      if (error instanceof TransactionSyncRequestError && !error.retryable) {
        const localSession = entry.operationType === 'transaction.create'
          ? await resolveLocalCashSessionForTransaction(database, entry)
          : await resolveLocalCashSessionForReconciliation(database, entry)

        if (error.code === 'no_open_session') {
          await tryRefreshCurrentState(database, transport, entry, localSession?.id ?? null, processingTimestamp)
        }

        await recordQueueConflict(database, entry, localSession?.id ?? null, error, processingTimestamp)
        summary.conflicts += 1
      } else {
        await updateQueueEntryStatus(database, entry.operationId, 'failed', processingTimestamp, entry.attemptCount + 1)
        summary.failed += 1
      }

      if (!(error instanceof TransactionSyncTransportError) && !(error instanceof TransactionSyncRequestError)) {
        await recordSyncConflict(database, {
          queueEntryId: entry.operationId,
          localTransactionId: entry.localTransactionId,
          conflictType: 'transaction_queue_unexpected_error',
          serverPayload: {
            message: error instanceof Error ? error.message : 'Unexpected transaction sync error',
          },
          localPayload: entry.payload,
          createdAt: processingTimestamp,
          resolvedAt: null,
        })
      }
    }

    summary.processed += 1
  }

  await updateSyncRun(database, syncRun.id, {
    status: 'completed',
    completedAt: now(),
    errorMessage: null,
    lastKnownServerVersion: lastServerVersion,
  })

  return summary
}