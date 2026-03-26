import { describe, expect, it } from 'vitest'

import { migrateDatabase } from '../lib/db/migrations'
import { openLocalCashSession } from '../lib/db/repositories/agent-cash'
import { createLocalTransactionWithQueue } from '../lib/db/repositories/transactions'
import { SqlJsTestDatabase } from '../lib/db/test-database'

describe('agent cash local limits', () => {
  it('blocks a duplicate same-day session open for the same agent and branch', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    await openLocalCashSession(database, {
      actorId: 'agent-7',
      branchId: 'branch-7',
      deviceInstallationId: 'device-7',
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 12_000,
      maxSessionCarryMinor: 50_000,
      minimumReserveMinor: 4_000,
      openedAt: '2026-03-26T08:00:00.000Z',
      lastKnownServerVersion: null,
    })

    await expect(
      openLocalCashSession(database, {
        actorId: 'agent-7',
        branchId: 'branch-7',
        deviceInstallationId: 'device-7',
        businessDate: '2026-03-26',
        businessTimezone: 'Africa/Nairobi',
        openingFloatMinor: 12_000,
        maxSessionCarryMinor: 50_000,
        minimumReserveMinor: 4_000,
        openedAt: '2026-03-26T09:00:00.000Z',
        lastKnownServerVersion: null,
      })
    ).rejects.toThrow('A local cash session is already open for this agent and business date.')
  })

  it('blocks cash capture when there is no open local cash session for the day', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    await expect(
      createLocalTransactionWithQueue(database, {
        transaction: {
          clientTransactionId: 'deposit-no-session',
          memberId: 'member-7',
          accountId: 'savings-7',
          transactionType: 'deposit',
          amountMinor: 5_000,
          currencyCode: 'KES',
          occurredAt: '2026-03-26T09:00:00.000Z',
          capturedAt: '2026-03-26T09:00:00.000Z',
          payload: { note: 'walk-in deposit' },
          actorId: 'agent-7',
          branchId: 'branch-7',
          deviceInstallationId: 'device-7',
        },
        queue: {
          operationId: 'transaction.create.no-session',
          operationType: 'transaction.create',
          lastKnownServerVersion: null,
        },
      })
    ).rejects.toThrow('Open a local cash session before queueing provisional cash transactions.')
  })

  it('blocks withdrawals that would drive projected cash-on-hand negative', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    await openLocalCashSession(database, {
      actorId: 'agent-8',
      branchId: 'branch-8',
      deviceInstallationId: 'device-8',
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 3_000,
      maxSessionCarryMinor: 50_000,
      minimumReserveMinor: 2_000,
      openedAt: '2026-03-26T08:00:00.000Z',
      lastKnownServerVersion: null,
    })

    await expect(
      createLocalTransactionWithQueue(database, {
        transaction: {
          clientTransactionId: 'withdrawal-negative',
          memberId: 'member-8',
          accountId: 'savings-8',
          transactionType: 'withdrawal',
          amountMinor: 4_000,
          currencyCode: 'KES',
          occurredAt: '2026-03-26T10:00:00.000Z',
          capturedAt: '2026-03-26T10:00:00.000Z',
          payload: { note: 'cash out' },
          actorId: 'agent-8',
          branchId: 'branch-8',
          deviceInstallationId: 'device-8',
          captureContext: {
            isOfflineCapture: true,
            availableBalanceMinor: 10_000,
            identityConfirmed: true,
            cashConfirmed: true,
          },
        },
        queue: {
          operationId: 'transaction.create.negative',
          operationType: 'transaction.create',
          lastKnownServerVersion: null,
        },
      })
    ).rejects.toThrow('This transaction would make projected cash-on-hand negative for the open local session.')
  })

  it('blocks collections that would breach the local carry-limit snapshot', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    await openLocalCashSession(database, {
      actorId: 'agent-9',
      branchId: 'branch-9',
      deviceInstallationId: 'device-9',
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 25_000,
      maxSessionCarryMinor: 30_000,
      minimumReserveMinor: 4_000,
      openedAt: '2026-03-26T08:00:00.000Z',
      lastKnownServerVersion: null,
    })

    await expect(
      createLocalTransactionWithQueue(database, {
        transaction: {
          clientTransactionId: 'deposit-limit',
          memberId: 'member-9',
          accountId: 'savings-9',
          transactionType: 'deposit',
          amountMinor: 6_000,
          currencyCode: 'KES',
          occurredAt: '2026-03-26T11:00:00.000Z',
          capturedAt: '2026-03-26T11:00:00.000Z',
          payload: { note: 'cash collection' },
          actorId: 'agent-9',
          branchId: 'branch-9',
          deviceInstallationId: 'device-9',
        },
        queue: {
          operationId: 'transaction.create.limit',
          operationType: 'transaction.create',
          lastKnownServerVersion: null,
        },
      })
    ).rejects.toThrow('This transaction would exceed the local carry limit snapshot for the open session.')
  })
})