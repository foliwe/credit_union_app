import { describe, expect, it } from 'vitest'

import { migrateDatabase } from '../lib/db/migrations'
import { LOCAL_SCHEMA_VERSION } from '../lib/db/schema'
import { SqlJsTestDatabase } from '../lib/db/test-database'
import {
  getLocalCashSessionDashboard,
  openLocalCashSession,
  saveLocalCashReconciliationDraft,
} from '../lib/db/repositories/agent-cash'
import {
  createProvisionalLoanWithQueue,
  getCachedLoanByClientId,
  getCurrentLoanScheduleSnapshot,
} from '../lib/db/repositories/loans'
import {
  getSyncCheckpoint,
  upsertSyncCheckpoint,
} from '../lib/db/repositories/sync-metadata'
import { getQueueEntryByOperationId, listPendingQueueEntries } from '../lib/db/repositories/queue'
import {
  createLocalTransactionWithQueue,
  getLocalTransactionByClientId,
  listLocalTransactions,
} from '../lib/db/repositories/transactions'

describe('offline database foundation', () => {
  it('migrates to the latest schema and creates the required tables', async () => {
    const database = await SqlJsTestDatabase.create()

    await migrateDatabase(database)

    const tables = await database.getAllAsync<{ name: string }>(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)

    expect(tables.map((table) => table.name)).toEqual([
      'cached_accounts',
      'cached_loan_repayment_outcomes',
      'cached_loan_schedule_snapshots',
      'cached_loans',
      'cached_members',
      'local_agent_cash_conflicts',
      'local_agent_cash_reconciliation_drafts',
      'local_agent_cash_sessions',
      'local_transactions',
      'queue_entries',
      'sync_checkpoints',
      'sync_conflicts',
      'sync_runs',
    ])

    await expect(database.getFirstAsync<{ user_version: number }>('PRAGMA user_version')).resolves.toEqual({
      user_version: LOCAL_SCHEMA_VERSION,
    })
  })

  it('preserves unsynced queue rows across schema upgrades', async () => {
    const database = await SqlJsTestDatabase.create()

    await migrateDatabase(database, 1)
    await database.runAsync(
      `
        INSERT INTO queue_entries (
          id,
          operation_id,
          operation_type,
          local_transaction_id,
          actor_id,
          branch_id,
          device_installation_id,
          payload_json,
          status,
          attempt_count,
          next_attempt_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        'queue-upgrade-1',
        'op-upgrade-1',
        'transaction.create',
        'txn-upgrade-1',
        'actor-1',
        'branch-1',
        'device-1',
        JSON.stringify({ amountMinor: 3000 }),
        'pending',
        0,
        '2026-03-26T09:00:00.000Z',
        '2026-03-26T09:00:00.000Z',
        '2026-03-26T09:00:00.000Z',
      ]
    )

    const restarted = await SqlJsTestDatabase.create(database.export())
    await migrateDatabase(restarted)

    await expect(getQueueEntryByOperationId(restarted, 'op-upgrade-1')).resolves.toMatchObject({
      operationId: 'op-upgrade-1',
      actorId: 'actor-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      lastKnownServerVersion: null,
      status: 'pending',
    })
  })

  it('writes a local transaction row and queue row atomically', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    await openLocalCashSession(database, {
      actorId: 'actor-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 20_000,
      maxSessionCarryMinor: 80_000,
      minimumReserveMinor: 5_000,
      openedAt: '2026-03-26T09:55:00.000Z',
      lastKnownServerVersion: 'server-v3',
    })

    const created = await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'txn-1',
        memberId: 'member-1',
        accountId: 'account-1',
        transactionType: 'deposit',
        amountMinor: 12500,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T10:00:00.000Z',
        capturedAt: '2026-03-26T10:00:00.000Z',
        payload: { note: 'field collection' },
        actorId: 'actor-1',
        branchId: 'branch-1',
        deviceInstallationId: 'device-1',
      },
      queue: {
        operationId: 'op-1',
        operationType: 'transaction.create',
        lastKnownServerVersion: 'server-v3',
      },
    })

    expect(created.transaction.id).toBeTruthy()
    expect(created.queue.localTransactionId).toBe(created.transaction.id)

    await expect(getLocalTransactionByClientId(database, 'txn-1')).resolves.toMatchObject({
      id: created.transaction.id,
      status: 'local_pending',
      actorId: 'actor-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
    })

    await expect(listPendingQueueEntries(database)).resolves.toEqual([
      expect.objectContaining({
        operationId: 'op-1',
        localTransactionId: created.transaction.id,
        actorId: 'actor-1',
        branchId: 'branch-1',
        deviceInstallationId: 'device-1',
        lastKnownServerVersion: 'server-v3',
      }),
    ])
  })

  it('persists provisional cached loans and schedule snapshots across app restart', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const created = await createProvisionalLoanWithQueue(database, {
      memberId: 'member-1',
      actorId: 'actor-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      submittedAt: '2026-03-26T10:00:00.000Z',
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
        operationId: 'op-loan-create-1',
        lastKnownServerVersion: 'server-v6',
      },
    })

    const restarted = await SqlJsTestDatabase.create(database.export())

    await expect(getCachedLoanByClientId(restarted, created.loan.clientLoanId)).resolves.toMatchObject({
      clientLoanId: created.loan.clientLoanId,
      syncState: 'provisional',
      sourceQueueOperationId: 'op-loan-create-1',
    })

    await expect(getCurrentLoanScheduleSnapshot(restarted, created.loan.clientLoanId)).resolves.toMatchObject({
      loanId: created.loan.clientLoanId,
      status: 'current',
      syncState: 'provisional',
      snapshotSequence: 1,
    })
  })

  it('rolls back the local transaction when queue insertion fails', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    await openLocalCashSession(database, {
      actorId: 'actor-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 15_000,
      maxSessionCarryMinor: 80_000,
      minimumReserveMinor: 5_000,
      openedAt: '2026-03-26T09:55:00.000Z',
      lastKnownServerVersion: null,
    })

    await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'txn-1',
        memberId: 'member-1',
        accountId: 'account-1',
        transactionType: 'deposit',
        amountMinor: 1000,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T10:00:00.000Z',
        capturedAt: '2026-03-26T10:00:00.000Z',
        payload: { source: 'cash' },
        actorId: 'actor-1',
        branchId: 'branch-1',
        deviceInstallationId: 'device-1',
      },
      queue: {
        operationId: 'op-duplicate',
        operationType: 'transaction.create',
        lastKnownServerVersion: null,
      },
    })

    await expect(
      createLocalTransactionWithQueue(database, {
        transaction: {
          clientTransactionId: 'txn-2',
          memberId: 'member-2',
          accountId: 'account-2',
          transactionType: 'deposit',
          amountMinor: 500,
          currencyCode: 'KES',
          occurredAt: '2026-03-26T10:05:00.000Z',
          capturedAt: '2026-03-26T10:05:00.000Z',
          payload: { source: 'cash' },
          actorId: 'actor-1',
          branchId: 'branch-1',
          deviceInstallationId: 'device-1',
        },
        queue: {
          operationId: 'op-duplicate',
          operationType: 'transaction.create',
          lastKnownServerVersion: null,
        },
      })
    ).rejects.toThrow()

    await expect(listLocalTransactions(database)).resolves.toHaveLength(1)
    await expect(getLocalTransactionByClientId(database, 'txn-2')).resolves.toBeNull()
    await expect(listPendingQueueEntries(database)).resolves.toHaveLength(1)
  })

  it('persists sync checkpoint metadata across app restart', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    await upsertSyncCheckpoint(database, {
      scope: 'transactions',
      lastPulledAt: '2026-03-26T11:00:00.000Z',
      serverCursor: 'cursor-1',
      lastKnownServerVersion: 'server-v4',
    })

    const restarted = await SqlJsTestDatabase.create(database.export())

    await expect(getSyncCheckpoint(restarted, 'transactions')).resolves.toEqual({
      scope: 'transactions',
      lastPulledAt: '2026-03-26T11:00:00.000Z',
      serverCursor: 'cursor-1',
      lastKnownServerVersion: 'server-v4',
      updatedAt: '2026-03-26T11:00:00.000Z',
    })
  })

  it('persists the local cash session and reconciliation draft across app restart', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const session = await openLocalCashSession(database, {
      actorId: 'agent-4',
      branchId: 'branch-4',
      deviceInstallationId: 'device-4',
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 30_000,
      maxSessionCarryMinor: 90_000,
      minimumReserveMinor: 8_000,
      openedAt: '2026-03-26T08:00:00.000Z',
      lastKnownServerVersion: 'server-v4',
      authoritativeSnapshot: {
        sessionId: 'server-session-4',
        businessDate: '2026-03-26',
        businessTimezone: 'Africa/Nairobi',
        openingFloatMinor: 30_000,
        expectedClosingCashMinor: 30_000,
        maxSessionCarryMinor: 90_000,
        minimumReserveMinor: 8_000,
        serverVersion: 'server-v4',
      },
    })

    await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'txn-cash-1',
        memberId: 'member-4',
        accountId: 'savings-4',
        transactionType: 'deposit',
        amountMinor: 12_000,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T09:00:00.000Z',
        capturedAt: '2026-03-26T09:00:00.000Z',
        payload: { note: 'school fees collection' },
        actorId: 'agent-4',
        branchId: 'branch-4',
        deviceInstallationId: 'device-4',
      },
      queue: {
        operationId: 'transaction.create.cash-1',
        operationType: 'transaction.create',
        lastKnownServerVersion: 'server-v4',
      },
    })

    await saveLocalCashReconciliationDraft(database, {
      sessionId: session.id,
      declaredCashMinor: 41_500,
      notes: 'One note pending branch confirmation.',
      counts: { notes_1000: 10, notes_500: 5 },
      lastKnownServerVersion: 'server-v4',
      savedAt: '2026-03-26T17:00:00.000Z',
    })

    const restarted = await SqlJsTestDatabase.create(database.export())
    const dashboard = await getLocalCashSessionDashboard(restarted, {
      actorId: 'agent-4',
      branchId: 'branch-4',
      businessDate: '2026-03-26',
    })

    expect(dashboard).not.toBeNull()
    expect(dashboard?.session).toMatchObject({
      id: session.id,
      serverSessionId: 'server-session-4',
      businessDate: '2026-03-26',
      openingFloatMinor: 30_000,
    })
    expect(dashboard?.summary).toMatchObject({
      dailyCollectionsMinor: 12_000,
      dailyWithdrawalsMinor: 0,
      projectedCashOnHandMinor: 42_000,
      authoritativeExpectedClosingCashMinor: 30_000,
      reconciliationRequired: true,
    })
    expect(dashboard?.draft).toMatchObject({
      declaredCashMinor: 41_500,
      projectedCashOnHandMinor: 42_000,
      varianceMinor: -500,
      notes: 'One note pending branch confirmation.',
    })
  })
})