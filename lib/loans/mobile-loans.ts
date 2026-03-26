import type {
  LoanInstallmentSnapshot,
  LoanInterestStrategy,
  LoanProductContract,
  LoanRepaymentAllocationStrategy,
  LoanRepaymentPayload,
} from '../types/offline'

export const LOCAL_LOAN_SYNC_STATES = ['authoritative', 'provisional', 'stale', 'conflict'] as const

export type LocalLoanSyncState = (typeof LOCAL_LOAN_SYNC_STATES)[number]

export type LoanScheduleProjection = LoanInstallmentSnapshot & {
  scheduledInterestMinor: number
  scheduledPrincipalMinor: number
  totalDueMinor: number
}

export type LoanRepaymentAllocation = {
  repaymentId: string
  installmentNumber: number
  dueDate: string
  component: 'interest' | 'principal'
  allocatedMinor: number
  allocationOrder: number
}

export type LoanRepaymentOutcome = {
  loanId: string
  repaymentId: string
  allocations: LoanRepaymentAllocation[]
  totalAllocatedMinor: number
  remainingAmountMinor: number
  resultingInstallments: LoanScheduleProjection[]
  resultingOutstandingPrincipalMinor: number
  resultingAccruedInterestMinor: number
}

export type LoanCreateQueuePayload = LoanProductContract & {
  loanId: string
  memberId: string
  submittedAt: string
  firstDueDate: string
  status: 'pending_review'
  currentSchedule: {
    snapshotSequence: number
    effectiveFrom: string
    generatedAt: string
    installments: LoanScheduleProjection[]
  }
  metadata?: Record<string, unknown>
}

export type LoanRepaymentCaptureInput = {
  loanId: string
  repaymentId: string
  amountMinor: number
  currencyCode: string
  effectiveAt: string
  capturedAt: string
  installments: LoanInstallmentSnapshot[]
  interestStrategy?: LoanInterestStrategy
  repaymentAllocationStrategy?: LoanRepaymentAllocationStrategy
}

export type MobileLoanPreview = {
  loanId: string
  memberId: string
  memberLabel: string
  productName: string
  currencyCode: string
  principalMinor: number
  outstandingPrincipalMinor: number
  accruedInterestMinor: number
  totalRepaidMinor: number
  status: 'draft' | 'pending_review' | 'approved' | 'active' | 'closed' | 'rejected' | 'written_off'
  syncState: LocalLoanSyncState
  queueOperationId: string | null
  firstDueDate: string
  lastReconciledAt: string | null
  staleAt: string | null
  conflictReason: string | null
  installments: LoanScheduleProjection[]
}

function assertNonNegativeInteger(value: number, fieldName: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer minor-unit amount`)
  }
}

function assertPositiveInteger(value: number, fieldName: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer minor-unit amount`)
  }
}

function addMonths(baseDate: Date, monthsToAdd: number, repaymentDayOfMonth: number) {
  return new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() + monthsToAdd, repaymentDayOfMonth))
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function buildCreateId(prefix: string) {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}_${token}`
}

function sortInstallments<T extends LoanInstallmentSnapshot>(installments: T[]) {
  return [...installments].sort((left, right) => {
    if (left.dueDate === right.dueDate) {
      return left.installmentNumber - right.installmentNumber
    }

    return left.dueDate.localeCompare(right.dueDate)
  })
}

export function calculateMonthlyInterestMinor(principalMinor: number, monthlyInterestRateBps: number) {
  assertNonNegativeInteger(principalMinor, 'principalMinor')

  if (!Number.isInteger(monthlyInterestRateBps) || monthlyInterestRateBps < 0) {
    throw new Error('monthlyInterestRateBps must be a non-negative integer')
  }

  return Math.floor((principalMinor * monthlyInterestRateBps + 5_000) / 10_000)
}

export function buildProvisionalLoanSchedule(
  product: LoanProductContract,
  submittedAt: string,
  firstDueDate?: string
): LoanScheduleProjection[] {
  assertPositiveInteger(product.principalMinor, 'principalMinor')

  if (!Number.isInteger(product.termMonths) || product.termMonths <= 0) {
    throw new Error('termMonths must be a positive integer')
  }

  if (!Number.isInteger(product.repaymentDayOfMonth) || product.repaymentDayOfMonth < 1 || product.repaymentDayOfMonth > 28) {
    throw new Error('repaymentDayOfMonth must be between 1 and 28')
  }

  const submittedDate = new Date(submittedAt)
  if (Number.isNaN(submittedDate.getTime())) {
    throw new Error('submittedAt must be a valid ISO timestamp')
  }

  const basePrincipalMinor = Math.floor(product.principalMinor / product.termMonths)
  const finalPrincipalRemainderMinor = product.principalMinor - basePrincipalMinor * product.termMonths
  let remainingPrincipalMinor = product.principalMinor

  return Array.from({ length: product.termMonths }, (_, index) => {
    const installmentNumber = index + 1
    const scheduledPrincipalMinor =
      installmentNumber === product.termMonths
        ? basePrincipalMinor + finalPrincipalRemainderMinor
        : basePrincipalMinor
    const scheduledInterestMinor = calculateMonthlyInterestMinor(
      remainingPrincipalMinor,
      product.monthlyInterestRateBps
    )
    const dueDate =
      firstDueDate && installmentNumber === 1
        ? firstDueDate
        : toIsoDate(addMonths(submittedDate, installmentNumber, product.repaymentDayOfMonth))

    remainingPrincipalMinor -= scheduledPrincipalMinor

    return {
      installmentNumber,
      dueDate,
      outstandingInterestMinor: scheduledInterestMinor,
      outstandingPrincipalMinor: scheduledPrincipalMinor,
      scheduledInterestMinor,
      scheduledPrincipalMinor,
      totalDueMinor: scheduledInterestMinor + scheduledPrincipalMinor,
    }
  })
}

export function allocateLoanRepayment(
  repaymentId: string,
  amountMinor: number,
  installments: LoanInstallmentSnapshot[]
): {
  allocations: LoanRepaymentAllocation[]
  totalAllocatedMinor: number
  remainingAmountMinor: number
} {
  assertPositiveInteger(amountMinor, 'amountMinor')

  let remainingAmountMinor = amountMinor
  let allocationOrder = 1
  const allocations: LoanRepaymentAllocation[] = []

  for (const installment of sortInstallments(installments)) {
    assertNonNegativeInteger(installment.outstandingInterestMinor, 'outstandingInterestMinor')
    assertNonNegativeInteger(installment.outstandingPrincipalMinor, 'outstandingPrincipalMinor')

    if (remainingAmountMinor === 0) {
      break
    }

    const interestAllocationMinor = Math.min(remainingAmountMinor, installment.outstandingInterestMinor)
    if (interestAllocationMinor > 0) {
      allocations.push({
        repaymentId,
        installmentNumber: installment.installmentNumber,
        dueDate: installment.dueDate,
        component: 'interest',
        allocatedMinor: interestAllocationMinor,
        allocationOrder,
      })
      allocationOrder += 1
      remainingAmountMinor -= interestAllocationMinor
    }

    const principalAllocationMinor = Math.min(remainingAmountMinor, installment.outstandingPrincipalMinor)
    if (principalAllocationMinor > 0) {
      allocations.push({
        repaymentId,
        installmentNumber: installment.installmentNumber,
        dueDate: installment.dueDate,
        component: 'principal',
        allocatedMinor: principalAllocationMinor,
        allocationOrder,
      })
      allocationOrder += 1
      remainingAmountMinor -= principalAllocationMinor
    }
  }

  return {
    allocations,
    totalAllocatedMinor: allocations.reduce((total, allocation) => total + allocation.allocatedMinor, 0),
    remainingAmountMinor,
  }
}

export function applyRepaymentToInstallments(
  input: LoanRepaymentCaptureInput
): LoanRepaymentOutcome {
  const { allocations, totalAllocatedMinor, remainingAmountMinor } = allocateLoanRepayment(
    input.repaymentId,
    input.amountMinor,
    input.installments
  )

  const allocationLookup = new Map<string, number>()

  for (const allocation of allocations) {
    const key = `${allocation.installmentNumber}:${allocation.component}`
    allocationLookup.set(key, (allocationLookup.get(key) ?? 0) + allocation.allocatedMinor)
  }

  const resultingInstallments = sortInstallments(input.installments).map((installment) => {
    const allocatedInterestMinor = allocationLookup.get(`${installment.installmentNumber}:interest`) ?? 0
    const allocatedPrincipalMinor = allocationLookup.get(`${installment.installmentNumber}:principal`) ?? 0
    const outstandingInterestMinor = installment.outstandingInterestMinor - allocatedInterestMinor
    const outstandingPrincipalMinor = installment.outstandingPrincipalMinor - allocatedPrincipalMinor

    return {
      installmentNumber: installment.installmentNumber,
      dueDate: installment.dueDate,
      outstandingInterestMinor,
      outstandingPrincipalMinor,
      scheduledInterestMinor: installment.outstandingInterestMinor,
      scheduledPrincipalMinor: installment.outstandingPrincipalMinor,
      totalDueMinor: outstandingInterestMinor + outstandingPrincipalMinor,
    }
  })

  return {
    loanId: input.loanId,
    repaymentId: input.repaymentId,
    allocations,
    totalAllocatedMinor,
    remainingAmountMinor,
    resultingInstallments,
    resultingOutstandingPrincipalMinor: resultingInstallments.reduce(
      (total, installment) => total + installment.outstandingPrincipalMinor,
      0
    ),
    resultingAccruedInterestMinor: resultingInstallments.reduce(
      (total, installment) => total + installment.outstandingInterestMinor,
      0
    ),
  }
}

export function buildLoanCreateQueuePayload(input: {
  loanId?: string
  memberId: string
  submittedAt: string
  product: LoanProductContract
  firstDueDate?: string
  metadata?: Record<string, unknown>
}): LoanCreateQueuePayload {
  const loanId = input.loanId ?? buildCreateId('loan')
  const installments = buildProvisionalLoanSchedule(input.product, input.submittedAt, input.firstDueDate)
  const firstDueDate = installments[0]?.dueDate

  if (!firstDueDate) {
    throw new Error('Loan schedule must include at least one installment')
  }

  return {
    loanId,
    memberId: input.memberId,
    submittedAt: input.submittedAt,
    firstDueDate,
    status: 'pending_review',
    currentSchedule: {
      snapshotSequence: 1,
      effectiveFrom: firstDueDate,
      generatedAt: input.submittedAt,
      installments,
    },
    metadata: input.metadata,
    ...input.product,
  }
}

export function buildLoanRepaymentQueuePayload(input: LoanRepaymentCaptureInput): LoanRepaymentPayload {
  return {
    loanId: input.loanId,
    repaymentId: input.repaymentId,
    amountMinor: input.amountMinor,
    currencyCode: input.currencyCode,
    effectiveAt: input.effectiveAt,
    capturedAt: input.capturedAt,
    installments: input.installments,
    interestStrategy: input.interestStrategy ?? 'monthly_remaining_principal',
    repaymentAllocationStrategy: input.repaymentAllocationStrategy ?? 'interest_then_principal',
  }
}

export function formatMinorCurrency(amountMinor: number, currencyCode: string) {
  const formatter = new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

  return formatter.format(amountMinor / 100)
}

export function createLoanPreviewFromPayload(input: {
  memberLabel: string
  queueOperationId: string | null
  syncState: LocalLoanSyncState
  payload: LoanCreateQueuePayload
  outstandingPrincipalMinor?: number
  accruedInterestMinor?: number
  totalRepaidMinor?: number
  lastReconciledAt?: string | null
  staleAt?: string | null
  conflictReason?: string | null
}): MobileLoanPreview {
  return {
    loanId: input.payload.loanId,
    memberId: input.payload.memberId,
    memberLabel: input.memberLabel,
    productName: input.payload.productName,
    currencyCode: input.payload.currencyCode,
    principalMinor: input.payload.principalMinor,
    outstandingPrincipalMinor:
      input.outstandingPrincipalMinor ??
      input.payload.currentSchedule.installments.reduce(
        (total, installment) => total + installment.outstandingPrincipalMinor,
        0
      ),
    accruedInterestMinor:
      input.accruedInterestMinor ??
      input.payload.currentSchedule.installments.reduce(
        (total, installment) => total + installment.outstandingInterestMinor,
        0
      ),
    totalRepaidMinor: input.totalRepaidMinor ?? 0,
    status: input.payload.status,
    syncState: input.syncState,
    queueOperationId: input.queueOperationId,
    firstDueDate: input.payload.firstDueDate,
    lastReconciledAt: input.lastReconciledAt ?? null,
    staleAt: input.staleAt ?? null,
    conflictReason: input.conflictReason ?? null,
    installments: input.payload.currentSchedule.installments,
  }
}

export function applyRepaymentToPreview(preview: MobileLoanPreview, input: LoanRepaymentCaptureInput): MobileLoanPreview {
  const outcome = applyRepaymentToInstallments(input)

  return {
    ...preview,
    syncState: 'provisional',
    status: preview.status === 'pending_review' ? 'pending_review' : 'active',
    accruedInterestMinor: outcome.resultingAccruedInterestMinor,
    outstandingPrincipalMinor: outcome.resultingOutstandingPrincipalMinor,
    totalRepaidMinor: preview.totalRepaidMinor + outcome.totalAllocatedMinor,
    installments: outcome.resultingInstallments,
  }
}

export function createDemoLoanPreviews(branchId: string | null): MobileLoanPreview[] {
  const now = '2026-03-26T09:00:00.000Z'
  const activePayload = buildLoanCreateQueuePayload({
    loanId: 'loan_demo_authoritative',
    memberId: 'member-100',
    submittedAt: now,
    product: {
      branchId: branchId ?? 'branch-demo',
      productCode: 'SME-06',
      productName: 'SME Growth',
      currencyCode: 'KES',
      principalMinor: 120_000,
      termMonths: 6,
      monthlyInterestRateBps: 250,
      repaymentDayOfMonth: 5,
      interestStrategy: 'monthly_remaining_principal',
      repaymentAllocationStrategy: 'interest_then_principal',
    },
  })

  const provisionalPayload = buildLoanCreateQueuePayload({
    loanId: 'loan_demo_provisional',
    memberId: 'member-204',
    submittedAt: now,
    product: {
      branchId: branchId ?? 'branch-demo',
      productCode: 'AGRI-04',
      productName: 'Harvest Bridge',
      currencyCode: 'KES',
      principalMinor: 80_000,
      termMonths: 4,
      monthlyInterestRateBps: 300,
      repaymentDayOfMonth: 18,
      interestStrategy: 'monthly_remaining_principal',
      repaymentAllocationStrategy: 'interest_then_principal',
    },
  })

  return [
    createLoanPreviewFromPayload({
      memberLabel: 'Amina N.',
      queueOperationId: null,
      syncState: 'authoritative',
      payload: activePayload,
      outstandingPrincipalMinor: 60_000,
      accruedInterestMinor: 2_250,
      totalRepaidMinor: 64_500,
      lastReconciledAt: '2026-03-26T08:30:00.000Z',
    }),
    createLoanPreviewFromPayload({
      memberLabel: 'Brian O.',
      queueOperationId: 'queue_local_loan_1',
      syncState: 'provisional',
      payload: provisionalPayload,
    }),
    createLoanPreviewFromPayload({
      memberLabel: 'Doris K.',
      queueOperationId: null,
      syncState: 'stale',
      payload: activePayload,
      outstandingPrincipalMinor: 40_000,
      accruedInterestMinor: 1_000,
      totalRepaidMinor: 81_000,
      staleAt: '2026-03-24T19:00:00.000Z',
      lastReconciledAt: '2026-03-24T19:00:00.000Z',
    }),
    createLoanPreviewFromPayload({
      memberLabel: 'Esther M.',
      queueOperationId: 'queue_conflict_1',
      syncState: 'conflict',
      payload: provisionalPayload,
      conflictReason: 'Server reduced the approved principal after review.',
      outstandingPrincipalMinor: 72_000,
      accruedInterestMinor: 2_400,
      totalRepaidMinor: 8_000,
      lastReconciledAt: '2026-03-26T07:45:00.000Z',
    }),
  ]
}