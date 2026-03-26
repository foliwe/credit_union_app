import { describe, expect, it } from 'vitest'

import {
  allocateLoanRepayment,
  buildLoanRepaymentQueuePayload,
  buildProvisionalLoanSchedule,
  calculateMonthlyInterestMinor,
} from '../lib/loans/mobile-loans'

describe('mobile loan calculations', () => {
  it('calculates monthly interest from remaining principal using deterministic minor units', () => {
    expect(calculateMonthlyInterestMinor(100_000, 250)).toBe(2_500)
  })

  it('builds an equal-principal monthly schedule using remaining principal interest', () => {
    const installments = buildProvisionalLoanSchedule(
      {
        branchId: 'branch-1',
        productCode: 'SME-03',
        productName: 'SME Short Cycle',
        currencyCode: 'KES',
        principalMinor: 120_000,
        termMonths: 3,
        monthlyInterestRateBps: 250,
        repaymentDayOfMonth: 5,
        interestStrategy: 'monthly_remaining_principal',
        repaymentAllocationStrategy: 'interest_then_principal',
      },
      '2026-03-26T10:00:00.000Z'
    )

    expect(installments).toEqual([
      expect.objectContaining({ dueDate: '2026-04-05', scheduledInterestMinor: 3_000, scheduledPrincipalMinor: 40_000 }),
      expect.objectContaining({ dueDate: '2026-05-05', scheduledInterestMinor: 2_000, scheduledPrincipalMinor: 40_000 }),
      expect.objectContaining({ dueDate: '2026-06-05', scheduledInterestMinor: 1_000, scheduledPrincipalMinor: 40_000 }),
    ])
  })

  it('allocates repayments to interest before principal in due-date order', () => {
    const result = allocateLoanRepayment('repay-1', 9_000, [
      {
        installmentNumber: 1,
        dueDate: '2026-04-05',
        outstandingInterestMinor: 2_500,
        outstandingPrincipalMinor: 5_000,
      },
      {
        installmentNumber: 2,
        dueDate: '2026-05-05',
        outstandingInterestMinor: 1_500,
        outstandingPrincipalMinor: 5_000,
      },
    ])

    expect(result.remainingAmountMinor).toBe(0)
    expect(result.allocations).toEqual([
      expect.objectContaining({ installmentNumber: 1, component: 'interest', allocatedMinor: 2_500 }),
      expect.objectContaining({ installmentNumber: 1, component: 'principal', allocatedMinor: 5_000 }),
      expect.objectContaining({ installmentNumber: 2, component: 'interest', allocatedMinor: 1_500 }),
    ])
  })

  it('builds repayment payloads with the frozen servicing strategies', () => {
    const payload = buildLoanRepaymentQueuePayload({
      loanId: 'loan-1',
      repaymentId: 'repay-1',
      amountMinor: 9_000,
      currencyCode: 'KES',
      effectiveAt: '2026-04-05T10:00:00.000Z',
      capturedAt: '2026-04-05T10:03:00.000Z',
      installments: [
        {
          installmentNumber: 1,
          dueDate: '2026-04-05',
          outstandingInterestMinor: 2_500,
          outstandingPrincipalMinor: 5_000,
        },
      ],
    })

    expect(payload.interestStrategy).toBe('monthly_remaining_principal')
    expect(payload.repaymentAllocationStrategy).toBe('interest_then_principal')
  })
})