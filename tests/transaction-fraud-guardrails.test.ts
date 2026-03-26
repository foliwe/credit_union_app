import { describe, expect, it } from 'vitest'

import { migrateDatabase } from '../lib/db/migrations'
import { openLocalCashSession } from '../lib/db/repositories/agent-cash'
import { listPendingQueueEntries } from '../lib/db/repositories/queue'
import {
  assessLocalTransactionCaptureWithHistory,
  createLocalTransactionWithQueue,
} from '../lib/db/repositories/transactions'
import { SqlJsTestDatabase } from '../lib/db/test-database'

describe('mobile transaction fraud capture', () => {
  it('captures richer offline evidence for queued mobile transactions', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    await openLocalCashSession(database, {
      actorId: 'agent-9',
      branchId: 'branch-9',
      deviceInstallationId: 'device-9',
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 20_000,
      maxSessionCarryMinor: 100_000,
      minimumReserveMinor: 8_000,
      openedAt: '2026-03-26T08:00:00.000Z',
      lastKnownServerVersion: 'server-v9',
    })

    const created = await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'txn-fraud-1',
        memberId: 'member-9',
        accountId: 'savings-9',
        transactionType: 'deposit',
        amountMinor: 12_500,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T10:00:00.000Z',
        capturedAt: '2026-03-26T10:00:00.000Z',
        payload: { note: 'market collection' },
        actorId: 'agent-9',
        branchId: 'branch-9',
        deviceInstallationId: 'device-9',
      },
      queue: {
        operationId: 'transaction.create.1',
        operationType: 'transaction.create',
        lastKnownServerVersion: 'server-v9',
      },
    })

    expect(created.transaction.fraudEvidence).toMatchObject({
      clientRecordedAt: '2026-03-26T10:00:00.000Z',
      sourceChannel: 'mobile_offline_sync',
      queueOperationId: 'transaction.create.1',
    })
    expect(created.transaction.offlineEnvelopeId).toContain('transaction.create.1')
    expect(created.transaction.integrityHash).toMatch(/^fnv1a_/)
    expect(created.transaction.guardrailStatus).toBe('clear')

    const queueEntries = await listPendingQueueEntries(database)
    expect(queueEntries[0]).toMatchObject({
      operationId: 'transaction.create.1',
      guardrailStatus: 'clear',
    })
    expect(queueEntries[0]?.payload).toMatchObject({
      clientRecordedAt: '2026-03-26T10:00:00.000Z',
      offlineEnvelopeId: created.transaction.offlineEnvelopeId,
      integrityHash: created.transaction.integrityHash,
    })
  })

  it('records local duplicate and offline manipulation hints when evidence is inconsistent', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    await openLocalCashSession(database, {
      actorId: 'agent-7',
      branchId: 'branch-7',
      deviceInstallationId: 'device-7',
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 20_000,
      maxSessionCarryMinor: 100_000,
      minimumReserveMinor: 8_000,
      openedAt: '2026-03-26T08:00:00.000Z',
      lastKnownServerVersion: 'server-v1',
    })

    await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'txn-base',
        memberId: 'member-7',
        accountId: 'savings-7',
        transactionType: 'deposit',
        amountMinor: 8_000,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T11:00:00.000Z',
        capturedAt: '2026-03-26T11:00:00.000Z',
        payload: { note: 'first capture' },
        actorId: 'agent-7',
        branchId: 'branch-7',
        deviceInstallationId: 'device-7',
        captureContext: {
          isOfflineCapture: true,
          offlineEnvelopeId: 'envelope-shared',
        },
      },
      queue: {
        operationId: 'transaction.create.base',
        operationType: 'transaction.create',
        lastKnownServerVersion: 'server-v1',
      },
    })

    const assessment = await assessLocalTransactionCaptureWithHistory(database, {
      transaction: {
        clientTransactionId: 'txn-second',
        memberId: 'member-7',
        accountId: 'savings-7',
        transactionType: 'deposit',
        amountMinor: 8_000,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T11:03:00.000Z',
        capturedAt: '2026-03-26T10:50:00.000Z',
        payload: { note: 'second capture' },
        actorId: 'agent-7',
        branchId: 'branch-7',
        deviceInstallationId: 'device-7',
        captureContext: {
          isOfflineCapture: true,
          offlineEnvelopeId: 'envelope-shared',
        },
      },
      queue: {
        operationId: 'transaction.create.second',
        operationType: 'transaction.create',
        lastKnownServerVersion: 'server-v1',
      },
    })

    expect(assessment.hints.map((hint) => hint.code)).toEqual(
      expect.arrayContaining(['possible_duplicate', 'offline_envelope_reuse', 'device_clock_regression'])
    )
  })

  it('blocks abnormal offline withdrawals before they are stored locally', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    await openLocalCashSession(database, {
      actorId: 'agent-2',
      branchId: 'branch-2',
      deviceInstallationId: 'device-2',
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 200_000,
      maxSessionCarryMinor: 300_000,
      minimumReserveMinor: 10_000,
      openedAt: '2026-03-26T08:00:00.000Z',
      lastKnownServerVersion: 'server-v2',
    })

    await expect(
      createLocalTransactionWithQueue(database, {
        transaction: {
          clientTransactionId: 'txn-withdraw-blocked',
          memberId: 'member-2',
          accountId: 'savings-2',
          transactionType: 'withdrawal',
          amountMinor: 120_000,
          currencyCode: 'KES',
          occurredAt: '2026-03-26T12:00:00.000Z',
          capturedAt: '2026-03-26T12:00:00.000Z',
          payload: { note: 'cash withdrawal' },
          actorId: 'agent-2',
          branchId: 'branch-2',
          deviceInstallationId: 'device-2',
          captureContext: {
            isOfflineCapture: true,
            availableBalanceMinor: 200_000,
            identityConfirmed: true,
            cashConfirmed: true,
          },
        },
        queue: {
          operationId: 'transaction.create.withdrawal',
          operationType: 'transaction.create',
          lastKnownServerVersion: 'server-v2',
        },
      })
    ).rejects.toThrow('High-value withdrawals cannot be finalized locally while the device is offline.')
  })
})