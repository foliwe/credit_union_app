import { describe, expect, it } from 'vitest'

import { migrateDatabase } from '../lib/db/migrations'
import {
  getLocalCashSessionDashboard,
  openLocalCashSession,
  queueLocalCashReconciliationSubmission,
  recordLocalCashConflict,
  saveLocalCashReconciliationDraft,
} from '../lib/db/repositories/agent-cash'
import { createLocalTransactionWithQueue } from '../lib/db/repositories/transactions'
import { SqlJsTestDatabase } from '../lib/db/test-database'

describe('agent cash local state', () => {
  it('computes projected cash-on-hand from opening float, collections, and withdrawals', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    await openLocalCashSession(database, {
      actorId: 'agent-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 25_000,
      maxSessionCarryMinor: 90_000,
      minimumReserveMinor: 6_000,
      openedAt: '2026-03-26T08:00:00.000Z',
      lastKnownServerVersion: 'server-v1',
      authoritativeSnapshot: {
        sessionId: 'server-session-1',
        businessDate: '2026-03-26',
        businessTimezone: 'Africa/Nairobi',
        openingFloatMinor: 25_000,
        expectedClosingCashMinor: 25_000,
        maxSessionCarryMinor: 90_000,
        minimumReserveMinor: 6_000,
        serverVersion: 'server-v1',
      },
    })

    await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'deposit-1',
        memberId: 'member-1',
        accountId: 'savings-1',
        transactionType: 'deposit',
        amountMinor: 14_000,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T09:00:00.000Z',
        capturedAt: '2026-03-26T09:00:00.000Z',
        payload: { note: 'market collection' },
        actorId: 'agent-1',
        branchId: 'branch-1',
        deviceInstallationId: 'device-1',
      },
      queue: {
        operationId: 'transaction.create.deposit-1',
        operationType: 'transaction.create',
        lastKnownServerVersion: 'server-v1',
      },
    })

    await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'withdrawal-1',
        memberId: 'member-1',
        accountId: 'savings-1',
        transactionType: 'withdrawal',
        amountMinor: 4_500,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T10:00:00.000Z',
        capturedAt: '2026-03-26T10:00:00.000Z',
        payload: { note: 'member withdrawal' },
        actorId: 'agent-1',
        branchId: 'branch-1',
        deviceInstallationId: 'device-1',
        captureContext: {
          isOfflineCapture: true,
          availableBalanceMinor: 40_000,
          identityConfirmed: true,
          cashConfirmed: true,
        },
      },
      queue: {
        operationId: 'transaction.create.withdrawal-1',
        operationType: 'transaction.create',
        lastKnownServerVersion: 'server-v1',
      },
    })

    const dashboard = await getLocalCashSessionDashboard(database, {
      actorId: 'agent-1',
      branchId: 'branch-1',
      businessDate: '2026-03-26',
    })

    expect(dashboard?.summary).toMatchObject({
      openingFloatMinor: 25_000,
      dailyCollectionsMinor: 14_000,
      dailyWithdrawalsMinor: 4_500,
      projectedCashOnHandMinor: 34_500,
      authoritativeExpectedClosingCashMinor: 25_000,
      authoritativeDeltaMinor: 9_500,
      limitStatus: 'within_limit',
      reconciliationRequired: true,
      localTotalsAreProvisional: true,
    })
  })

  it('preserves reconciliation drafts, queue intents, and local conflicts without destructive overwrite', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const session = await openLocalCashSession(database, {
      actorId: 'agent-2',
      branchId: 'branch-2',
      deviceInstallationId: 'device-2',
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 18_000,
      maxSessionCarryMinor: 50_000,
      minimumReserveMinor: 5_000,
      openedAt: '2026-03-26T08:00:00.000Z',
      lastKnownServerVersion: 'server-v2',
    })

    await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'deposit-2',
        memberId: 'member-2',
        accountId: 'savings-2',
        transactionType: 'deposit',
        amountMinor: 9_000,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T09:15:00.000Z',
        capturedAt: '2026-03-26T09:15:00.000Z',
        payload: { note: 'daily collection' },
        actorId: 'agent-2',
        branchId: 'branch-2',
        deviceInstallationId: 'device-2',
      },
      queue: {
        operationId: 'transaction.create.deposit-2',
        operationType: 'transaction.create',
        lastKnownServerVersion: 'server-v2',
      },
    })

    const draft = await saveLocalCashReconciliationDraft(database, {
      sessionId: session.id,
      declaredCashMinor: 26_500,
      notes: 'Draft ready for later sync.',
      counts: { notes_1000: 20, notes_500: 13 },
      lastKnownServerVersion: 'server-v2',
      savedAt: '2026-03-26T17:00:00.000Z',
    })

    const submission = await queueLocalCashReconciliationSubmission(database, {
      sessionId: session.id,
      declaredCashMinor: draft.declaredCashMinor,
      notes: draft.notes,
      counts: draft.counts,
      actorId: 'agent-2',
      branchId: 'branch-2',
      deviceInstallationId: 'device-2',
      operationId: 'agent.cash.reconcile.submit.2',
      lastKnownServerVersion: 'server-v2',
      queuedAt: '2026-03-26T17:05:00.000Z',
    })

    await recordLocalCashConflict(database, {
      sessionId: session.id,
      queueOperationId: submission.queue.operationId,
      conflictType: 'reconciliation_mismatch',
      localPayload: { declaredCashMinor: 26_500 },
      serverPayload: { expectedClosingCashMinor: 27_000 },
      createdAt: '2026-03-26T17:10:00.000Z',
    })

    const restarted = await SqlJsTestDatabase.create(database.export())
    const dashboard = await getLocalCashSessionDashboard(restarted, {
      actorId: 'agent-2',
      branchId: 'branch-2',
      businessDate: '2026-03-26',
    })

    expect(dashboard?.draft).toMatchObject({
      sessionId: session.id,
      queueOperationId: 'agent.cash.reconcile.submit.2',
      declaredCashMinor: 26_500,
    })
    expect(dashboard?.conflicts).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        queueOperationId: 'agent.cash.reconcile.submit.2',
        conflictType: 'reconciliation_mismatch',
      }),
    ])
  })
})