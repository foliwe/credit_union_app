import { describe, expect, it } from 'vitest'

import { migrateDatabase } from '../lib/db/migrations'
import {
  createProvisionalLoanWithQueue,
  getCachedLoanByClientId,
  getCurrentLoanScheduleSnapshot,
  listLoanRepaymentOutcomes,
  reconcileCachedLoan,
} from '../lib/db/repositories/loans'
import { getQueueEntryByOperationId, updateQueueEntryStatus } from '../lib/db/repositories/queue'
import { listOpenSyncConflicts } from '../lib/db/repositories/sync-metadata'
import { createLoanRepaymentWithQueue } from '../lib/db/repositories/transactions'
import { SqlJsTestDatabase } from '../lib/db/test-database'
import {
  LoanOrchestrationRequestError,
  type LoanOrchestrationRequest,
  type LoanOrchestrationSuccessEnvelope,
} from '../lib/loans/client'
import { runLoanSync } from '../lib/loans/sync'

const SERVER_LOAN_ID_A = '11111111-1111-4111-8111-111111111111'
const SERVER_LOAN_ID_B = '22222222-2222-4222-8222-222222222222'
const SERVER_REPAYMENT_ID = '33333333-3333-4333-8333-333333333333'

function buildServerVersionToken(loanId: string, version: number) {
  return `loan:${loanId}:v${version}`
}

function createCreateResponse(input: {
  clientLoanId: string
  serverLoanId: string
  serverVersion: string
  status?: 'pending_review' | 'approved' | 'active'
  branchId?: string
  schedule: LoanOrchestrationSuccessEnvelope['data']['schedule']
  principalMinor: number
  outstandingPrincipalMinor: number
  accruedInterestMinor: number
  totalRepaidMinor?: number
  replayed?: boolean
}): LoanOrchestrationSuccessEnvelope {
  return {
    ok: true,
    action: 'loan.create',
    operationId: `server.${input.clientLoanId}`,
    replayed: input.replayed ?? false,
    outcome: input.replayed ? 'duplicate' : 'accepted',
    data: {
      branchId: input.branchId ?? 'branch-1',
      serverLoanId: input.serverLoanId,
      serverRepaymentId: null,
      clientLoanId: input.clientLoanId,
      clientRepaymentId: null,
      status: input.status ?? 'pending_review',
      repaymentStatus: null,
      serverVersion: input.serverVersion,
      totals: {
        principalMinor: input.principalMinor,
        outstandingPrincipalMinor: input.outstandingPrincipalMinor,
        accruedInterestMinor: input.accruedInterestMinor,
        totalRepaidMinor: input.totalRepaidMinor ?? 0,
      },
      schedule: input.schedule,
      event: null,
    },
  }
}

function createRepaymentCaptureResponse(input: {
  clientLoanId: string
  clientRepaymentId: string
  serverLoanId: string
  serverRepaymentId: string
  serverVersion: string
  status?: 'active'
  repaymentStatus?: 'pending_review' | 'approved' | 'rejected' | 'applied'
  branchId?: string
  principalMinor: number
  outstandingPrincipalMinor: number
  accruedInterestMinor: number
  totalRepaidMinor: number
  schedule: LoanOrchestrationSuccessEnvelope['data']['schedule']
}): LoanOrchestrationSuccessEnvelope {
  return {
    ok: true,
    action: 'loan.repayment.capture',
    operationId: `server.${input.clientRepaymentId}`,
    replayed: false,
    outcome: 'accepted',
    data: {
      branchId: input.branchId ?? 'branch-1',
      serverLoanId: input.serverLoanId,
      serverRepaymentId: input.serverRepaymentId,
      clientLoanId: input.clientLoanId,
      clientRepaymentId: input.clientRepaymentId,
      status: input.status ?? 'active',
      repaymentStatus: input.repaymentStatus ?? 'pending_review',
      serverVersion: input.serverVersion,
      totals: {
        principalMinor: input.principalMinor,
        outstandingPrincipalMinor: input.outstandingPrincipalMinor,
        accruedInterestMinor: input.accruedInterestMinor,
        totalRepaidMinor: input.totalRepaidMinor,
      },
      schedule: input.schedule,
      event: null,
    },
  }
}

async function seedAuthoritativeLoan(database: SqlJsTestDatabase, input: { clientLoanId?: string; operationId: string }) {
  const created = await createProvisionalLoanWithQueue(database, {
    memberId: 'member-active',
    actorId: 'agent-1',
    branchId: 'branch-1',
    deviceInstallationId: 'device-1',
    submittedAt: '2026-03-26T09:00:00.000Z',
    product: {
      branchId: 'branch-1',
      productCode: 'SME-06',
      productName: 'SME Monthly',
      currencyCode: 'KES',
      principalMinor: 120_000,
      termMonths: 6,
      monthlyInterestRateBps: 250,
      repaymentDayOfMonth: 5,
      interestStrategy: 'monthly_remaining_principal',
      repaymentAllocationStrategy: 'interest_then_principal',
    },
    queue: {
      operationId: input.operationId,
      lastKnownServerVersion: 'legacy-access-token',
    },
    clientLoanId: input.clientLoanId,
  })

  const snapshot = await getCurrentLoanScheduleSnapshot(database, created.loan.clientLoanId)
  if (!snapshot) {
    throw new Error('Expected an authoritative seed snapshot')
  }

  await reconcileCachedLoan(database, {
    clientLoanId: created.loan.clientLoanId,
    serverLoanId: SERVER_LOAN_ID_B,
    serverVersion: buildServerVersionToken(SERVER_LOAN_ID_B, 3),
    reconciledAt: '2026-03-26T09:15:00.000Z',
    status: 'active',
    outstandingPrincipalMinor: snapshot.outstandingPrincipalMinor,
    accruedInterestMinor: snapshot.accruedInterestMinor,
    totalRepaidMinor: 0,
    schedule: snapshot.schedule,
    payload: {
      seeded: true,
      serverLoanId: SERVER_LOAN_ID_B,
    },
  })

  await updateQueueEntryStatus(database, input.operationId, 'synced', '2026-03-26T09:16:00.000Z', 1)

  const loan = await getCachedLoanByClientId(database, created.loan.clientLoanId)
  const currentSnapshot = await getCurrentLoanScheduleSnapshot(database, created.loan.clientLoanId)
  if (!loan || !currentSnapshot) {
    throw new Error('Expected a reconciled authoritative loan')
  }

  return {
    loan,
    schedule: currentSnapshot,
  }
}

describe('mobile loan sync', () => {
  it('drains loan create and repayment queues sequentially and reconciles authoritative results', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const provisionalLoan = await createProvisionalLoanWithQueue(database, {
      memberId: 'member-create',
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
        operationId: 'op-loan-create-sync',
        lastKnownServerVersion: 'legacy-access-token',
      },
    })

    const authoritativeSeed = await seedAuthoritativeLoan(database, { operationId: 'op-loan-active' })
    const repayment = await createLoanRepaymentWithQueue(database, {
      loanId: authoritativeSeed.loan.clientLoanId,
      memberId: authoritativeSeed.loan.memberId,
      accountId: `loan-account:${authoritativeSeed.loan.clientLoanId}`,
      amountMinor: 18_000,
      currencyCode: authoritativeSeed.loan.currencyCode,
      effectiveAt: '2026-04-05T09:00:00.000Z',
      capturedAt: '2026-04-05T09:01:00.000Z',
      actorId: 'agent-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      queueOperationId: 'op-loan-repayment-sync',
      lastKnownServerVersion: 'legacy-access-token',
      installments: authoritativeSeed.schedule.schedule,
    })

    const createSchedule = await getCurrentLoanScheduleSnapshot(database, provisionalLoan.loan.clientLoanId)
    if (!createSchedule) {
      throw new Error('Expected a provisional create schedule')
    }

    const calls: LoanOrchestrationRequest[] = []
    const result = await runLoanSync(database, {
      now: () => '2026-04-06T10:00:00.000Z',
      transport: {
        async invoke(request) {
          calls.push(request)

          if (request.action === 'loan.create') {
            return createCreateResponse({
              clientLoanId: provisionalLoan.loan.clientLoanId,
              serverLoanId: SERVER_LOAN_ID_A,
              serverVersion: buildServerVersionToken(SERVER_LOAN_ID_A, 1),
              principalMinor: provisionalLoan.loan.principalMinor,
              outstandingPrincipalMinor: createSchedule.outstandingPrincipalMinor,
              accruedInterestMinor: createSchedule.accruedInterestMinor,
              schedule: {
                snapshotId: 'server-snapshot-create',
                snapshotSequence: 1,
                generatedAt: '2026-04-06T10:00:00.000Z',
                effectiveFrom: createSchedule.effectiveFrom,
                installments: createSchedule.schedule,
              },
            })
          }

          return createRepaymentCaptureResponse({
            clientLoanId: authoritativeSeed.loan.clientLoanId,
            clientRepaymentId: repayment.repaymentPayload.repaymentId,
            serverLoanId: SERVER_LOAN_ID_B,
            serverRepaymentId: SERVER_REPAYMENT_ID,
            serverVersion: buildServerVersionToken(SERVER_LOAN_ID_B, 4),
            principalMinor: authoritativeSeed.loan.principalMinor,
            outstandingPrincipalMinor: authoritativeSeed.schedule.outstandingPrincipalMinor,
            accruedInterestMinor: authoritativeSeed.schedule.accruedInterestMinor,
            totalRepaidMinor: 0,
            schedule: {
              snapshotId: 'server-snapshot-active',
              snapshotSequence: 3,
              generatedAt: '2026-04-06T10:00:00.000Z',
              effectiveFrom: authoritativeSeed.schedule.effectiveFrom,
              installments: authoritativeSeed.schedule.schedule,
            },
          })
        },
      },
    })

    expect(result).toEqual({ processed: 2, synced: 2, failed: 0, conflicts: 0, replayed: 0 })
    expect(calls.map((request) => request.action)).toEqual(['loan.create', 'loan.repayment.capture'])
    expect(calls[1]).toMatchObject({
      action: 'loan.repayment.capture',
      input: {
        loanId: SERVER_LOAN_ID_B,
        lastKnownServerVersion: buildServerVersionToken(SERVER_LOAN_ID_B, 3),
      },
    })

    const syncedCreateQueue = await getQueueEntryByOperationId(database, 'op-loan-create-sync')
    const syncedRepaymentQueue = await getQueueEntryByOperationId(database, 'op-loan-repayment-sync')
    expect(syncedCreateQueue).toMatchObject({ status: 'synced', attemptCount: 1 })
    expect(syncedRepaymentQueue).toMatchObject({ status: 'synced', attemptCount: 1 })

    const createdLoanAfterSync = await getCachedLoanByClientId(database, provisionalLoan.loan.clientLoanId)
    expect(createdLoanAfterSync).toMatchObject({
      serverLoanId: SERVER_LOAN_ID_A,
      status: 'pending_review',
      syncState: 'authoritative',
      serverVersion: buildServerVersionToken(SERVER_LOAN_ID_A, 1),
    })

    const repaidLoanAfterSync = await getCachedLoanByClientId(database, authoritativeSeed.loan.clientLoanId)
    expect(repaidLoanAfterSync).toMatchObject({
      serverLoanId: SERVER_LOAN_ID_B,
      status: 'active',
      syncState: 'conflict',
      serverVersion: buildServerVersionToken(SERVER_LOAN_ID_B, 4),
      totalRepaidMinor: 0,
    })

    const repaymentOutcomes = await listLoanRepaymentOutcomes(database, authoritativeSeed.loan.clientLoanId)
    expect(repaymentOutcomes).toEqual([
      expect.objectContaining({
        repaymentId: repayment.repaymentPayload.repaymentId,
        status: 'pending_review',
        syncState: 'conflict',
        serverVersion: buildServerVersionToken(SERVER_LOAN_ID_B, 4),
        payload: expect.objectContaining({
          serverRepaymentId: SERVER_REPAYMENT_ID,
          repaymentStatus: 'pending_review',
        }),
      }),
    ])

    const conflicts = await listOpenSyncConflicts(database)
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conflictType: 'loan_repayment_authoritative_adjustment',
          queueEntryId: 'op-loan-repayment-sync',
        }),
      ])
    )
  })

  it('treats duplicate create replays as synced without creating extra conflicts', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const createdLoan = await createProvisionalLoanWithQueue(database, {
      memberId: 'member-replay',
      actorId: 'agent-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      submittedAt: '2026-03-26T10:00:00.000Z',
      product: {
        branchId: 'branch-1',
        productCode: 'SME-03',
        productName: 'SME Short Cycle',
        currencyCode: 'KES',
        principalMinor: 50_000,
        termMonths: 3,
        monthlyInterestRateBps: 250,
        repaymentDayOfMonth: 5,
        interestStrategy: 'monthly_remaining_principal',
        repaymentAllocationStrategy: 'interest_then_principal',
      },
      queue: {
        operationId: 'op-loan-replay',
        lastKnownServerVersion: 'legacy-access-token',
      },
    })

    const schedule = await getCurrentLoanScheduleSnapshot(database, createdLoan.loan.clientLoanId)
    if (!schedule) {
      throw new Error('Expected provisional schedule for replay test')
    }

    const result = await runLoanSync(database, {
      now: () => '2026-04-06T10:30:00.000Z',
      transport: {
        async invoke() {
          return createCreateResponse({
            clientLoanId: createdLoan.loan.clientLoanId,
            serverLoanId: SERVER_LOAN_ID_A,
            serverVersion: buildServerVersionToken(SERVER_LOAN_ID_A, 2),
            principalMinor: createdLoan.loan.principalMinor,
            outstandingPrincipalMinor: schedule.outstandingPrincipalMinor,
            accruedInterestMinor: schedule.accruedInterestMinor,
            schedule: {
              snapshotId: 'server-snapshot-replay',
              snapshotSequence: 1,
              generatedAt: '2026-04-06T10:30:00.000Z',
              effectiveFrom: schedule.effectiveFrom,
              installments: schedule.schedule,
            },
            replayed: true,
          })
        },
      },
    })

    expect(result).toEqual({ processed: 1, synced: 1, failed: 0, conflicts: 0, replayed: 1 })
    await expect(getQueueEntryByOperationId(database, 'op-loan-replay')).resolves.toMatchObject({
      status: 'synced',
      attemptCount: 1,
    })
    await expect(listOpenSyncConflicts(database)).resolves.toEqual([])
  })

  it('records stale-version conflicts for repayment sync and leaves the queue entry in conflict', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const authoritativeSeed = await seedAuthoritativeLoan(database, { operationId: 'op-loan-stale-seed' })
    await createLoanRepaymentWithQueue(database, {
      loanId: authoritativeSeed.loan.clientLoanId,
      memberId: authoritativeSeed.loan.memberId,
      accountId: `loan-account:${authoritativeSeed.loan.clientLoanId}`,
      amountMinor: 12_500,
      currencyCode: authoritativeSeed.loan.currencyCode,
      effectiveAt: '2026-04-07T09:00:00.000Z',
      capturedAt: '2026-04-07T09:05:00.000Z',
      actorId: 'agent-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      queueOperationId: 'op-loan-repayment-stale',
      lastKnownServerVersion: 'legacy-access-token',
      installments: authoritativeSeed.schedule.schedule,
    })

    const calls: LoanOrchestrationRequest[] = []
    const result = await runLoanSync(database, {
      now: () => '2026-04-07T10:00:00.000Z',
      transport: {
        async invoke(request) {
          calls.push(request)
          throw new LoanOrchestrationRequestError('stale_server_version', 'Server version is stale', false, {
            authoritativeServerVersion: buildServerVersionToken(SERVER_LOAN_ID_B, 4),
          })
        },
      },
    })

    expect(result).toEqual({ processed: 1, synced: 0, failed: 0, conflicts: 1, replayed: 0 })
    expect(calls[0]).toMatchObject({
      action: 'loan.repayment.capture',
      input: {
        loanId: SERVER_LOAN_ID_B,
        lastKnownServerVersion: buildServerVersionToken(SERVER_LOAN_ID_B, 3),
      },
    })

    await expect(getQueueEntryByOperationId(database, 'op-loan-repayment-stale')).resolves.toMatchObject({
      status: 'conflict',
      attemptCount: 1,
    })

    const staleLoan = await getCachedLoanByClientId(database, authoritativeSeed.loan.clientLoanId)
    expect(staleLoan?.syncState).toBe('stale')

    const conflicts = await listOpenSyncConflicts(database)
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conflictType: 'loan_queue_stale_server_version',
          queueEntryId: 'op-loan-repayment-stale',
        }),
      ])
    )
  })
})