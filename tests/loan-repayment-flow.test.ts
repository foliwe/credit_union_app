import { describe, expect, it } from 'vitest'

import { migrateDatabase } from '../lib/db/migrations'
import { SqlJsTestDatabase } from '../lib/db/test-database'
import {
  createProvisionalLoanWithQueue,
  getCachedLoanByClientId,
  getCurrentLoanScheduleSnapshot,
  listLoanRepaymentOutcomes,
} from '../lib/db/repositories/loans'
import { listPendingQueueEntries } from '../lib/db/repositories/queue'
import { createLoanRepaymentWithQueue } from '../lib/db/repositories/transactions'

describe('mobile loan repayment flow', () => {
  it('stores provisional loan creation and repayment outcomes for later reconciliation', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const createdLoan = await createProvisionalLoanWithQueue(database, {
      memberId: 'member-1',
      actorId: 'agent-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      submittedAt: '2026-03-26T10:00:00.000Z',
      product: {
        branchId: 'branch-1',
        productCode: 'SME-03',
        productName: 'SME Short Cycle',
        currencyCode: 'KES',
        principalMinor: 60_000,
        termMonths: 3,
        monthlyInterestRateBps: 250,
        repaymentDayOfMonth: 5,
        interestStrategy: 'monthly_remaining_principal',
        repaymentAllocationStrategy: 'interest_then_principal',
      },
      queue: {
        operationId: 'op-loan-1',
        lastKnownServerVersion: 'server-v6',
      },
    })

    const snapshot = await getCurrentLoanScheduleSnapshot(database, createdLoan.loan.clientLoanId)
    if (!snapshot) {
      throw new Error('Expected a current loan schedule snapshot')
    }

    const repayment = await createLoanRepaymentWithQueue(database, {
      loanId: createdLoan.loan.clientLoanId,
      memberId: 'member-1',
      accountId: 'loan-account-1',
      amountMinor: 23_000,
      currencyCode: 'KES',
      effectiveAt: '2026-04-05T10:00:00.000Z',
      capturedAt: '2026-04-05T10:01:00.000Z',
      actorId: 'agent-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      queueOperationId: 'op-repay-1',
      lastKnownServerVersion: 'server-v6',
      installments: snapshot.schedule,
    })

    expect(repayment.repaymentPayload.repaymentAllocationStrategy).toBe('interest_then_principal')
    expect(repayment.transaction.fraudEvidence.sourceChannel).toBe('mobile_offline_sync')
    expect(repayment.transaction.integrityHash).toMatch(/^fnv1a_/) 

    const loanAfterRepayment = await getCachedLoanByClientId(database, createdLoan.loan.clientLoanId)
    const latestSnapshot = await getCurrentLoanScheduleSnapshot(database, createdLoan.loan.clientLoanId)
    const outcomes = await listLoanRepaymentOutcomes(database, createdLoan.loan.clientLoanId)
    const queueEntries = await listPendingQueueEntries(database)

    expect(loanAfterRepayment).toMatchObject({
      syncState: 'provisional',
      totalRepaidMinor: 23_000,
      outstandingPrincipalMinor: 39_500,
      accruedInterestMinor: 500,
    })
    expect(latestSnapshot).toMatchObject({ snapshotSequence: 2, syncState: 'provisional' })
    expect(outcomes).toEqual([
      expect.objectContaining({
        queueOperationId: 'op-repay-1',
        totalAllocatedMinor: 23_000,
        remainingAmountMinor: 0,
        resultingOutstandingPrincipalMinor: 39_500,
        resultingAccruedInterestMinor: 500,
      }),
    ])
    expect(queueEntries.map((entry) => entry.operationId)).toEqual(['op-loan-1', 'op-repay-1'])
  })
})