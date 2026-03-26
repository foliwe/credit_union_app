import type { DatabaseConnection } from '../database'
import type {
  CreateLocalTransactionWithQueueInput,
  LocalFraudAssessment,
  LoanRepaymentAllocationStrategy,
  LoanRepaymentPayload,
  LocalTransactionRecord,
  LoanInterestStrategy,
  LoanInstallmentSnapshot,
  QueueEntryRecord,
} from '../../types/offline'
import { buildLoanRepaymentQueuePayload } from '../../loans/mobile-loans'
import { assessLocalCashTransactionGuardrails } from './agent-cash'
import { assessLocalTransactionCapture } from '../../transactions/fraud'
import { recordProvisionalLoanRepaymentOutcome } from './loans'
import { createQueueEntry, getQueueEntryByOperationId } from './queue'

type LocalTransactionRow = {
  id: string
  client_transaction_id: string
  member_id: string
  account_id: string
  transaction_type: LocalTransactionRecord['transactionType']
  amount_minor: number
  currency_code: string
  occurred_at: string
  captured_at: string
  client_recorded_at: string
  actor_id: string
  branch_id: string
  device_installation_id: string
  offline_envelope_id: string
  offline_batch_id: string
  integrity_hash: string
  fraud_hints_json: string
  guardrail_status: LocalTransactionRecord['guardrailStatus']
  evidence_json: string
  payload_json: string
  status: LocalTransactionRecord['status']
  queue_operation_id: string
  created_at: string
  updated_at: string
}

function createId(prefix: string) {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}_${token}`
}

function mergeHints(
  hints: LocalFraudAssessment['hints'],
  extraHints: LocalFraudAssessment['hints']
): LocalFraudAssessment['hints'] {
  const merged = [...hints]

  for (const hint of extraHints) {
    if (!merged.some((existingHint) => existingHint.code === hint.code && existingHint.message === hint.message)) {
      merged.push(hint)
    }
  }

  return merged
}

function mergeGuardrails(
  base: LocalFraudAssessment['guardrail'],
  addition: LocalFraudAssessment['guardrail']
): LocalFraudAssessment['guardrail'] {
  const rank = {
    clear: 0,
    review: 1,
    blocked: 2,
  } as const

  if (rank[addition.status] > rank[base.status]) {
    return {
      status: addition.status,
      title: addition.title,
      messages: [...addition.messages, ...base.messages],
    }
  }

  if (rank[addition.status] === rank[base.status] && addition.messages.length > 0) {
    return {
      status: base.status,
      title: base.title,
      messages: [...base.messages, ...addition.messages],
    }
  }

  return base
}

function mapLocalTransactionRow(row: LocalTransactionRow): LocalTransactionRecord {
  return {
    id: row.id,
    clientTransactionId: row.client_transaction_id,
    memberId: row.member_id,
    accountId: row.account_id,
    transactionType: row.transaction_type,
    amountMinor: row.amount_minor,
    currencyCode: row.currency_code,
    occurredAt: row.occurred_at,
    capturedAt: row.captured_at,
    clientRecordedAt: row.client_recorded_at,
    actorId: row.actor_id,
    branchId: row.branch_id,
    deviceInstallationId: row.device_installation_id,
    offlineEnvelopeId: row.offline_envelope_id,
    offlineBatchId: row.offline_batch_id,
    integrityHash: row.integrity_hash,
    fraudEvidence: JSON.parse(row.evidence_json) as LocalTransactionRecord['fraudEvidence'],
    fraudHints: JSON.parse(row.fraud_hints_json) as LocalTransactionRecord['fraudHints'],
    guardrailStatus: row.guardrail_status,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    queueOperationId: row.queue_operation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function listHistoricalTransactions(
  database: DatabaseConnection,
  input: Pick<
    CreateLocalTransactionWithQueueInput['transaction'],
    'memberId' | 'deviceInstallationId'
  >
) {
  const rows = await database.getAllAsync<LocalTransactionRow>(
    `
      SELECT
        id,
        client_transaction_id,
        member_id,
        account_id,
        transaction_type,
        amount_minor,
        currency_code,
        occurred_at,
        captured_at,
        client_recorded_at,
        actor_id,
        branch_id,
        device_installation_id,
        offline_envelope_id,
        offline_batch_id,
        integrity_hash,
        fraud_hints_json,
        guardrail_status,
        evidence_json,
        payload_json,
        status,
        queue_operation_id,
        created_at,
        updated_at
      FROM local_transactions
      WHERE member_id = ? OR device_installation_id = ?
      ORDER BY created_at ASC
    `,
    [input.memberId, input.deviceInstallationId]
  )

  return rows.map(mapLocalTransactionRow)
}

async function getLocalTransactionById(
  database: DatabaseConnection,
  id: string
): Promise<LocalTransactionRecord | null> {
  const row = await database.getFirstAsync<LocalTransactionRow>(
    `
      SELECT
        id,
        client_transaction_id,
        member_id,
        account_id,
        transaction_type,
        amount_minor,
        currency_code,
        occurred_at,
        captured_at,
        client_recorded_at,
        actor_id,
        branch_id,
        device_installation_id,
        offline_envelope_id,
        offline_batch_id,
        integrity_hash,
        fraud_hints_json,
        guardrail_status,
        evidence_json,
        payload_json,
        status,
        queue_operation_id,
        created_at,
        updated_at
      FROM local_transactions
      WHERE id = ?
    `,
    [id]
  )

  return row ? mapLocalTransactionRow(row) : null
}

export { getLocalTransactionById }

export async function updateLocalTransactionStatus(
  database: DatabaseConnection,
  transactionId: string,
  status: LocalTransactionRecord['status'],
  updatedAt: string
): Promise<LocalTransactionRecord | null> {
  await database.runAsync(
    `
      UPDATE local_transactions
      SET status = ?,
          updated_at = ?
      WHERE id = ?
    `,
    [status, updatedAt, transactionId]
  )

  return getLocalTransactionById(database, transactionId)
}

export async function assessLocalTransactionCaptureWithHistory(
  database: DatabaseConnection,
  input: CreateLocalTransactionWithQueueInput
): Promise<LocalFraudAssessment> {
  const priorTransactions = await listHistoricalTransactions(database, input.transaction)

  return assessLocalTransactionCapture({
    transactionType: input.transaction.transactionType,
    clientTransactionId: input.transaction.clientTransactionId,
    memberId: input.transaction.memberId,
    accountId: input.transaction.accountId,
    amountMinor: input.transaction.amountMinor,
    occurredAt: input.transaction.occurredAt,
    capturedAt: input.transaction.capturedAt,
    actorId: input.transaction.actorId,
    branchId: input.transaction.branchId,
    deviceInstallationId: input.transaction.deviceInstallationId,
    queueOperationId: input.queue.operationId,
    lastKnownServerVersion: input.queue.lastKnownServerVersion,
    payload: input.transaction.payload,
    priorTransactions,
    captureContext: {
      isOfflineCapture: true,
      ...(input.transaction.captureContext ?? {}),
    },
  })
}

export async function createLocalTransactionWithQueue(
  database: DatabaseConnection,
  input: CreateLocalTransactionWithQueueInput
): Promise<{ transaction: LocalTransactionRecord; queue: QueueEntryRecord }> {
  const transactionId = createId('txn')
  const createdAt = input.transaction.capturedAt
  const fraudAssessment = await assessLocalTransactionCaptureWithHistory(database, input)
  const cashAssessment = await assessLocalCashTransactionGuardrails(database, {
    actorId: input.transaction.actorId,
    branchId: input.transaction.branchId,
    capturedAt: input.transaction.capturedAt,
    transactionType: input.transaction.transactionType,
    amountMinor: input.transaction.amountMinor,
    payload: input.transaction.payload,
  })
  const assessment: LocalFraudAssessment = {
    evidence: fraudAssessment.evidence,
    hints: mergeHints(fraudAssessment.hints, cashAssessment.hints),
    guardrail: mergeGuardrails(fraudAssessment.guardrail, cashAssessment.guardrail),
  }

  if (assessment.guardrail.status === 'blocked') {
    throw new Error(assessment.guardrail.messages[0] ?? 'This transaction is blocked by the local offline guardrail.')
  }

  const payloadWithFraudEvidence = {
    ...input.transaction.payload,
    accountId: input.transaction.accountId,
    amountMinor: input.transaction.amountMinor,
    branchId: input.transaction.branchId,
    capturedAt: input.transaction.capturedAt,
    clientRecordedAt: assessment.evidence.clientRecordedAt,
    clientTransactionId: input.transaction.clientTransactionId,
    currencyCode: input.transaction.currencyCode,
    deviceInstallationId: input.transaction.deviceInstallationId,
    effectiveAt: input.transaction.occurredAt,
    integrityHash: assessment.evidence.integrityHash,
    memberId: input.transaction.memberId,
    offlineBatchId: assessment.evidence.offlineBatchId,
    offlineEnvelopeId: assessment.evidence.offlineEnvelopeId,
    localRiskHints: assessment.hints,
    offlineEvidence: assessment.evidence,
    guardrailStatus: assessment.guardrail.status,
    transactionType: input.transaction.transactionType,
  }

  return database.withTransactionAsync(async (transactionDatabase) => {
    await transactionDatabase.runAsync(
      `
        INSERT INTO local_transactions (
          id,
          client_transaction_id,
          member_id,
          account_id,
          transaction_type,
          amount_minor,
          currency_code,
          occurred_at,
          captured_at,
          client_recorded_at,
          actor_id,
          branch_id,
          device_installation_id,
          offline_envelope_id,
          offline_batch_id,
          integrity_hash,
          fraud_hints_json,
          guardrail_status,
          evidence_json,
          payload_json,
          status,
          queue_operation_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        transactionId,
        input.transaction.clientTransactionId,
        input.transaction.memberId,
        input.transaction.accountId,
        input.transaction.transactionType,
        input.transaction.amountMinor,
        input.transaction.currencyCode,
        input.transaction.occurredAt,
        input.transaction.capturedAt,
        assessment.evidence.clientRecordedAt,
        input.transaction.actorId,
        input.transaction.branchId,
        input.transaction.deviceInstallationId,
        assessment.evidence.offlineEnvelopeId,
        assessment.evidence.offlineBatchId,
        assessment.evidence.integrityHash,
        JSON.stringify(assessment.hints),
        assessment.guardrail.status,
        JSON.stringify(assessment.evidence),
        JSON.stringify(payloadWithFraudEvidence),
        'local_pending',
        input.queue.operationId,
        createdAt,
        createdAt,
      ]
    )

    await createQueueEntry(transactionDatabase, {
      operationId: input.queue.operationId,
      operationType: input.queue.operationType,
      localEntityId: transactionId,
      actorId: input.transaction.actorId,
      branchId: input.transaction.branchId,
      deviceInstallationId: input.transaction.deviceInstallationId,
      payload: {
        transactionId,
        clientTransactionId: input.transaction.clientTransactionId,
        memberId: input.transaction.memberId,
        accountId: input.transaction.accountId,
        transactionType: input.transaction.transactionType,
        amountMinor: input.transaction.amountMinor,
        currencyCode: input.transaction.currencyCode,
        occurredAt: input.transaction.occurredAt,
        capturedAt: input.transaction.capturedAt,
        clientRecordedAt: assessment.evidence.clientRecordedAt,
        actorId: input.transaction.actorId,
        branchId: input.transaction.branchId,
        deviceInstallationId: input.transaction.deviceInstallationId,
        offlineEnvelopeId: assessment.evidence.offlineEnvelopeId,
        offlineBatchId: assessment.evidence.offlineBatchId,
        integrityHash: assessment.evidence.integrityHash,
        offlineEvidence: assessment.evidence,
        localRiskHints: assessment.hints,
        guardrailStatus: assessment.guardrail.status,
        payload: payloadWithFraudEvidence,
      },
      nextAttemptAt: createdAt,
      createdAt,
      lastKnownServerVersion: input.queue.lastKnownServerVersion,
    })

    const storedTransaction = await getLocalTransactionById(transactionDatabase, transactionId)
    const storedQueue = await getQueueEntryByOperationId(transactionDatabase, input.queue.operationId)

    if (!storedTransaction || !storedQueue) {
      throw new Error('Failed to persist local transaction boundary')
    }

    return {
      transaction: storedTransaction,
      queue: storedQueue,
    }
  })
}

export async function getLocalTransactionByClientId(
  database: DatabaseConnection,
  clientTransactionId: string
): Promise<LocalTransactionRecord | null> {
  const row = await database.getFirstAsync<LocalTransactionRow>(
    `
      SELECT
        id,
        client_transaction_id,
        member_id,
        account_id,
        transaction_type,
        amount_minor,
        currency_code,
        occurred_at,
        captured_at,
        client_recorded_at,
        actor_id,
        branch_id,
        device_installation_id,
        offline_envelope_id,
        offline_batch_id,
        integrity_hash,
        fraud_hints_json,
        guardrail_status,
        evidence_json,
        payload_json,
        status,
        queue_operation_id,
        created_at,
        updated_at
      FROM local_transactions
      WHERE client_transaction_id = ?
    `,
    [clientTransactionId]
  )

  return row ? mapLocalTransactionRow(row) : null
}

export async function listLocalTransactions(database: DatabaseConnection): Promise<LocalTransactionRecord[]> {
  const rows = await database.getAllAsync<LocalTransactionRow>(
    `
      SELECT
        id,
        client_transaction_id,
        member_id,
        account_id,
        transaction_type,
        amount_minor,
        currency_code,
        occurred_at,
        captured_at,
        client_recorded_at,
        actor_id,
        branch_id,
        device_installation_id,
        offline_envelope_id,
        offline_batch_id,
        integrity_hash,
        fraud_hints_json,
        guardrail_status,
        evidence_json,
        payload_json,
        status,
        queue_operation_id,
        created_at,
        updated_at
      FROM local_transactions
      ORDER BY created_at ASC
    `
  )

  return rows.map(mapLocalTransactionRow)
}

export type CreateLoanRepaymentWithQueueInput = {
  loanId: string
  memberId: string
  accountId: string
  amountMinor: number
  currencyCode: string
  effectiveAt: string
  capturedAt: string
  actorId: string
  branchId: string
  deviceInstallationId: string
  queueOperationId: string
  lastKnownServerVersion: string | null
  installments: LoanInstallmentSnapshot[]
  repaymentId?: string
  interestStrategy?: LoanInterestStrategy
  repaymentAllocationStrategy?: LoanRepaymentAllocationStrategy
}

export async function createLoanRepaymentWithQueue(
  database: DatabaseConnection,
  input: CreateLoanRepaymentWithQueueInput
): Promise<{
  transaction: LocalTransactionRecord
  queue: QueueEntryRecord
  repaymentPayload: LoanRepaymentPayload
}> {
  const repaymentId = input.repaymentId ?? createId('repayment')
  const repaymentPayload = buildLoanRepaymentQueuePayload({
    loanId: input.loanId,
    repaymentId,
    amountMinor: input.amountMinor,
    currencyCode: input.currencyCode,
    effectiveAt: input.effectiveAt,
    capturedAt: input.capturedAt,
    installments: input.installments,
    interestStrategy: input.interestStrategy,
    repaymentAllocationStrategy: input.repaymentAllocationStrategy,
  })

  const created = await createLocalTransactionWithQueue(database, {
    transaction: {
      clientTransactionId: repaymentId,
      memberId: input.memberId,
      accountId: input.accountId,
      transactionType: 'repayment',
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      occurredAt: input.effectiveAt,
      capturedAt: input.capturedAt,
      payload: repaymentPayload as unknown as Record<string, unknown>,
      actorId: input.actorId,
      branchId: input.branchId,
      deviceInstallationId: input.deviceInstallationId,
    },
    queue: {
      operationId: input.queueOperationId,
      operationType: 'loan.repayment',
      lastKnownServerVersion: input.lastKnownServerVersion,
    },
  })

  await recordProvisionalLoanRepaymentOutcome(database, {
    loanId: input.loanId,
    localTransactionId: created.transaction.id,
    queueOperationId: input.queueOperationId,
    repaymentPayload,
  })

  return {
    ...created,
    repaymentPayload,
  }
}
