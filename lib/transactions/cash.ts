import type {
  AgentCashAdjustmentDirection,
  LocalAgentCashLimitStatus,
  LocalAgentCashSessionRecord,
  LocalAgentCashSummary,
  LocalTransactionRecord,
  TransactionType,
} from '../types/offline'

type CashTransactionLike = Pick<LocalTransactionRecord, 'transactionType' | 'amountMinor' | 'payload'>

export function requiresLocalCashSession(transactionType: TransactionType) {
  return transactionType === 'deposit' || transactionType === 'withdrawal' || transactionType === 'adjustment'
}

function readAdjustmentDirection(payload: Record<string, unknown>): AgentCashAdjustmentDirection | null {
  if (payload.direction === 'in' || payload.direction === 'out') {
    return payload.direction
  }

  return null
}

export function getCashDeltaMinor(transaction: CashTransactionLike) {
  if (transaction.transactionType === 'deposit' || transaction.transactionType === 'repayment') {
    return transaction.amountMinor
  }

  if (transaction.transactionType === 'withdrawal') {
    return -transaction.amountMinor
  }

  if (transaction.transactionType === 'adjustment') {
    const direction = readAdjustmentDirection(transaction.payload)
    if (direction === 'in') {
      return transaction.amountMinor
    }

    if (direction === 'out') {
      return -transaction.amountMinor
    }
  }

  return 0
}

export function deriveCashMovementTotals(transactions: CashTransactionLike[]) {
  let dailyCollectionsMinor = 0
  let dailyWithdrawalsMinor = 0

  for (const transaction of transactions) {
    const deltaMinor = getCashDeltaMinor(transaction)

    if (deltaMinor > 0) {
      dailyCollectionsMinor += deltaMinor
    } else if (deltaMinor < 0) {
      dailyWithdrawalsMinor += Math.abs(deltaMinor)
    }
  }

  return {
    dailyCollectionsMinor,
    dailyWithdrawalsMinor,
  }
}

export function deriveLocalCashLimitStatus(
  projectedCashOnHandMinor: number,
  maxSessionCarryMinor: number | null,
  minimumReserveMinor: number
): { limitStatus: LocalAgentCashLimitStatus; limitMessage: string } {
  if (projectedCashOnHandMinor < 0) {
    return {
      limitStatus: 'negative_cash',
      limitMessage: 'Projected cash-on-hand is negative. This local capture must stay blocked.',
    }
  }

  if (typeof maxSessionCarryMinor === 'number' && projectedCashOnHandMinor > maxSessionCarryMinor) {
    return {
      limitStatus: 'carry_limit_breached',
      limitMessage: 'Projected cash-on-hand exceeds the cached carry limit for this session.',
    }
  }

  if (minimumReserveMinor > 0 && projectedCashOnHandMinor < minimumReserveMinor) {
    return {
      limitStatus: 'reserve_low',
      limitMessage: 'Projected cash-on-hand is below the local reserve buffer snapshot.',
    }
  }

  return {
    limitStatus: 'within_limit',
    limitMessage: 'Projected cash-on-hand stays within the cached local session limits.',
  }
}

export function buildLocalCashSummary(
  session: LocalAgentCashSessionRecord,
  transactions: CashTransactionLike[],
  draftExists: boolean
): LocalAgentCashSummary {
  const { dailyCollectionsMinor, dailyWithdrawalsMinor } = deriveCashMovementTotals(transactions)
  const projectedCashOnHandMinor = session.openingFloatMinor + dailyCollectionsMinor - dailyWithdrawalsMinor
  const { limitStatus, limitMessage } = deriveLocalCashLimitStatus(
    projectedCashOnHandMinor,
    session.maxSessionCarryMinor,
    session.minimumReserveMinor
  )

  return {
    sessionId: session.id,
    businessDate: session.businessDate,
    openingFloatMinor: session.openingFloatMinor,
    dailyCollectionsMinor,
    dailyWithdrawalsMinor,
    projectedCashOnHandMinor,
    maxSessionCarryMinor: session.maxSessionCarryMinor,
    minimumReserveMinor: session.minimumReserveMinor,
    limitStatus,
    limitMessage,
    reconciliationRequired: draftExists || dailyCollectionsMinor > 0 || dailyWithdrawalsMinor > 0,
    authoritativeExpectedClosingCashMinor: session.authoritativeExpectedClosingCashMinor,
    authoritativeCollectionsMinor: session.authoritativeCollectionsMinor,
    authoritativeWithdrawalsMinor: session.authoritativeWithdrawalsMinor,
    authoritativeObservedAt: session.authoritativeObservedAt,
    authoritativeDeltaMinor:
      typeof session.authoritativeExpectedClosingCashMinor === 'number'
        ? projectedCashOnHandMinor - session.authoritativeExpectedClosingCashMinor
        : null,
    localTotalsAreProvisional: true,
  }
}