import type { DatabaseConnection } from '../database'
import type { LoanProductContract, LoanRepaymentPayload, QueueEntryRecord } from '../../types/offline'
import {
  applyRepaymentToInstallments,
  buildLoanCreateQueuePayload,
  type LoanCreateQueuePayload,
  type LoanRepaymentAllocation,
  type LoanScheduleProjection,
  type LocalLoanSyncState,
} from '../../loans/mobile-loans'
import { createQueueEntry } from './queue'
import { recordSyncConflict } from './sync-metadata'

export type CachedLoanRecord = {
  id: string
  serverLoanId: string | null
  clientLoanId: string
  branchId: string
  memberId: string
  productCode: string
  productName: string
  currencyCode: string
  principalMinor: number
  outstandingPrincipalMinor: number
  accruedInterestMinor: number
  totalRepaidMinor: number
  termMonths: number
  monthlyInterestRateBps: number
  repaymentDayOfMonth: number
  interestStrategy: string
  repaymentAllocationStrategy: string
  status: string
  syncState: LocalLoanSyncState
  sourceQueueOperationId: string | null
  currentScheduleSnapshotId: string | null
  staleAt: string | null
  lastReconciledAt: string | null
  serverVersion: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type CachedLoanScheduleSnapshotRecord = {
  id: string
  loanId: string
  snapshotSequence: number
  generatedAt: string
  effectiveFrom: string
  status: 'current' | 'superseded'
  syncState: LocalLoanSyncState
  outstandingPrincipalMinor: number
  accruedInterestMinor: number
  schedule: LoanScheduleProjection[]
  sourceQueueOperationId: string | null
  serverVersion: string | null
  createdAt: string
}

export type CachedLoanRepaymentOutcomeRecord = {
  id: string
  repaymentId: string
  loanId: string
  localTransactionId: string | null
  queueOperationId: string
  sourceScheduleSnapshotId: string | null
  resultingScheduleSnapshotId: string | null
  amountMinor: number
  currencyCode: string
  effectiveAt: string
  capturedAt: string
  status: string
  syncState: LocalLoanSyncState
  allocations: LoanRepaymentAllocation[]
  resultingInstallments: LoanScheduleProjection[]
  remainingAmountMinor: number
  totalAllocatedMinor: number
  resultingOutstandingPrincipalMinor: number
  resultingAccruedInterestMinor: number
  serverVersion: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

type CachedLoanRow = {
  id: string
  server_loan_id: string | null
  client_loan_id: string
  branch_id: string
  member_id: string
  product_code: string
  product_name: string
  currency_code: string
  principal_minor: number
  outstanding_principal_minor: number
  accrued_interest_minor: number
  total_repaid_minor: number
  term_months: number
  monthly_interest_rate_bps: number
  repayment_day_of_month: number
  interest_strategy: string
  repayment_allocation_strategy: string
  status: string
  sync_state: LocalLoanSyncState
  source_queue_operation_id: string | null
  current_schedule_snapshot_id: string | null
  stale_at: string | null
  last_reconciled_at: string | null
  server_version: string | null
  payload_json: string
  created_at: string
  updated_at: string
}

type CachedLoanScheduleSnapshotRow = {
  id: string
  loan_id: string
  snapshot_sequence: number
  generated_at: string
  effective_from: string
  status: 'current' | 'superseded'
  sync_state: LocalLoanSyncState
  outstanding_principal_minor: number
  accrued_interest_minor: number
  schedule_json: string
  source_queue_operation_id: string | null
  server_version: string | null
  created_at: string
}

type CachedLoanRepaymentOutcomeRow = {
  id: string
  repayment_id: string
  loan_id: string
  local_transaction_id: string | null
  queue_operation_id: string
  source_schedule_snapshot_id: string | null
  resulting_schedule_snapshot_id: string | null
  amount_minor: number
  currency_code: string
  effective_at: string
  captured_at: string
  status: string
  sync_state: LocalLoanSyncState
  allocations_json: string
  resulting_installments_json: string
  remaining_amount_minor: number
  total_allocated_minor: number
  resulting_outstanding_principal_minor: number
  resulting_accrued_interest_minor: number
  server_version: string | null
  payload_json: string
  created_at: string
  updated_at: string
}

function createId(prefix: string) {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}_${token}`
}

function mapCachedLoanRow(row: CachedLoanRow): CachedLoanRecord {
  return {
    id: row.id,
    serverLoanId: row.server_loan_id,
    clientLoanId: row.client_loan_id,
    branchId: row.branch_id,
    memberId: row.member_id,
    productCode: row.product_code,
    productName: row.product_name,
    currencyCode: row.currency_code,
    principalMinor: row.principal_minor,
    outstandingPrincipalMinor: row.outstanding_principal_minor,
    accruedInterestMinor: row.accrued_interest_minor,
    totalRepaidMinor: row.total_repaid_minor,
    termMonths: row.term_months,
    monthlyInterestRateBps: row.monthly_interest_rate_bps,
    repaymentDayOfMonth: row.repayment_day_of_month,
    interestStrategy: row.interest_strategy,
    repaymentAllocationStrategy: row.repayment_allocation_strategy,
    status: row.status,
    syncState: row.sync_state,
    sourceQueueOperationId: row.source_queue_operation_id,
    currentScheduleSnapshotId: row.current_schedule_snapshot_id,
    staleAt: row.stale_at,
    lastReconciledAt: row.last_reconciled_at,
    serverVersion: row.server_version,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapScheduleSnapshotRow(row: CachedLoanScheduleSnapshotRow): CachedLoanScheduleSnapshotRecord {
  return {
    id: row.id,
    loanId: row.loan_id,
    snapshotSequence: row.snapshot_sequence,
    generatedAt: row.generated_at,
    effectiveFrom: row.effective_from,
    status: row.status,
    syncState: row.sync_state,
    outstandingPrincipalMinor: row.outstanding_principal_minor,
    accruedInterestMinor: row.accrued_interest_minor,
    schedule: JSON.parse(row.schedule_json) as LoanScheduleProjection[],
    sourceQueueOperationId: row.source_queue_operation_id,
    serverVersion: row.server_version,
    createdAt: row.created_at,
  }
}

function mapRepaymentOutcomeRow(row: CachedLoanRepaymentOutcomeRow): CachedLoanRepaymentOutcomeRecord {
  return {
    id: row.id,
    repaymentId: row.repayment_id,
    loanId: row.loan_id,
    localTransactionId: row.local_transaction_id,
    queueOperationId: row.queue_operation_id,
    sourceScheduleSnapshotId: row.source_schedule_snapshot_id,
    resultingScheduleSnapshotId: row.resulting_schedule_snapshot_id,
    amountMinor: row.amount_minor,
    currencyCode: row.currency_code,
    effectiveAt: row.effective_at,
    capturedAt: row.captured_at,
    status: row.status,
    syncState: row.sync_state,
    allocations: JSON.parse(row.allocations_json) as LoanRepaymentAllocation[],
    resultingInstallments: JSON.parse(row.resulting_installments_json) as LoanScheduleProjection[],
    remainingAmountMinor: row.remaining_amount_minor,
    totalAllocatedMinor: row.total_allocated_minor,
    resultingOutstandingPrincipalMinor: row.resulting_outstanding_principal_minor,
    resultingAccruedInterestMinor: row.resulting_accrued_interest_minor,
    serverVersion: row.server_version,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function getCachedLoanRowByClientId(
  database: DatabaseConnection,
  clientLoanId: string
): Promise<CachedLoanRow | null> {
  return database.getFirstAsync<CachedLoanRow>(
    `
      SELECT
        id,
        server_loan_id,
        client_loan_id,
        branch_id,
        member_id,
        product_code,
        product_name,
        currency_code,
        principal_minor,
        outstanding_principal_minor,
        accrued_interest_minor,
        total_repaid_minor,
        term_months,
        monthly_interest_rate_bps,
        repayment_day_of_month,
        interest_strategy,
        repayment_allocation_strategy,
        status,
        sync_state,
        source_queue_operation_id,
        current_schedule_snapshot_id,
        stale_at,
        last_reconciled_at,
        server_version,
        payload_json,
        created_at,
        updated_at
      FROM cached_loans
      WHERE client_loan_id = ?
    `,
    [clientLoanId]
  )
}

async function getNextSnapshotSequence(database: DatabaseConnection, loanId: string) {
  const row = await database.getFirstAsync<{ next_sequence: number }>(
    `
      SELECT COALESCE(MAX(snapshot_sequence), 0) + 1 AS next_sequence
      FROM cached_loan_schedule_snapshots
      WHERE loan_id = ?
    `,
    [loanId]
  )

  return row?.next_sequence ?? 1
}

async function insertScheduleSnapshot(
  database: DatabaseConnection,
  input: {
    id?: string
    loanId: string
    snapshotSequence: number
    generatedAt: string
    effectiveFrom: string
    status: 'current' | 'superseded'
    syncState: LocalLoanSyncState
    outstandingPrincipalMinor: number
    accruedInterestMinor: number
    schedule: LoanScheduleProjection[]
    sourceQueueOperationId: string | null
    serverVersion: string | null
    createdAt: string
  }
) {
  const id = input.id ?? createId('loan_schedule')

  await database.runAsync(
    `
      INSERT INTO cached_loan_schedule_snapshots (
        id,
        loan_id,
        snapshot_sequence,
        generated_at,
        effective_from,
        status,
        sync_state,
        outstanding_principal_minor,
        accrued_interest_minor,
        schedule_json,
        source_queue_operation_id,
        server_version,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      input.loanId,
      input.snapshotSequence,
      input.generatedAt,
      input.effectiveFrom,
      input.status,
      input.syncState,
      input.outstandingPrincipalMinor,
      input.accruedInterestMinor,
      JSON.stringify(input.schedule),
      input.sourceQueueOperationId,
      input.serverVersion,
      input.createdAt,
    ]
  )

  const stored = await getLoanScheduleSnapshotById(database, id)
  if (!stored) {
    throw new Error(`Failed to load schedule snapshot ${id}`)
  }

  return stored
}

function buildQueuePayloadFromLoanPayload(payload: LoanCreateQueuePayload) {
  return payload as unknown as Record<string, unknown>
}

export async function getCachedLoanByClientId(
  database: DatabaseConnection,
  clientLoanId: string
): Promise<CachedLoanRecord | null> {
  const row = await getCachedLoanRowByClientId(database, clientLoanId)
  return row ? mapCachedLoanRow(row) : null
}

export async function listCachedLoans(database: DatabaseConnection): Promise<CachedLoanRecord[]> {
  const rows = await database.getAllAsync<CachedLoanRow>(
    `
      SELECT
        id,
        server_loan_id,
        client_loan_id,
        branch_id,
        member_id,
        product_code,
        product_name,
        currency_code,
        principal_minor,
        outstanding_principal_minor,
        accrued_interest_minor,
        total_repaid_minor,
        term_months,
        monthly_interest_rate_bps,
        repayment_day_of_month,
        interest_strategy,
        repayment_allocation_strategy,
        status,
        sync_state,
        source_queue_operation_id,
        current_schedule_snapshot_id,
        stale_at,
        last_reconciled_at,
        server_version,
        payload_json,
        created_at,
        updated_at
      FROM cached_loans
      ORDER BY updated_at DESC
    `
  )

  return rows.map(mapCachedLoanRow)
}

export async function getLoanScheduleSnapshotById(
  database: DatabaseConnection,
  snapshotId: string
): Promise<CachedLoanScheduleSnapshotRecord | null> {
  const row = await database.getFirstAsync<CachedLoanScheduleSnapshotRow>(
    `
      SELECT
        id,
        loan_id,
        snapshot_sequence,
        generated_at,
        effective_from,
        status,
        sync_state,
        outstanding_principal_minor,
        accrued_interest_minor,
        schedule_json,
        source_queue_operation_id,
        server_version,
        created_at
      FROM cached_loan_schedule_snapshots
      WHERE id = ?
    `,
    [snapshotId]
  )

  return row ? mapScheduleSnapshotRow(row) : null
}

export async function getCurrentLoanScheduleSnapshot(
  database: DatabaseConnection,
  loanId: string
): Promise<CachedLoanScheduleSnapshotRecord | null> {
  const row = await database.getFirstAsync<CachedLoanScheduleSnapshotRow>(
    `
      SELECT
        id,
        loan_id,
        snapshot_sequence,
        generated_at,
        effective_from,
        status,
        sync_state,
        outstanding_principal_minor,
        accrued_interest_minor,
        schedule_json,
        source_queue_operation_id,
        server_version,
        created_at
      FROM cached_loan_schedule_snapshots
      WHERE loan_id = ? AND status = 'current'
      ORDER BY snapshot_sequence DESC
      LIMIT 1
    `,
    [loanId]
  )

  return row ? mapScheduleSnapshotRow(row) : null
}

export async function listLoanRepaymentOutcomes(
  database: DatabaseConnection,
  loanId: string
): Promise<CachedLoanRepaymentOutcomeRecord[]> {
  const rows = await database.getAllAsync<CachedLoanRepaymentOutcomeRow>(
    `
      SELECT
        id,
        repayment_id,
        loan_id,
        local_transaction_id,
        queue_operation_id,
        source_schedule_snapshot_id,
        resulting_schedule_snapshot_id,
        amount_minor,
        currency_code,
        effective_at,
        captured_at,
        status,
        sync_state,
        allocations_json,
        resulting_installments_json,
        remaining_amount_minor,
        total_allocated_minor,
        resulting_outstanding_principal_minor,
        resulting_accrued_interest_minor,
        server_version,
        payload_json,
        created_at,
        updated_at
      FROM cached_loan_repayment_outcomes
      WHERE loan_id = ?
      ORDER BY created_at ASC
    `,
    [loanId]
  )

  return rows.map(mapRepaymentOutcomeRow)
}

export async function createProvisionalLoanWithQueue(
  database: DatabaseConnection,
  input: {
    memberId: string
    actorId: string
    branchId: string
    deviceInstallationId: string
    submittedAt: string
    product: LoanProductContract
    queue: {
      operationId: string
      lastKnownServerVersion: string | null
    }
    clientLoanId?: string
    metadata?: Record<string, unknown>
  }
): Promise<{ loan: CachedLoanRecord; queue: QueueEntryRecord; schedule: CachedLoanScheduleSnapshotRecord }> {
  const payload = buildLoanCreateQueuePayload({
    loanId: input.clientLoanId,
    memberId: input.memberId,
    submittedAt: input.submittedAt,
    product: input.product,
    metadata: input.metadata,
  })
  const loanId = payload.loanId

  return database.withTransactionAsync(async (transactionDatabase) => {
    const schedule = await insertScheduleSnapshot(transactionDatabase, {
      loanId,
      snapshotSequence: payload.currentSchedule.snapshotSequence,
      generatedAt: payload.currentSchedule.generatedAt,
      effectiveFrom: payload.currentSchedule.effectiveFrom,
      status: 'current',
      syncState: 'provisional',
      outstandingPrincipalMinor: payload.currentSchedule.installments.reduce(
        (total, installment) => total + installment.outstandingPrincipalMinor,
        0
      ),
      accruedInterestMinor: payload.currentSchedule.installments.reduce(
        (total, installment) => total + installment.outstandingInterestMinor,
        0
      ),
      schedule: payload.currentSchedule.installments,
      sourceQueueOperationId: input.queue.operationId,
      serverVersion: null,
      createdAt: input.submittedAt,
    })

    await transactionDatabase.runAsync(
      `
        INSERT INTO cached_loans (
          id,
          server_loan_id,
          client_loan_id,
          branch_id,
          member_id,
          product_code,
          product_name,
          currency_code,
          principal_minor,
          outstanding_principal_minor,
          accrued_interest_minor,
          total_repaid_minor,
          term_months,
          monthly_interest_rate_bps,
          repayment_day_of_month,
          interest_strategy,
          repayment_allocation_strategy,
          status,
          sync_state,
          source_queue_operation_id,
          current_schedule_snapshot_id,
          stale_at,
          last_reconciled_at,
          server_version,
          payload_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        loanId,
        null,
        loanId,
        input.branchId,
        input.memberId,
        payload.productCode,
        payload.productName,
        payload.currencyCode,
        payload.principalMinor,
        schedule.outstandingPrincipalMinor,
        schedule.accruedInterestMinor,
        0,
        payload.termMonths,
        payload.monthlyInterestRateBps,
        payload.repaymentDayOfMonth,
        payload.interestStrategy,
        payload.repaymentAllocationStrategy,
        payload.status,
        'provisional',
        input.queue.operationId,
        schedule.id,
        null,
        null,
        null,
        JSON.stringify(payload),
        input.submittedAt,
        input.submittedAt,
      ]
    )

    const queue = await createQueueEntry(transactionDatabase, {
      operationId: input.queue.operationId,
      operationType: 'loan.create',
      localEntityId: loanId,
      actorId: input.actorId,
      branchId: input.branchId,
      deviceInstallationId: input.deviceInstallationId,
      payload: buildQueuePayloadFromLoanPayload(payload),
      nextAttemptAt: input.submittedAt,
      createdAt: input.submittedAt,
      lastKnownServerVersion: input.queue.lastKnownServerVersion,
    })

    const loan = await getCachedLoanByClientId(transactionDatabase, loanId)
    if (!loan) {
      throw new Error(`Failed to load cached loan ${loanId}`)
    }

    return { loan, queue, schedule }
  })
}

export async function markCachedLoanStale(
  database: DatabaseConnection,
  input: { clientLoanId: string; staleAt: string }
): Promise<CachedLoanRecord | null> {
  await database.runAsync(
    `
      UPDATE cached_loans
      SET sync_state = CASE WHEN sync_state = 'conflict' THEN sync_state ELSE 'stale' END,
          stale_at = ?,
          updated_at = ?
      WHERE client_loan_id = ?
    `,
    [input.staleAt, input.staleAt, input.clientLoanId]
  )

  return getCachedLoanByClientId(database, input.clientLoanId)
}

export async function reconcileCachedLoan(
  database: DatabaseConnection,
  input: {
    clientLoanId: string
    serverLoanId: string
    serverVersion: string
    reconciledAt: string
    status: string
    outstandingPrincipalMinor: number
    accruedInterestMinor: number
    totalRepaidMinor: number
    schedule: LoanScheduleProjection[]
    payload: Record<string, unknown>
    conflict?: {
      queueEntryId?: string
      localTransactionId?: string | null
      localPayload?: Record<string, unknown>
      conflictType?: string
    }
  }
): Promise<CachedLoanRecord> {
  return database.withTransactionAsync(async (transactionDatabase) => {
    const existingRow = await getCachedLoanRowByClientId(transactionDatabase, input.clientLoanId)
    if (!existingRow) {
      throw new Error(`Unknown cached loan ${input.clientLoanId}`)
    }

    const existing = mapCachedLoanRow(existingRow)
    const existingSnapshot = existing.currentScheduleSnapshotId
      ? await getLoanScheduleSnapshotById(transactionDatabase, existing.currentScheduleSnapshotId)
      : null
    const scheduleMismatch =
      existing.outstandingPrincipalMinor !== input.outstandingPrincipalMinor ||
      existing.accruedInterestMinor !== input.accruedInterestMinor ||
      JSON.stringify(existingSnapshot?.schedule ?? []) !== JSON.stringify(input.schedule)
    const nextSyncState: LocalLoanSyncState = scheduleMismatch ? 'conflict' : 'authoritative'
    const nextSnapshotSequence = await getNextSnapshotSequence(transactionDatabase, existing.id)

    if (existing.currentScheduleSnapshotId) {
      await transactionDatabase.runAsync(
        `
          UPDATE cached_loan_schedule_snapshots
          SET status = 'superseded'
          WHERE id = ?
        `,
        [existing.currentScheduleSnapshotId]
      )
    }

    const nextSnapshot = await insertScheduleSnapshot(transactionDatabase, {
      loanId: existing.id,
      snapshotSequence: nextSnapshotSequence,
      generatedAt: input.reconciledAt,
      effectiveFrom: input.schedule[0]?.dueDate ?? existingSnapshot?.effectiveFrom ?? input.reconciledAt.slice(0, 10),
      status: 'current',
      syncState: nextSyncState,
      outstandingPrincipalMinor: input.outstandingPrincipalMinor,
      accruedInterestMinor: input.accruedInterestMinor,
      schedule: input.schedule,
      sourceQueueOperationId: existing.sourceQueueOperationId,
      serverVersion: input.serverVersion,
      createdAt: input.reconciledAt,
    })

    await transactionDatabase.runAsync(
      `
        UPDATE cached_loans
        SET server_loan_id = ?,
            outstanding_principal_minor = ?,
            accrued_interest_minor = ?,
            total_repaid_minor = ?,
            status = ?,
            sync_state = ?,
            current_schedule_snapshot_id = ?,
            stale_at = NULL,
            last_reconciled_at = ?,
            server_version = ?,
            payload_json = ?,
            updated_at = ?
        WHERE client_loan_id = ?
      `,
      [
        input.serverLoanId,
        input.outstandingPrincipalMinor,
        input.accruedInterestMinor,
        input.totalRepaidMinor,
        input.status,
        nextSyncState,
        nextSnapshot.id,
        input.reconciledAt,
        input.serverVersion,
        JSON.stringify(input.payload),
        input.reconciledAt,
        input.clientLoanId,
      ]
    )

    const conflictQueueEntryId = input.conflict?.queueEntryId ?? existing.sourceQueueOperationId
    if (scheduleMismatch && conflictQueueEntryId) {
      await recordSyncConflict(transactionDatabase, {
        queueEntryId: conflictQueueEntryId,
        localTransactionId: input.conflict?.localTransactionId ?? existing.id,
        conflictType: input.conflict?.conflictType ?? 'loan_reconciled_adjustment',
        serverPayload: input.payload,
        localPayload: input.conflict?.localPayload ?? existing.payload,
        createdAt: input.reconciledAt,
        resolvedAt: null,
      })
    }

    const loan = await getCachedLoanByClientId(transactionDatabase, input.clientLoanId)
    if (!loan) {
      throw new Error(`Failed to load reconciled cached loan ${input.clientLoanId}`)
    }

    return loan
  })
}

export async function recordProvisionalLoanRepaymentOutcome(
  database: DatabaseConnection,
  input: {
    loanId: string
    localTransactionId: string
    queueOperationId: string
    repaymentPayload: LoanRepaymentPayload
  }
): Promise<CachedLoanRepaymentOutcomeRecord> {
  return database.withTransactionAsync(async (transactionDatabase) => {
    const loan = await getCachedLoanByClientId(transactionDatabase, input.loanId)
    if (!loan) {
      throw new Error(`Unknown cached loan ${input.loanId}`)
    }

    const currentSnapshot = await getCurrentLoanScheduleSnapshot(transactionDatabase, input.loanId)
    const installments = (input.repaymentPayload.installments as LoanScheduleProjection[])
    const outcome = applyRepaymentToInstallments({
      loanId: input.loanId,
      repaymentId: input.repaymentPayload.repaymentId,
      amountMinor: input.repaymentPayload.amountMinor,
      currencyCode: input.repaymentPayload.currencyCode,
      effectiveAt: input.repaymentPayload.effectiveAt,
      capturedAt: input.repaymentPayload.capturedAt,
      installments,
    })

    if (currentSnapshot) {
      await transactionDatabase.runAsync(
        `
          UPDATE cached_loan_schedule_snapshots
          SET status = 'superseded'
          WHERE id = ?
        `,
        [currentSnapshot.id]
      )
    }

    const nextSnapshot = await insertScheduleSnapshot(transactionDatabase, {
      loanId: input.loanId,
      snapshotSequence: await getNextSnapshotSequence(transactionDatabase, input.loanId),
      generatedAt: input.repaymentPayload.capturedAt,
      effectiveFrom: outcome.resultingInstallments[0]?.dueDate ?? currentSnapshot?.effectiveFrom ?? input.repaymentPayload.effectiveAt.slice(0, 10),
      status: 'current',
      syncState: 'provisional',
      outstandingPrincipalMinor: outcome.resultingOutstandingPrincipalMinor,
      accruedInterestMinor: outcome.resultingAccruedInterestMinor,
      schedule: outcome.resultingInstallments,
      sourceQueueOperationId: input.queueOperationId,
      serverVersion: loan.serverVersion,
      createdAt: input.repaymentPayload.capturedAt,
    })

    const outcomeId = createId('loan_repayment_outcome')

    await transactionDatabase.runAsync(
      `
        INSERT INTO cached_loan_repayment_outcomes (
          id,
          repayment_id,
          loan_id,
          local_transaction_id,
          queue_operation_id,
          source_schedule_snapshot_id,
          resulting_schedule_snapshot_id,
          amount_minor,
          currency_code,
          effective_at,
          captured_at,
          status,
          sync_state,
          allocations_json,
          resulting_installments_json,
          remaining_amount_minor,
          total_allocated_minor,
          resulting_outstanding_principal_minor,
          resulting_accrued_interest_minor,
          server_version,
          payload_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        outcomeId,
        input.repaymentPayload.repaymentId,
        input.loanId,
        input.localTransactionId,
        input.queueOperationId,
        currentSnapshot?.id ?? null,
        nextSnapshot.id,
        input.repaymentPayload.amountMinor,
        input.repaymentPayload.currencyCode,
        input.repaymentPayload.effectiveAt,
        input.repaymentPayload.capturedAt,
        'pending_review',
        'provisional',
        JSON.stringify(outcome.allocations),
        JSON.stringify(outcome.resultingInstallments),
        outcome.remainingAmountMinor,
        outcome.totalAllocatedMinor,
        outcome.resultingOutstandingPrincipalMinor,
        outcome.resultingAccruedInterestMinor,
        loan.serverVersion,
        JSON.stringify(input.repaymentPayload),
        input.repaymentPayload.capturedAt,
        input.repaymentPayload.capturedAt,
      ]
    )

    await transactionDatabase.runAsync(
      `
        UPDATE cached_loans
        SET outstanding_principal_minor = ?,
            accrued_interest_minor = ?,
            total_repaid_minor = total_repaid_minor + ?,
            sync_state = 'provisional',
            current_schedule_snapshot_id = ?,
            stale_at = NULL,
            updated_at = ?
        WHERE client_loan_id = ?
      `,
      [
        outcome.resultingOutstandingPrincipalMinor,
        outcome.resultingAccruedInterestMinor,
        outcome.totalAllocatedMinor,
        nextSnapshot.id,
        input.repaymentPayload.capturedAt,
        input.loanId,
      ]
    )

    const rows = await listLoanRepaymentOutcomes(transactionDatabase, input.loanId)
    const stored = rows.find((row) => row.id === outcomeId)

    if (!stored) {
      throw new Error(`Failed to load repayment outcome ${outcomeId}`)
    }

    return stored
  })
}

export async function getLoanRepaymentOutcomeByRepaymentId(
  database: DatabaseConnection,
  loanId: string,
  repaymentId: string
): Promise<CachedLoanRepaymentOutcomeRecord | null> {
  const row = await database.getFirstAsync<CachedLoanRepaymentOutcomeRow>(
    `
      SELECT
        id,
        repayment_id,
        loan_id,
        local_transaction_id,
        queue_operation_id,
        source_schedule_snapshot_id,
        resulting_schedule_snapshot_id,
        amount_minor,
        currency_code,
        effective_at,
        captured_at,
        status,
        sync_state,
        allocations_json,
        resulting_installments_json,
        remaining_amount_minor,
        total_allocated_minor,
        resulting_outstanding_principal_minor,
        resulting_accrued_interest_minor,
        server_version,
        payload_json,
        created_at,
        updated_at
      FROM cached_loan_repayment_outcomes
      WHERE loan_id = ? AND repayment_id = ?
      LIMIT 1
    `,
    [loanId, repaymentId]
  )

  return row ? mapRepaymentOutcomeRow(row) : null
}

export async function reconcileLoanRepaymentOutcome(
  database: DatabaseConnection,
  input: {
    loanId: string
    repaymentId: string
    status: string
    syncState: LocalLoanSyncState
    serverVersion: string | null
    serverRepaymentId: string | null
    resultingScheduleSnapshotId: string | null
    reconciledAt: string
    payload: Record<string, unknown>
  }
): Promise<CachedLoanRepaymentOutcomeRecord> {
  const existing = await getLoanRepaymentOutcomeByRepaymentId(database, input.loanId, input.repaymentId)
  if (!existing) {
    throw new Error(`Unknown repayment outcome ${input.repaymentId} for loan ${input.loanId}`)
  }

  const nextPayload = {
    ...existing.payload,
    ...input.payload,
    repaymentStatus: input.status,
    serverRepaymentId: input.serverRepaymentId,
  }

  await database.runAsync(
    `
      UPDATE cached_loan_repayment_outcomes
      SET status = ?,
          sync_state = ?,
          resulting_schedule_snapshot_id = ?,
          server_version = ?,
          payload_json = ?,
          updated_at = ?
      WHERE loan_id = ? AND repayment_id = ?
    `,
    [
      input.status,
      input.syncState,
      input.resultingScheduleSnapshotId,
      input.serverVersion,
      JSON.stringify(nextPayload),
      input.reconciledAt,
      input.loanId,
      input.repaymentId,
    ]
  )

  const stored = await getLoanRepaymentOutcomeByRepaymentId(database, input.loanId, input.repaymentId)
  if (!stored) {
    throw new Error(`Failed to load reconciled repayment outcome ${input.repaymentId}`)
  }

  return stored
}