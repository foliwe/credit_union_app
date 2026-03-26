import {
  getCachedLoanByClientId,
  getLoanRepaymentOutcomeByRepaymentId,
  getLoanScheduleSnapshotById,
  markCachedLoanStale,
  reconcileCachedLoan,
  reconcileLoanRepaymentOutcome,
  type CachedLoanRepaymentOutcomeRecord,
} from '../db/repositories/loans'
import { listQueueEntriesForSync, updateQueueEntryStatus } from '../db/repositories/queue'
import {
  createSyncRun,
  recordSyncConflict,
  updateSyncRun,
  upsertSyncCheckpoint,
} from '../db/repositories/sync-metadata'
import { updateLocalTransactionStatus } from '../db/repositories/transactions'
import type { DatabaseConnection } from '../db/database'
import type { LoanScheduleProjection, LoanCreateQueuePayload } from './mobile-loans'
import type { LoanInstallmentSnapshot, LoanRepaymentPayload, QueueEntryRecord } from '../types/offline'
import {
  createLoanOrchestrationTransport,
  LoanOrchestrationRequestError,
  LoanOrchestrationTransportError,
  type LoanOrchestrationRequest,
  type LoanOrchestrationSuccessEnvelope,
  type LoanOrchestrationTransport,
  type LoanScheduleState,
} from './client'

const LOAN_SYNC_SCOPE = 'loans'
const SYNCABLE_LOAN_OPERATION_TYPES = ['loan.create', 'loan.repayment']

export type LoanSyncSummary = {
  processed: number
  synced: number
  failed: number
  conflicts: number
  replayed: number
}

export type RunLoanSyncInput = {
  transport?: LoanOrchestrationTransport
  now?: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isLoanCreatePayload(value: unknown): value is LoanCreateQueuePayload {
  return (
    isRecord(value) &&
    typeof value.loanId === 'string' &&
    typeof value.memberId === 'string' &&
    typeof value.submittedAt === 'string' &&
    isRecord(value.currentSchedule) &&
    Array.isArray(value.currentSchedule.installments)
  )
}

function isLoanRepaymentPayload(value: unknown): value is LoanRepaymentPayload {
  return (
    isRecord(value) &&
    typeof value.loanId === 'string' &&
    typeof value.repaymentId === 'string' &&
    typeof value.amountMinor === 'number' &&
    typeof value.currencyCode === 'string' &&
    typeof value.effectiveAt === 'string' &&
    typeof value.capturedAt === 'string' &&
    Array.isArray(value.installments)
  )
}

function toScheduleProjection(installments: LoanInstallmentSnapshot[]): LoanScheduleProjection[] {
  return installments.map((installment) => ({
    installmentNumber: installment.installmentNumber,
    dueDate: installment.dueDate,
    outstandingInterestMinor: installment.outstandingInterestMinor,
    outstandingPrincipalMinor: installment.outstandingPrincipalMinor,
    scheduledInterestMinor: installment.outstandingInterestMinor,
    scheduledPrincipalMinor: installment.outstandingPrincipalMinor,
    totalDueMinor: installment.outstandingInterestMinor + installment.outstandingPrincipalMinor,
  }))
}

function getLoanCreatePayload(entry: QueueEntryRecord): LoanCreateQueuePayload {
  if (!isLoanCreatePayload(entry.payload)) {
    throw new LoanOrchestrationTransportError(
      'invalid_local_loan_create_payload',
      `Queue entry ${entry.operationId} does not contain a valid loan.create payload`,
      false
    )
  }

  return entry.payload
}

function getLoanRepaymentPayload(entry: QueueEntryRecord): {
  repayment: LoanRepaymentPayload
  memberId: string
  note?: string
} {
  const envelopePayload = isRecord(entry.payload.payload) ? entry.payload.payload : entry.payload
  if (!isLoanRepaymentPayload(envelopePayload)) {
    throw new LoanOrchestrationTransportError(
      'invalid_local_loan_repayment_payload',
      `Queue entry ${entry.operationId} does not contain a valid loan.repayment payload`,
      false
    )
  }

  const memberId = typeof entry.payload.memberId === 'string' ? entry.payload.memberId : null
  if (!memberId) {
    throw new LoanOrchestrationTransportError(
      'invalid_local_loan_repayment_payload',
      `Queue entry ${entry.operationId} is missing memberId for repayment sync`,
      false
    )
  }

  const noteCandidate = isRecord(entry.payload.payload)
    ? entry.payload.payload.note
    : entry.payload.note
  const note = typeof noteCandidate === 'string' && noteCandidate.trim().length > 0
    ? noteCandidate.trim()
    : undefined

  return {
    repayment: envelopePayload,
    memberId,
    note,
  }
}

function getConflictType(code: string) {
  return `loan_queue_${code.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()}`
}

function buildScheduleProjection(schedule: LoanScheduleState | null): LoanScheduleProjection[] | null {
  if (!schedule) {
    return null
  }

  return toScheduleProjection(schedule.installments)
}

async function buildCreateRequest(entry: QueueEntryRecord): Promise<LoanOrchestrationRequest> {
  const payload = getLoanCreatePayload(entry)

  return {
    action: 'loan.create',
    input: {
      operationId: entry.operationId,
      branchId: entry.branchId,
      clientLoanId: payload.loanId,
      memberId: payload.memberId,
      submittedAt: payload.submittedAt,
      firstDueDate: payload.firstDueDate,
      product: {
        productCode: payload.productCode,
        productName: payload.productName,
        currencyCode: payload.currencyCode,
        principalMinor: payload.principalMinor,
        termMonths: payload.termMonths,
        monthlyInterestRateBps: payload.monthlyInterestRateBps,
        repaymentDayOfMonth: payload.repaymentDayOfMonth,
        interestStrategy: payload.interestStrategy,
        repaymentAllocationStrategy: payload.repaymentAllocationStrategy,
      },
      metadata: payload.metadata,
    },
  }
}

async function syncLoanCreateEntry(
  database: DatabaseConnection,
  entry: QueueEntryRecord,
  transport: LoanOrchestrationTransport,
  timestamp: string
): Promise<LoanOrchestrationSuccessEnvelope> {
  const payload = getLoanCreatePayload(entry)
  const request = await buildCreateRequest(entry)
  const response = await transport.invoke(request)
  const schedule = buildScheduleProjection(response.data.schedule) ?? payload.currentSchedule.installments

  if (!response.data.serverLoanId) {
    throw new LoanOrchestrationTransportError(
      'missing_server_loan_id',
      'Loan orchestration did not return an authoritative loan identifier',
      false
    )
  }

  await reconcileCachedLoan(database, {
    clientLoanId: payload.loanId,
    serverLoanId: response.data.serverLoanId,
    serverVersion: response.data.serverVersion,
    reconciledAt: timestamp,
    status: response.data.status,
    outstandingPrincipalMinor: response.data.totals.outstandingPrincipalMinor,
    accruedInterestMinor: response.data.totals.accruedInterestMinor,
    totalRepaidMinor: response.data.totals.totalRepaidMinor,
    schedule,
    payload: {
      ...payload,
      authoritativeOutcome: response.data,
    },
  })

  return response
}

async function resolveRepaymentAuthoritativeSchedule(
  database: DatabaseConnection,
  outcome: CachedLoanRepaymentOutcomeRecord,
  response: LoanOrchestrationSuccessEnvelope
): Promise<LoanScheduleProjection[]> {
  const fromResponse = buildScheduleProjection(response.data.schedule)
  if (fromResponse) {
    return fromResponse
  }

  if (outcome.sourceScheduleSnapshotId) {
    const sourceSnapshot = await getLoanScheduleSnapshotById(database, outcome.sourceScheduleSnapshotId)
    if (sourceSnapshot) {
      return sourceSnapshot.schedule
    }
  }

  return outcome.resultingInstallments
}

async function syncLoanRepaymentEntry(
  database: DatabaseConnection,
  entry: QueueEntryRecord,
  transport: LoanOrchestrationTransport,
  timestamp: string
): Promise<LoanOrchestrationSuccessEnvelope> {
  const { repayment, memberId, note } = getLoanRepaymentPayload(entry)
  const loan = await getCachedLoanByClientId(database, repayment.loanId)
  if (!loan) {
    throw new LoanOrchestrationTransportError(
      'unknown_cached_loan',
      `Loan ${repayment.loanId} does not exist in the local cache`,
      false
    )
  }

  if (!loan.serverLoanId) {
    throw new LoanOrchestrationTransportError(
      'authoritative_loan_pending',
      `Loan ${loan.clientLoanId} does not have an authoritative server ID yet`,
      true
    )
  }

  const outcome = await getLoanRepaymentOutcomeByRepaymentId(database, loan.clientLoanId, repayment.repaymentId)
  if (!outcome) {
    throw new LoanOrchestrationTransportError(
      'unknown_repayment_outcome',
      `Repayment ${repayment.repaymentId} does not exist in the local cache`,
      false
    )
  }

  const response = await transport.invoke({
    action: 'loan.repayment.capture',
    input: {
      operationId: entry.operationId,
      loanId: loan.serverLoanId,
      memberId,
      clientRepaymentId: repayment.repaymentId,
      amountMinor: repayment.amountMinor,
      currencyCode: repayment.currencyCode,
      effectiveAt: repayment.effectiveAt,
      capturedAt: repayment.capturedAt,
      note,
      lastKnownServerVersion: loan.serverVersion,
    },
  })

  const authoritativeSchedule = await resolveRepaymentAuthoritativeSchedule(database, outcome, response)
  const reconciledLoan = await reconcileCachedLoan(database, {
    clientLoanId: loan.clientLoanId,
    serverLoanId: response.data.serverLoanId ?? loan.serverLoanId,
    serverVersion: response.data.serverVersion,
    reconciledAt: timestamp,
    status: response.data.status,
    outstandingPrincipalMinor: response.data.totals.outstandingPrincipalMinor,
    accruedInterestMinor: response.data.totals.accruedInterestMinor,
    totalRepaidMinor: response.data.totals.totalRepaidMinor,
    schedule: authoritativeSchedule,
    payload: {
      ...loan.payload,
      authoritativeOutcome: response.data,
    },
    conflict: {
      queueEntryId: entry.operationId,
      localTransactionId: entry.localTransactionId,
      localPayload: entry.payload,
      conflictType: 'loan_repayment_authoritative_adjustment',
    },
  })

  await reconcileLoanRepaymentOutcome(database, {
    loanId: loan.clientLoanId,
    repaymentId: repayment.repaymentId,
    status: response.data.repaymentStatus ?? outcome.status,
    syncState: reconciledLoan.syncState === 'conflict' ? 'conflict' : 'authoritative',
    serverVersion: response.data.serverVersion,
    serverRepaymentId: response.data.serverRepaymentId,
    resultingScheduleSnapshotId: reconciledLoan.currentScheduleSnapshotId,
    reconciledAt: timestamp,
    payload: {
      authoritativeOutcome: response.data,
      serverLoanId: response.data.serverLoanId,
    },
  })

  await updateLocalTransactionStatus(database, entry.localTransactionId, 'synced_pending', timestamp)

  return response
}

async function handleSyncConflict(
  database: DatabaseConnection,
  entry: QueueEntryRecord,
  error: LoanOrchestrationRequestError,
  timestamp: string
) {
  if (entry.operationType === 'loan.repayment' && error.code === 'stale_server_version') {
    const { repayment } = getLoanRepaymentPayload(entry)
    const loan = await getCachedLoanByClientId(database, repayment.loanId)
    if (loan) {
      await markCachedLoanStale(database, {
        clientLoanId: loan.clientLoanId,
        staleAt: timestamp,
      })
    }
  }

  await recordSyncConflict(database, {
    queueEntryId: entry.operationId,
    localTransactionId: entry.localTransactionId,
    conflictType: getConflictType(error.code),
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

export async function runLoanSync(
  database: DatabaseConnection,
  input: RunLoanSyncInput = {}
): Promise<LoanSyncSummary> {
  const now = input.now ?? (() => new Date().toISOString())
  const transport = input.transport ?? createLoanOrchestrationTransport()
  const queueEntries = await listQueueEntriesForSync(database, [...SYNCABLE_LOAN_OPERATION_TYPES])
  const summary: LoanSyncSummary = {
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
      const response = entry.operationType === 'loan.create'
        ? await syncLoanCreateEntry(database, entry, transport, processingTimestamp)
        : await syncLoanRepaymentEntry(database, entry, transport, processingTimestamp)

      lastServerVersion = response.data.serverVersion
      await updateQueueEntryStatus(database, entry.operationId, 'synced', processingTimestamp, entry.attemptCount + 1)
      await upsertSyncCheckpoint(database, {
        scope: LOAN_SYNC_SCOPE,
        lastPulledAt: processingTimestamp,
        serverCursor: null,
        lastKnownServerVersion: response.data.serverVersion,
      })

      summary.synced += 1
      if (response.replayed) {
        summary.replayed += 1
      }
    } catch (error) {
      if (error instanceof LoanOrchestrationRequestError && !error.retryable) {
        await handleSyncConflict(database, entry, error, processingTimestamp)
        summary.conflicts += 1
      } else {
        await updateQueueEntryStatus(database, entry.operationId, 'failed', processingTimestamp, entry.attemptCount + 1)
        summary.failed += 1
      }

      if (!(error instanceof LoanOrchestrationTransportError) && !(error instanceof LoanOrchestrationRequestError)) {
        await recordSyncConflict(database, {
          queueEntryId: entry.operationId,
          localTransactionId: entry.localTransactionId,
          conflictType: 'loan_queue_unexpected_error',
          serverPayload: {
            message: error instanceof Error ? error.message : 'Unexpected loan sync error',
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