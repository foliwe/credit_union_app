import type {
  LocalFraudAssessment,
  LocalFraudHint,
  LocalFraudHintCode,
  LocalGuardrailDecision,
  LocalGuardrailStatus,
  LocalTransactionRecord,
  OfflineFraudEvidence,
  TransactionCaptureContext,
  TransactionType,
} from '../types/offline'

export const LOCAL_FRAUD_RULES = {
  abnormalWithdrawalReviewMinor: 50_000,
  abnormalWithdrawalBlockOfflineMinor: 100_000,
  abnormalWithdrawalHistoricalMultiplier: 3,
  duplicateWindowMs: 10 * 60 * 1000,
  rapidRepeatWindowMs: 30 * 60 * 1000,
  deviceClockRegressionToleranceMs: 5 * 60 * 1000,
  withdrawalHistoryWindowMs: 30 * 24 * 60 * 60 * 1000,
} as const

type FraudAssessmentInput = {
  transactionType: TransactionType
  clientTransactionId: string
  memberId: string
  accountId: string
  amountMinor: number
  occurredAt: string
  capturedAt: string
  actorId: string
  branchId: string
  deviceInstallationId: string
  queueOperationId: string
  lastKnownServerVersion: string | null
  payload: Record<string, unknown>
  priorTransactions: LocalTransactionRecord[]
  captureContext: TransactionCaptureContext
}

function sortTransactions(transactions: LocalTransactionRecord[]) {
  return [...transactions].sort((left, right) => left.clientRecordedAt.localeCompare(right.clientRecordedAt))
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null'
  }

  if (typeof value === 'string') {
    return JSON.stringify(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`
  }

  return JSON.stringify(String(value))
}

function hashString(value: string) {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function createOfflineBatchId(branchId: string, deviceInstallationId: string, capturedAt: string) {
  return `${branchId}:${deviceInstallationId}:${capturedAt.slice(0, 10)}`
}

function createOfflineEnvelopeId(input: Pick<FraudAssessmentInput, 'queueOperationId' | 'deviceInstallationId' | 'clientTransactionId'>) {
  return `${input.deviceInstallationId}:${input.queueOperationId}:${input.clientTransactionId}`
}

function buildHint(code: LocalFraudHintCode, severity: LocalFraudHint['severity'], message: string): LocalFraudHint {
  return {
    code,
    severity,
    message,
  }
}

function hasHint(hints: LocalFraudHint[], code: LocalFraudHintCode) {
  return hints.some((hint) => hint.code === code)
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0
  }

  return Math.round(values.reduce((total, value) => total + value, 0) / values.length)
}

export function buildOfflineFraudEvidence(input: FraudAssessmentInput): OfflineFraudEvidence {
  const captureSequence =
    input.priorTransactions.filter(
      (transaction) =>
        transaction.deviceInstallationId === input.deviceInstallationId &&
        transaction.clientRecordedAt.slice(0, 10) === input.capturedAt.slice(0, 10)
    ).length + 1

  const offlineEnvelopeId = input.captureContext.offlineEnvelopeId ?? createOfflineEnvelopeId(input)
  const offlineBatchId =
    input.captureContext.offlineBatchId ?? createOfflineBatchId(input.branchId, input.deviceInstallationId, input.capturedAt)

  const integrityHash =
    input.captureContext.integrityHash ??
    hashString(
      stableStringify({
        actorId: input.actorId,
        amountMinor: input.amountMinor,
        branchId: input.branchId,
        capturedAt: input.capturedAt,
        clientTransactionId: input.clientTransactionId,
        deviceInstallationId: input.deviceInstallationId,
        memberId: input.memberId,
        occurredAt: input.occurredAt,
        payload: input.payload,
        queueOperationId: input.queueOperationId,
        transactionType: input.transactionType,
      })
    )

  return {
    clientRecordedAt: input.capturedAt,
    offlineEnvelopeId,
    offlineBatchId,
    integrityHash,
    sourceChannel: 'mobile_offline_sync',
    createdWhileOffline: input.captureContext.isOfflineCapture,
    lastKnownServerVersion: input.lastKnownServerVersion,
    queueOperationId: input.queueOperationId,
    captureSequence,
    policyVersion: 'phase_07_mobile_v1',
  }
}

export function deriveLocalFraudHints(
  input: FraudAssessmentInput,
  evidence: OfflineFraudEvidence
): LocalFraudHint[] {
  const hints: LocalFraudHint[] = []
  const occurredAtMs = Date.parse(input.occurredAt)
  const sortedTransactions = sortTransactions(input.priorTransactions)
  const previousDeviceTransaction = [...sortedTransactions]
    .reverse()
    .find((transaction) => transaction.deviceInstallationId === input.deviceInstallationId)

  const exactDuplicates = input.priorTransactions.filter((transaction) => {
    if (transaction.memberId !== input.memberId || transaction.accountId !== input.accountId) {
      return false
    }

    if (transaction.transactionType !== input.transactionType || transaction.amountMinor !== input.amountMinor) {
      return false
    }

    const deltaMs = Math.abs(Date.parse(transaction.occurredAt) - occurredAtMs)
    return deltaMs <= LOCAL_FRAUD_RULES.duplicateWindowMs
  })

  if (exactDuplicates.length > 0) {
    hints.push(
      buildHint(
        'possible_duplicate',
        'high',
        'This transaction closely matches another local capture and may be a duplicate.'
      )
    )
  }

  const rapidRepeats = input.priorTransactions.filter((transaction) => {
    if (transaction.memberId !== input.memberId || transaction.transactionType !== input.transactionType) {
      return false
    }

    const deltaMs = occurredAtMs - Date.parse(transaction.occurredAt)
    return deltaMs >= 0 && deltaMs <= LOCAL_FRAUD_RULES.rapidRepeatWindowMs
  })

  if (rapidRepeats.length >= 2) {
    hints.push(
      buildHint(
        'rapid_repeat',
        'warning',
        'This member has multiple recent local captures of the same transaction type.'
      )
    )
  }

  if (
    previousDeviceTransaction &&
    Date.parse(previousDeviceTransaction.clientRecordedAt) - Date.parse(evidence.clientRecordedAt) >
      LOCAL_FRAUD_RULES.deviceClockRegressionToleranceMs
  ) {
    hints.push(
      buildHint(
        'device_clock_regression',
        'critical',
        'This device appears to have captured a newer transaction before this one.'
      )
    )
  }

  const envelopeReuse = input.priorTransactions.find(
    (transaction) =>
      transaction.offlineEnvelopeId === evidence.offlineEnvelopeId &&
      transaction.clientTransactionId !== input.clientTransactionId
  )

  if (envelopeReuse) {
    hints.push(
      buildHint(
        'offline_envelope_reuse',
        'critical',
        'The offline envelope for this capture was already used by a different local transaction.'
      )
    )
  }

  if (input.transactionType === 'withdrawal') {
    const recentWithdrawals = input.priorTransactions.filter((transaction) => {
      if (transaction.memberId !== input.memberId || transaction.transactionType !== 'withdrawal') {
        return false
      }

      const deltaMs = occurredAtMs - Date.parse(transaction.occurredAt)
      return deltaMs >= 0 && deltaMs <= LOCAL_FRAUD_RULES.withdrawalHistoryWindowMs
    })

    const averageWithdrawalMinor = average(recentWithdrawals.map((transaction) => transaction.amountMinor))
    const abnormalThreshold = Math.max(
      LOCAL_FRAUD_RULES.abnormalWithdrawalReviewMinor,
      averageWithdrawalMinor * LOCAL_FRAUD_RULES.abnormalWithdrawalHistoricalMultiplier
    )

    if (input.amountMinor >= abnormalThreshold) {
      hints.push(
        buildHint(
          'abnormal_withdrawal',
          input.amountMinor >= LOCAL_FRAUD_RULES.abnormalWithdrawalBlockOfflineMinor ? 'critical' : 'high',
          'This withdrawal exceeds the local offline review threshold and requires extra caution.'
        )
      )
    }
  }

  return hints
}

export function evaluateWithdrawalGuardrails(
  input: FraudAssessmentInput,
  hints: LocalFraudHint[]
): LocalGuardrailDecision {
  let status: LocalGuardrailStatus = 'clear'
  const messages: string[] = []

  if (input.transactionType !== 'withdrawal') {
    return {
      status,
      title: 'Ready to queue',
      messages,
    }
  }

  if (!input.captureContext.identityConfirmed) {
    status = 'blocked'
    messages.push('Member identity confirmation is required before a withdrawal can be queued.')
  }

  if (!input.captureContext.cashConfirmed) {
    status = 'blocked'
    messages.push('Cash handoff confirmation is required before a withdrawal can be queued.')
  }

  if (
    typeof input.captureContext.availableBalanceMinor === 'number' &&
    input.captureContext.availableBalanceMinor < input.amountMinor
  ) {
    status = 'blocked'
    messages.push('The entered withdrawal exceeds the locally available balance evidence.')
  }

  if (input.captureContext.isOfflineCapture && input.amountMinor >= LOCAL_FRAUD_RULES.abnormalWithdrawalBlockOfflineMinor) {
    status = 'blocked'
    messages.push('High-value withdrawals cannot be finalized locally while the device is offline.')
  }

  if (
    input.captureContext.isOfflineCapture &&
    (hasHint(hints, 'possible_duplicate') || hasHint(hints, 'offline_envelope_reuse') || hasHint(hints, 'device_clock_regression'))
  ) {
    status = 'blocked'
    messages.push('This offline withdrawal matches a local fraud hint and must wait for sync or supervisor review.')
  }

  if (status !== 'blocked' && (hasHint(hints, 'abnormal_withdrawal') || hasHint(hints, 'rapid_repeat'))) {
    status = 'review'
    messages.push('Queueing is allowed, but this withdrawal should be reviewed after sync.')
  }

  return {
    status,
    title:
      status === 'blocked'
        ? 'Offline withdrawal blocked'
        : status === 'review'
          ? 'Offline withdrawal needs review'
          : 'Ready to queue',
    messages,
  }
}

export function assessLocalTransactionCapture(input: FraudAssessmentInput): LocalFraudAssessment {
  const evidence = buildOfflineFraudEvidence(input)
  const hints = deriveLocalFraudHints(input, evidence)
  const guardrail = evaluateWithdrawalGuardrails(input, hints)

  return {
    evidence,
    hints,
    guardrail,
  }
}