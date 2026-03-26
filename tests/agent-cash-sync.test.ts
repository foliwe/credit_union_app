import { describe, expect, it } from 'vitest'

import { migrateDatabase } from '../lib/db/migrations'
import {
  getLocalCashSessionDashboard,
  openLocalCashSession,
  queueLocalCashReconciliationSubmission,
} from '../lib/db/repositories/agent-cash'
import { getQueueEntryByOperationId } from '../lib/db/repositories/queue'
import { getSyncCheckpoint, listOpenSyncConflicts } from '../lib/db/repositories/sync-metadata'
import {
  createLocalTransactionWithQueue,
  getLocalTransactionByClientId,
} from '../lib/db/repositories/transactions'
import { SqlJsTestDatabase } from '../lib/db/test-database'
import {
  TransactionSyncRequestError,
  type AgentCashRequest,
  type AgentCashSuccessEnvelope,
  type MobileTransactionSyncTransport,
  type TransactionIngestRequest,
  type TransactionIngestResult,
} from '../lib/transactions/client'
import { runTransactionSync } from '../lib/transactions/sync'

const SERVER_SESSION_ID = '11111111-1111-4111-8111-111111111111'

function cashSessionVersion(version: number) {
  return `cash-session:${SERVER_SESSION_ID}:v${version}`
}

function buildCurrentStateEnvelope(input?: Partial<AgentCashSuccessEnvelope>): AgentCashSuccessEnvelope {
  return {
    ok: true,
    action: 'agent.cash.current_state',
    operationId: null,
    replayed: false,
    outcome: 'accepted',
    data: {
      branchId: 'branch-1',
      sessionId: SERVER_SESSION_ID,
      businessDate: '2026-03-26',
      status: 'open',
      serverVersion: cashSessionVersion(2),
      policy: {
        maxSessionCarryMinor: 90_000,
        minimumReserveMinor: 5_000,
        businessTimezone: 'Africa/Nairobi',
      },
      totals: {
        openingFloatMinor: 25_000,
        depositsMinor: 15_000,
        loanRepaymentsMinor: 0,
        cashAdjustmentsInMinor: 0,
        withdrawalsMinor: 0,
        loanDisbursementsMinor: 0,
        cashAdjustmentsOutMinor: 0,
        expectedClosingCashMinor: 40_000,
      },
      reconciliation: null,
    },
    ...input,
  }
}

function buildSubmitEnvelope(input?: Partial<AgentCashSuccessEnvelope>): AgentCashSuccessEnvelope {
  return {
    ok: true,
    action: 'agent.cash.reconcile.submit',
    operationId: 'agent.cash.reconcile.submit.sync',
    replayed: false,
    outcome: 'accepted',
    data: {
      branchId: 'branch-1',
      sessionId: SERVER_SESSION_ID,
      businessDate: '2026-03-26',
      status: 'reconciliation_submitted',
      serverVersion: cashSessionVersion(3),
      policy: {
        maxSessionCarryMinor: 90_000,
        minimumReserveMinor: 5_000,
        businessTimezone: 'Africa/Nairobi',
      },
      totals: {
        openingFloatMinor: 25_000,
        depositsMinor: 15_000,
        loanRepaymentsMinor: 0,
        cashAdjustmentsInMinor: 0,
        withdrawalsMinor: 0,
        loanDisbursementsMinor: 0,
        cashAdjustmentsOutMinor: 0,
        expectedClosingCashMinor: 40_000,
        declaredCashMinor: 40_000,
        mismatchMinor: 0,
      },
      reconciliation: {
        reconciliationId: '22222222-2222-4222-8222-222222222222',
        status: 'submitted',
        declaredCashMinor: 40_000,
        expectedClosingCashMinor: 40_000,
        mismatchMinor: 0,
      },
    },
    ...input,
  }
}

function buildTransactionResult(input?: Partial<TransactionIngestResult>): TransactionIngestResult {
  return {
    status: 'ingested',
    idempotencyKey: 'transaction.create.sync',
    duplicateSignalRecorded: false,
    fraudSignals: [],
    fraudAlerts: [],
    transaction: {
      id: '33333333-3333-4333-8333-333333333333',
      branchId: 'branch-1',
      memberId: 'member-1',
      loanId: null,
      capturedBy: 'agent-1',
      transactionType: 'deposit',
      sourceChannel: 'mobile_offline_sync',
      currencyCode: 'KES',
      amountMinor: 15_000,
      occurredAt: '2026-03-26T17:05:00.000Z',
      clientRecordedAt: '2026-03-26T17:05:00.000Z',
      idempotencyKey: 'transaction.create.sync',
      clientTransactionId: 'deposit-sync',
      externalReference: null,
      deviceInstallationId: 'device-1',
      offlineEnvelopeId: 'queue-entry-1',
      offlineBatchId: '2026-03-26',
      integrityHash: 'fnv1a_sync',
      metadata: {
        agentCash: {
          sessionId: SERVER_SESSION_ID,
          businessDate: '2026-03-26',
          businessTimezone: 'Africa/Nairobi',
          cashImpactMinor: 15_000,
          projectedCashMinor: 40_000,
          maxSessionCarryMinor: 90_000,
          minimumReserveMinor: 5_000,
          sessionVersion: 2,
        },
      },
      createdAt: '2026-03-26T17:06:00.000Z',
    },
    ...input,
  }
}

async function seedLocalSession(database: SqlJsTestDatabase) {
  return openLocalCashSession(database, {
    actorId: 'agent-1',
    branchId: 'branch-1',
    deviceInstallationId: 'device-1',
    businessDate: '2026-03-26',
    businessTimezone: 'Africa/Nairobi',
    openingFloatMinor: 25_000,
    maxSessionCarryMinor: 90_000,
    minimumReserveMinor: 5_000,
    openedAt: '2026-03-26T08:00:00.000Z',
    lastKnownServerVersion: cashSessionVersion(1),
    authoritativeSnapshot: {
      sessionId: SERVER_SESSION_ID,
      businessDate: '2026-03-26',
      businessTimezone: 'Africa/Nairobi',
      openingFloatMinor: 25_000,
      expectedClosingCashMinor: 25_000,
      maxSessionCarryMinor: 90_000,
      minimumReserveMinor: 5_000,
      serverVersion: cashSessionVersion(1),
    },
  })
}

describe('agent cash mobile sync', () => {
  it('drains same-day cash transactions before reconciliation even when reconciliation was queued earlier', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const session = await seedLocalSession(database)

    await queueLocalCashReconciliationSubmission(database, {
      sessionId: session.id,
      declaredCashMinor: 40_000,
      notes: 'Counted after route close.',
      counts: { notes_1000: 40 },
      actorId: 'agent-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      operationId: 'agent.cash.reconcile.submit.ordering',
      lastKnownServerVersion: cashSessionVersion(1),
      queuedAt: '2026-03-26T17:00:00.000Z',
    })

    await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'deposit-sync',
        memberId: 'member-1',
        accountId: 'savings-1',
        transactionType: 'deposit',
        amountMinor: 15_000,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T17:05:00.000Z',
        capturedAt: '2026-03-26T17:05:00.000Z',
        payload: { note: 'Late market collection' },
        actorId: 'agent-1',
        branchId: 'branch-1',
        deviceInstallationId: 'device-1',
      },
      queue: {
        operationId: 'transaction.create.ordering',
        operationType: 'transaction.create',
        lastKnownServerVersion: cashSessionVersion(1),
      },
    })

    const calls: string[] = []
    const transport: MobileTransactionSyncTransport = {
      async invokeTransactionIngest(request) {
        calls.push(`transaction:${request.input.queue.operationId}`)
        return buildTransactionResult({ idempotencyKey: request.input.queue.operationId })
      },
      async invokeAgentCash(request) {
        calls.push(`cash:${request.action}`)

        if (request.action === 'agent.cash.current_state') {
          return buildCurrentStateEnvelope()
        }

        return buildSubmitEnvelope({ operationId: request.input.operationId })
      },
    }

    const result = await runTransactionSync(database, {
      now: () => '2026-03-26T17:10:00.000Z',
      transport,
    })

    expect(result).toEqual({ processed: 2, synced: 2, failed: 0, conflicts: 0, replayed: 0 })
    expect(calls).toEqual([
      'transaction:transaction.create.ordering',
      'cash:agent.cash.current_state',
      'cash:agent.cash.reconcile.submit',
    ])

    await expect(getQueueEntryByOperationId(database, 'transaction.create.ordering')).resolves.toMatchObject({
      status: 'synced',
      attemptCount: 1,
    })
    await expect(getQueueEntryByOperationId(database, 'agent.cash.reconcile.submit.ordering')).resolves.toMatchObject({
      status: 'synced',
      attemptCount: 1,
    })

    await expect(getSyncCheckpoint(database, 'agent-cash')).resolves.toMatchObject({
      lastKnownServerVersion: cashSessionVersion(3),
      serverCursor: SERVER_SESSION_ID,
    })

    const dashboard = await getLocalCashSessionDashboard(database, { sessionId: session.id })
    expect(dashboard?.summary).toMatchObject({
      projectedCashOnHandMinor: 40_000,
      authoritativeExpectedClosingCashMinor: 40_000,
      authoritativeDeltaMinor: 0,
    })
  })

  it('treats replayed transaction ingest and replayed reconciliation submit as synced without extra conflicts', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const session = await seedLocalSession(database)

    await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'deposit-replay',
        memberId: 'member-1',
        accountId: 'savings-1',
        transactionType: 'deposit',
        amountMinor: 15_000,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T12:00:00.000Z',
        capturedAt: '2026-03-26T12:00:00.000Z',
        payload: { note: 'Replay-safe collection' },
        actorId: 'agent-1',
        branchId: 'branch-1',
        deviceInstallationId: 'device-1',
      },
      queue: {
        operationId: 'transaction.create.replay',
        operationType: 'transaction.create',
        lastKnownServerVersion: cashSessionVersion(1),
      },
    })

    await queueLocalCashReconciliationSubmission(database, {
      sessionId: session.id,
      declaredCashMinor: 40_000,
      notes: 'Replay submit',
      counts: {},
      actorId: 'agent-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      operationId: 'agent.cash.reconcile.submit.replay',
      lastKnownServerVersion: cashSessionVersion(1),
      queuedAt: '2026-03-26T17:00:00.000Z',
    })

    const transport: MobileTransactionSyncTransport = {
      async invokeTransactionIngest() {
        return buildTransactionResult({ status: 'duplicate' })
      },
      async invokeAgentCash(request) {
        if (request.action === 'agent.cash.current_state') {
          return buildCurrentStateEnvelope()
        }

        return buildSubmitEnvelope({ replayed: true, outcome: 'duplicate', operationId: request.input.operationId })
      },
    }

    const result = await runTransactionSync(database, {
      now: () => '2026-03-26T17:15:00.000Z',
      transport,
    })

    expect(result).toEqual({ processed: 2, synced: 2, failed: 0, conflicts: 0, replayed: 2 })
    await expect(listOpenSyncConflicts(database)).resolves.toEqual([])
  })

  it('records a preserved mismatch conflict when authoritative totals diverge from the local projection', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const session = await seedLocalSession(database)

    await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'deposit-divergence',
        memberId: 'member-1',
        accountId: 'savings-1',
        transactionType: 'deposit',
        amountMinor: 4_000,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T13:00:00.000Z',
        capturedAt: '2026-03-26T13:00:00.000Z',
        payload: { note: 'Projection differs from server' },
        actorId: 'agent-1',
        branchId: 'branch-1',
        deviceInstallationId: 'device-1',
      },
      queue: {
        operationId: 'transaction.create.divergence',
        operationType: 'transaction.create',
        lastKnownServerVersion: cashSessionVersion(1),
      },
    })

    await queueLocalCashReconciliationSubmission(database, {
      sessionId: session.id,
      declaredCashMinor: 29_500,
      notes: 'Declared total differs',
      counts: {},
      actorId: 'agent-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      operationId: 'agent.cash.reconcile.submit.divergence',
      lastKnownServerVersion: cashSessionVersion(1),
      queuedAt: '2026-03-26T17:00:00.000Z',
    })

    const transport: MobileTransactionSyncTransport = {
      async invokeTransactionIngest() {
        return buildTransactionResult({
          transaction: {
            ...buildTransactionResult().transaction,
            amountMinor: 4_000,
            clientTransactionId: 'deposit-divergence',
          },
        })
      },
      async invokeAgentCash(request) {
        if (request.action === 'agent.cash.current_state') {
          return buildCurrentStateEnvelope({
            data: {
              ...buildCurrentStateEnvelope().data,
              totals: {
                ...buildCurrentStateEnvelope().data.totals,
                depositsMinor: 4_000,
                expectedClosingCashMinor: 29_000,
              },
            },
          })
        }

        return buildSubmitEnvelope({
          operationId: request.input.operationId,
          data: {
            ...buildSubmitEnvelope().data,
            serverVersion: cashSessionVersion(4),
            totals: {
              ...buildSubmitEnvelope().data.totals,
              depositsMinor: 4_000,
              expectedClosingCashMinor: 29_000,
              declaredCashMinor: 29_500,
              mismatchMinor: 500,
            },
            reconciliation: {
              ...buildSubmitEnvelope().data.reconciliation!,
              declaredCashMinor: 29_500,
              expectedClosingCashMinor: 29_000,
              mismatchMinor: 500,
            },
          },
        })
      },
    }

    const result = await runTransactionSync(database, {
      now: () => '2026-03-26T17:20:00.000Z',
      transport,
    })

    expect(result).toEqual({ processed: 2, synced: 2, failed: 0, conflicts: 1, replayed: 0 })

    const dashboard = await getLocalCashSessionDashboard(database, { sessionId: session.id })
    expect(dashboard?.summary).toMatchObject({
      projectedCashOnHandMinor: 29_000,
      authoritativeExpectedClosingCashMinor: 29_000,
    })
    expect(dashboard?.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conflictType: 'reconciliation_mismatch',
          queueOperationId: 'agent.cash.reconcile.submit.divergence',
        }),
      ])
    )
  })

  it('refreshes the authoritative cash session after stale-session errors and retries reconciliation once', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const session = await seedLocalSession(database)

    await queueLocalCashReconciliationSubmission(database, {
      sessionId: session.id,
      declaredCashMinor: 25_000,
      notes: 'Retry after stale version',
      counts: {},
      actorId: 'agent-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      operationId: 'agent.cash.reconcile.submit.stale',
      lastKnownServerVersion: cashSessionVersion(1),
      queuedAt: '2026-03-26T17:00:00.000Z',
    })

    const requests: string[] = []
    let firstSubmit = true
    const transport: MobileTransactionSyncTransport = {
      async invokeTransactionIngest() {
        throw new Error('No transaction sync expected in stale-session test')
      },
      async invokeAgentCash(request) {
        requests.push(request.action)

        if (request.action === 'agent.cash.current_state') {
          return buildCurrentStateEnvelope({
            data: {
              ...buildCurrentStateEnvelope().data,
              serverVersion: cashSessionVersion(2),
              totals: {
                ...buildCurrentStateEnvelope().data.totals,
                depositsMinor: 0,
                expectedClosingCashMinor: 25_000,
              },
            },
          })
        }

        if (firstSubmit) {
          firstSubmit = false
          throw new TransactionSyncRequestError(
            'stale_session_version',
            'The authoritative cash session changed; refresh before retrying this action',
            false,
            undefined,
            request.action,
            request.input.operationId
          )
        }

        return buildSubmitEnvelope({
          operationId: request.input.operationId,
          data: {
            ...buildSubmitEnvelope().data,
            serverVersion: cashSessionVersion(3),
            totals: {
              ...buildSubmitEnvelope().data.totals,
              depositsMinor: 0,
              expectedClosingCashMinor: 25_000,
              declaredCashMinor: 25_000,
              mismatchMinor: 0,
            },
            reconciliation: {
              ...buildSubmitEnvelope().data.reconciliation!,
              declaredCashMinor: 25_000,
              expectedClosingCashMinor: 25_000,
              mismatchMinor: 0,
            },
          },
        })
      },
    }

    const result = await runTransactionSync(database, {
      now: () => '2026-03-26T17:25:00.000Z',
      transport,
    })

    expect(result).toEqual({ processed: 1, synced: 1, failed: 0, conflicts: 1, replayed: 0 })
    expect(requests).toEqual([
      'agent.cash.reconcile.submit',
      'agent.cash.current_state',
      'agent.cash.reconcile.submit',
    ])

    await expect(getQueueEntryByOperationId(database, 'agent.cash.reconcile.submit.stale')).resolves.toMatchObject({
      status: 'synced',
      attemptCount: 1,
    })

    const dashboard = await getLocalCashSessionDashboard(database, { sessionId: session.id })
    expect(dashboard?.session.lastKnownServerVersion).toBe(cashSessionVersion(3))
    expect(dashboard?.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conflictType: 'stale_session_version',
          queueOperationId: 'agent.cash.reconcile.submit.stale',
        }),
      ])
    )
  })

  it('records no-open-session conflicts without deleting the local reconciliation intent', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const session = await seedLocalSession(database)

    await queueLocalCashReconciliationSubmission(database, {
      sessionId: session.id,
      declaredCashMinor: 25_000,
      notes: 'Server session is missing',
      counts: {},
      actorId: 'agent-1',
      branchId: 'branch-1',
      deviceInstallationId: 'device-1',
      operationId: 'agent.cash.reconcile.submit.no-session',
      lastKnownServerVersion: cashSessionVersion(1),
      queuedAt: '2026-03-26T17:00:00.000Z',
    })

    const transport: MobileTransactionSyncTransport = {
      async invokeTransactionIngest() {
        throw new Error('No transaction sync expected in no-session test')
      },
      async invokeAgentCash(request) {
        if (request.action === 'agent.cash.current_state') {
          throw new TransactionSyncRequestError(
            'no_open_session',
            'No authoritative cash session is open for this agent',
            false,
            undefined,
            request.action,
            null
          )
        }

        throw new TransactionSyncRequestError(
          'no_open_session',
          'An open agent cash session is required before reconciliation can be submitted',
          false,
          undefined,
          request.action,
          request.input.operationId
        )
      },
    }

    const result = await runTransactionSync(database, {
      now: () => '2026-03-26T17:30:00.000Z',
      transport,
    })

    expect(result).toEqual({ processed: 1, synced: 0, failed: 0, conflicts: 1, replayed: 0 })
    await expect(getQueueEntryByOperationId(database, 'agent.cash.reconcile.submit.no-session')).resolves.toMatchObject({
      status: 'conflict',
      attemptCount: 1,
    })

    const dashboard = await getLocalCashSessionDashboard(database, { sessionId: session.id })
    expect(dashboard?.draft).toMatchObject({ queueOperationId: 'agent.cash.reconcile.submit.no-session' })
    expect(dashboard?.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conflictType: 'no_open_session',
          queueOperationId: 'agent.cash.reconcile.submit.no-session',
        }),
      ])
    )
  })

  it('records server-side cash-limit breaches as non-destructive conflicts for queued transactions', async () => {
    const database = await SqlJsTestDatabase.create()
    await migrateDatabase(database)

    const session = await seedLocalSession(database)

    await createLocalTransactionWithQueue(database, {
      transaction: {
        clientTransactionId: 'withdrawal-server-limit',
        memberId: 'member-1',
        accountId: 'savings-1',
        transactionType: 'withdrawal',
        amountMinor: 10_000,
        currencyCode: 'KES',
        occurredAt: '2026-03-26T14:00:00.000Z',
        capturedAt: '2026-03-26T14:00:00.000Z',
        payload: { note: 'Server rejects this withdrawal' },
        actorId: 'agent-1',
        branchId: 'branch-1',
        deviceInstallationId: 'device-1',
        captureContext: {
          isOfflineCapture: true,
          availableBalanceMinor: 50_000,
          identityConfirmed: true,
          cashConfirmed: true,
        },
      },
      queue: {
        operationId: 'transaction.create.cash-limit',
        operationType: 'transaction.create',
        lastKnownServerVersion: cashSessionVersion(1),
      },
    })

    const transport: MobileTransactionSyncTransport = {
      async invokeTransactionIngest(request) {
        throw new TransactionSyncRequestError(
          'cash_limit_breach',
          'Authoritative cash availability or carry limits would be exceeded',
          false,
          { projectedCashMinor: -500 },
          request.action,
          request.input.queue.operationId
        )
      },
      async invokeAgentCash(request) {
        if (request.action === 'agent.cash.current_state') {
          return buildCurrentStateEnvelope()
        }

        throw new Error('No reconciliation submit expected in cash-limit test')
      },
    }

    const result = await runTransactionSync(database, {
      now: () => '2026-03-26T17:35:00.000Z',
      transport,
    })

    expect(result).toEqual({ processed: 1, synced: 0, failed: 0, conflicts: 1, replayed: 0 })
    await expect(getQueueEntryByOperationId(database, 'transaction.create.cash-limit')).resolves.toMatchObject({
      status: 'conflict',
      attemptCount: 1,
    })

    const syncedTransaction = await getLocalTransactionByClientId(database, 'withdrawal-server-limit')
    expect(syncedTransaction?.status).toBe('local_pending')

    const dashboard = await getLocalCashSessionDashboard(database, { sessionId: session.id })
    expect(dashboard?.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conflictType: 'cash_limit_breach',
          queueOperationId: 'transaction.create.cash-limit',
        }),
      ])
    )

    await expect(listOpenSyncConflicts(database)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conflictType: 'transaction_queue_cash_limit_breach',
          queueEntryId: 'transaction.create.cash-limit',
        }),
      ])
    )
  })
})