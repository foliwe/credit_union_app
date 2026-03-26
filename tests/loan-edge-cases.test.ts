import { describe, expect, it } from 'vitest'

import { migrateDatabase } from '../lib/db/migrations'
import { SqlJsTestDatabase } from '../lib/db/test-database'
import {
  allocateLoanRepayment,
  buildProvisionalLoanSchedule,
} from '../lib/loans/mobile-loans'
import {
  createProvisionalLoanWithQueue,
  getCurrentLoanScheduleSnapshot,
  markCachedLoanStale,
  reconcileCachedLoan,
} from '../lib/db/repositories/loans'
import {
  listOpenSyncConflicts,
  resolveSyncConflict,
} from '../lib/db/repositories/sync-metadata'

describe('mobile loan edge cases', () => {
  it('rejects invalid provisional loan contracts', () => {
    expect(() =>
      buildProvisionalLoanSchedule(
        {
          branchId: 'branch-1',
          productCode: 'BROKEN',
          productName: 'Broken Contract',
          currencyCode: 'KES',
          principalMinor: 0,
          termMonths: 3,
          monthlyInterestRateBps: 250,
          repaymentDayOfMonth: 5,
          interestStrategy: 'monthly_remaining_principal',
          repaymentAllocationStrategy: 'interest_then_principal',
        },
        '2026-03-26T10:00:00.000Z'
      )
    ).toThrow('principalMinor must be a positive integer minor-unit amount')
  })

  it('returns leftover money when a repayment exceeds the outstanding due amounts', () => {
    const result = allocateLoanRepayment('repay-over', 9_000, [
      {
        installmentNumber: 1,
        dueDate: '2026-04-05',
        outstandingInterestMinor: 2_500,
        outstandingPrincipalMinor: 5_000,
      },
    ])

    expect(result.totalAllocatedMinor).toBe(7_500)
    expect(result.remainingAmountMinor).toBe(1_500)
  })

  it('marks stale loans and records non-destructive conflicts during server reconciliation', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const createdLoan = await createProvisionalLoanWithQueue(database, {
      memberId: 'member-2',
      actorId: 'agent-2',
      branchId: 'branch-1',
      deviceInstallationId: 'device-2',
      submittedAt: '2026-03-26T10:00:00.000Z',
      product: {
        branchId: 'branch-1',
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
      queue: {
        operationId: 'op-loan-conflict',
        lastKnownServerVersion: 'server-v6',
      },
    })

    const staleLoan = await markCachedLoanStale(database, {
      clientLoanId: createdLoan.loan.clientLoanId,
      staleAt: '2026-03-27T08:00:00.000Z',
    })

    expect(staleLoan?.syncState).toBe('stale')

    const currentSnapshot = await getCurrentLoanScheduleSnapshot(database, createdLoan.loan.clientLoanId)
    if (!currentSnapshot) {
      throw new Error('Expected a current schedule snapshot')
    }

    const adjustedSchedule = currentSnapshot.schedule.map((installment, index) => {
      if (index !== 0) {
        return installment
      }

      return {
        ...installment,
        outstandingPrincipalMinor: installment.outstandingPrincipalMinor - 5_000,
      }
    })

    const reconciled = await reconcileCachedLoan(database, {
      clientLoanId: createdLoan.loan.clientLoanId,
      serverLoanId: 'server-loan-22',
      serverVersion: 'server-v7',
      reconciledAt: '2026-03-27T09:00:00.000Z',
      status: 'approved',
      outstandingPrincipalMinor: adjustedSchedule.reduce(
        (total, installment) => total + installment.outstandingPrincipalMinor,
        0
      ),
      accruedInterestMinor: adjustedSchedule.reduce(
        (total, installment) => total + installment.outstandingInterestMinor,
        0
      ),
      totalRepaidMinor: 0,
      schedule: adjustedSchedule,
      payload: {
        loanId: 'server-loan-22',
        approvedPrincipalMinor: 75_000,
        reason: 'manager-adjusted-principal',
      },
    })

    expect(reconciled.syncState).toBe('conflict')
    expect(reconciled.serverLoanId).toBe('server-loan-22')

    const conflicts = await listOpenSyncConflicts(database)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ conflictType: 'loan_reconciled_adjustment' })

    const resolved = await resolveSyncConflict(database, conflicts[0]!.id, '2026-03-27T10:00:00.000Z')
    expect(resolved?.resolvedAt).toBe('2026-03-27T10:00:00.000Z')
  })
})