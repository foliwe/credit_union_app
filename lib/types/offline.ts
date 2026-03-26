export const LOCAL_TRANSACTION_STATUSES = ['local_pending', 'synced_pending', 'approved', 'rejected'] as const

export type LocalTransactionStatus = (typeof LOCAL_TRANSACTION_STATUSES)[number]

export const QUEUE_ENTRY_STATUSES = ['pending', 'processing', 'failed', 'synced', 'conflict'] as const

export type QueueEntryStatus = (typeof QUEUE_ENTRY_STATUSES)[number]

export const TRANSACTION_TYPES = ['deposit', 'withdrawal', 'repayment', 'adjustment'] as const

export type TransactionType = (typeof TRANSACTION_TYPES)[number]

export const LOCAL_FRAUD_HINT_CODES = [
  'possible_duplicate',
  'rapid_repeat',
  'offline_envelope_reuse',
  'device_clock_regression',
  'abnormal_withdrawal',
  'cash_limit_breach',
  'cash_reconciliation_mismatch',
] as const

export type LocalFraudHintCode = (typeof LOCAL_FRAUD_HINT_CODES)[number]

export const LOCAL_GUARDRAIL_STATUSES = ['clear', 'review', 'blocked'] as const

export type LocalGuardrailStatus = (typeof LOCAL_GUARDRAIL_STATUSES)[number]

export const LOAN_INTEREST_STRATEGIES = ['monthly_remaining_principal'] as const

export type LoanInterestStrategy = (typeof LOAN_INTEREST_STRATEGIES)[number]

export const LOAN_REPAYMENT_ALLOCATION_STRATEGIES = ['interest_then_principal'] as const

export type LoanRepaymentAllocationStrategy = (typeof LOAN_REPAYMENT_ALLOCATION_STRATEGIES)[number]

export const LOAN_REPAYMENT_COMPONENTS = ['interest', 'principal'] as const

export type LoanRepaymentComponent = (typeof LOAN_REPAYMENT_COMPONENTS)[number]

export const LOAN_REVIEW_DECISIONS = ['approve', 'reject'] as const

export type LoanReviewDecision = (typeof LOAN_REVIEW_DECISIONS)[number]

export const AGENT_CASH_ACTIONS = [
  'agent.cash.open',
  'agent.cash.current_state',
  'agent.cash.reconcile.submit',
  'agent.cash.reconcile.approve',
  'agent.cash.reconcile.reject',
] as const

export type AgentCashAction = (typeof AGENT_CASH_ACTIONS)[number]

export const AGENT_CASH_CONFLICT_TYPES = [
  'no_open_session',
  'cash_limit_breach',
  'insufficient_cash_on_hand',
  'stale_session_version',
  'reconciliation_mismatch',
] as const

export type AgentCashConflictType = (typeof AGENT_CASH_CONFLICT_TYPES)[number]

export const AGENT_CASH_ADJUSTMENT_DIRECTIONS = ['in', 'out'] as const

export type AgentCashAdjustmentDirection = (typeof AGENT_CASH_ADJUSTMENT_DIRECTIONS)[number]

export const LOCAL_AGENT_CASH_LIMIT_STATUSES = [
  'within_limit',
  'reserve_low',
  'carry_limit_breached',
  'negative_cash',
] as const

export type LocalAgentCashLimitStatus = (typeof LOCAL_AGENT_CASH_LIMIT_STATUSES)[number]

export type AgentCashSessionSnapshot = {
  sessionId: string
  businessDate: string
  businessTimezone: string
  openingFloatMinor: number
  expectedClosingCashMinor: number
  maxSessionCarryMinor: number | null
  minimumReserveMinor: number
  serverVersion: string | null
}

export type AgentCashReconciliationDraft = {
  sessionId: string
  declaredCashMinor: number
  notes?: string
  counts?: Record<string, unknown>
  lastKnownServerVersion: string | null
}

export type LocalAgentCashSessionRecord = {
  id: string
  serverSessionId: string | null
  actorId: string
  branchId: string
  deviceInstallationId: string
  businessDate: string
  businessTimezone: string
  openingFloatMinor: number
  maxSessionCarryMinor: number | null
  minimumReserveMinor: number
  authoritativeExpectedClosingCashMinor: number | null
  authoritativeCollectionsMinor: number | null
  authoritativeWithdrawalsMinor: number | null
  authoritativeObservedAt: string | null
  lastKnownServerVersion: string | null
  openedAt: string
  updatedAt: string
}

export type LocalAgentCashSummary = {
  sessionId: string
  businessDate: string
  openingFloatMinor: number
  dailyCollectionsMinor: number
  dailyWithdrawalsMinor: number
  projectedCashOnHandMinor: number
  maxSessionCarryMinor: number | null
  minimumReserveMinor: number
  limitStatus: LocalAgentCashLimitStatus
  limitMessage: string
  reconciliationRequired: boolean
  authoritativeExpectedClosingCashMinor: number | null
  authoritativeCollectionsMinor: number | null
  authoritativeWithdrawalsMinor: number | null
  authoritativeObservedAt: string | null
  authoritativeDeltaMinor: number | null
  localTotalsAreProvisional: true
}

export type LocalAgentCashReconciliationDraftRecord = {
  id: string
  sessionId: string
  declaredCashMinor: number
  notes: string | null
  counts: Record<string, unknown>
  projectedCashOnHandMinor: number
  varianceMinor: number
  queueOperationId: string | null
  lastKnownServerVersion: string | null
  createdAt: string
  updatedAt: string
}

export type LocalAgentCashConflictRecord = {
  id: string
  sessionId: string
  queueOperationId: string | null
  conflictType: AgentCashConflictType
  serverPayload: Record<string, unknown> | null
  localPayload: Record<string, unknown>
  createdAt: string
  resolvedAt: string | null
}

export type LocalAgentCashDashboard = {
  session: LocalAgentCashSessionRecord
  summary: LocalAgentCashSummary
  draft: LocalAgentCashReconciliationDraftRecord | null
  conflicts: LocalAgentCashConflictRecord[]
}

export type OpenLocalCashSessionInput = {
  actorId: string
  branchId: string
  deviceInstallationId: string
  businessDate: string
  businessTimezone: string
  openingFloatMinor: number
  maxSessionCarryMinor: number | null
  minimumReserveMinor: number
  openedAt: string
  lastKnownServerVersion: string | null
  authoritativeSnapshot?: AgentCashSessionSnapshot | null
}

export type SaveLocalCashReconciliationDraftInput = {
  sessionId: string
  declaredCashMinor: number
  notes?: string
  counts?: Record<string, unknown>
  lastKnownServerVersion: string | null
  savedAt: string
}

export type QueueLocalCashReconciliationSubmissionInput = {
  sessionId: string
  declaredCashMinor: number
  notes?: string | null
  counts?: Record<string, unknown>
  actorId: string
  branchId: string
  deviceInstallationId: string
  operationId: string
  lastKnownServerVersion: string | null
  queuedAt: string
}

export type LoanInstallmentSnapshot = {
  installmentNumber: number
  dueDate: string
  outstandingInterestMinor: number
  outstandingPrincipalMinor: number
}

export type LoanProductContract = {
  branchId: string
  productCode: string
  productName: string
  currencyCode: string
  principalMinor: number
  termMonths: number
  monthlyInterestRateBps: number
  repaymentDayOfMonth: number
  interestStrategy: LoanInterestStrategy
  repaymentAllocationStrategy: LoanRepaymentAllocationStrategy
}

export type LoanRepaymentPayload = {
  loanId: string
  repaymentId: string
  amountMinor: number
  currencyCode: string
  effectiveAt: string
  capturedAt: string
  interestStrategy: LoanInterestStrategy
  repaymentAllocationStrategy: LoanRepaymentAllocationStrategy
  installments: LoanInstallmentSnapshot[]
}

export type LoanAccrualPayload = {
  loanId: string
  accrualDate: string
  principalBasisMinor: number
  monthlyInterestRateBps: number
  interestStrategy: LoanInterestStrategy
  accrualKey: string
}

export type LoanReviewPayload =
  | {
      loanId: string
      decision: 'approve'
      currentStatus: 'pending_review'
      reviewedAt: string
      comment?: string
    }
  | {
      loanId: string
      decision: 'reject'
      currentStatus: 'pending_review'
      reviewedAt: string
      rejectionReason: string
      comment?: string
    }

export type OfflineOperationContext = {
  actorId: string
  branchId: string
  deviceInstallationId: string
  lastKnownServerVersion: string | null
}

export type TransactionCaptureContext = {
  isOfflineCapture: boolean
  availableBalanceMinor?: number | null
  identityConfirmed?: boolean
  cashConfirmed?: boolean
  offlineEnvelopeId?: string | null
  offlineBatchId?: string | null
  integrityHash?: string | null
}

export type OfflineFraudEvidence = {
  clientRecordedAt: string
  offlineEnvelopeId: string
  offlineBatchId: string
  integrityHash: string
  sourceChannel: 'mobile_offline_sync'
  createdWhileOffline: boolean
  lastKnownServerVersion: string | null
  queueOperationId: string
  captureSequence: number
  policyVersion: string
}

export type LocalFraudHint = {
  code: LocalFraudHintCode
  severity: 'warning' | 'high' | 'critical'
  message: string
}

export type LocalGuardrailDecision = {
  status: LocalGuardrailStatus
  title: string
  messages: string[]
}

export type LocalFraudAssessment = {
  evidence: OfflineFraudEvidence
  hints: LocalFraudHint[]
  guardrail: LocalGuardrailDecision
}

export type LocalTransactionRecord = {
  id: string
  clientTransactionId: string
  memberId: string
  accountId: string
  transactionType: TransactionType
  amountMinor: number
  currencyCode: string
  occurredAt: string
  capturedAt: string
  clientRecordedAt: string
  actorId: string
  branchId: string
  deviceInstallationId: string
  offlineEnvelopeId: string
  offlineBatchId: string
  integrityHash: string
  fraudEvidence: OfflineFraudEvidence
  fraudHints: LocalFraudHint[]
  guardrailStatus: LocalGuardrailStatus
  payload: Record<string, unknown>
  status: LocalTransactionStatus
  queueOperationId: string
  createdAt: string
  updatedAt: string
}

export type QueueEntryRecord = {
  id: string
  operationId: string
  operationType: string
  localEntityId: string
  localTransactionId: string
  actorId: string
  branchId: string
  deviceInstallationId: string
  payload: Record<string, unknown>
  status: QueueEntryStatus
  attemptCount: number
  nextAttemptAt: string
  createdAt: string
  updatedAt: string
  lastKnownServerVersion: string | null
  fraudHints: LocalFraudHint[]
  guardrailStatus: LocalGuardrailStatus
  fraudEvidence: OfflineFraudEvidence | null
}

export type SyncCheckpointRecord = {
  scope: string
  lastPulledAt: string | null
  serverCursor: string | null
  lastKnownServerVersion: string | null
  updatedAt: string
}

export type SyncRunRecord = {
  id: string
  status: 'started' | 'completed' | 'failed'
  startedAt: string
  completedAt: string | null
  errorMessage: string | null
  lastKnownServerVersion: string | null
}

export type SyncConflictRecord = {
  id: string
  queueEntryId: string
  localTransactionId: string | null
  conflictType: string
  serverPayload: Record<string, unknown> | null
  localPayload: Record<string, unknown>
  createdAt: string
  resolvedAt: string | null
}

export type CreateLocalTransactionInput = {
  clientTransactionId: string
  memberId: string
  accountId: string
  transactionType: TransactionType
  amountMinor: number
  currencyCode: string
  occurredAt: string
  capturedAt: string
  payload: Record<string, unknown>
  actorId: string
  branchId: string
  deviceInstallationId: string
  captureContext?: TransactionCaptureContext
}

export type CreateQueueEntryInput = {
  operationId: string
  operationType: string
  lastKnownServerVersion: string | null
}

export type CreateLocalTransactionWithQueueInput = {
  transaction: CreateLocalTransactionInput
  queue: CreateQueueEntryInput
}

export type UpsertSyncCheckpointInput = {
  scope: string
  lastPulledAt: string | null
  serverCursor: string | null
  lastKnownServerVersion: string | null
}
