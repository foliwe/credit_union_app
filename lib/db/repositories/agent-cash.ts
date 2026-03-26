import type { DatabaseConnection } from '../database'
import { AGENT_CASH_SCHEMA_STATEMENTS } from '../schema'
import type {
  LocalAgentCashConflictRecord,
  LocalAgentCashDashboard,
  LocalAgentCashReconciliationDraftRecord,
  LocalAgentCashSessionRecord,
  LocalFraudHint,
  LocalGuardrailDecision,
  OpenLocalCashSessionInput,
  QueueEntryRecord,
  QueueLocalCashReconciliationSubmissionInput,
  SaveLocalCashReconciliationDraftInput,
  TransactionType,
} from '../../types/offline'
import { createQueueEntry, getQueueEntryByOperationId } from './queue'
import { buildLocalCashSummary, getCashDeltaMinor, requiresLocalCashSession } from '../../transactions/cash'

type LocalAgentCashSessionRow = {
  id: string
  server_session_id: string | null
  actor_id: string
  branch_id: string
  device_installation_id: string
  business_date: string
  business_timezone: string
  opening_float_minor: number
  max_session_carry_minor: number | null
  minimum_reserve_minor: number
  authoritative_expected_closing_cash_minor: number | null
  authoritative_collections_minor: number | null
  authoritative_withdrawals_minor: number | null
  authoritative_observed_at: string | null
  last_known_server_version: string | null
  opened_at: string
  updated_at: string
}

type LocalAgentCashDraftRow = {
  id: string
  session_id: string
  declared_cash_minor: number
  notes: string | null
  counts_json: string
  projected_cash_on_hand_minor: number
  variance_minor: number
  queue_operation_id: string | null
  last_known_server_version: string | null
  created_at: string
  updated_at: string
}

type LocalAgentCashConflictRow = {
  id: string
  session_id: string
  queue_operation_id: string | null
  conflict_type: LocalAgentCashConflictRecord['conflictType']
  server_payload_json: string | null
  local_payload_json: string
  created_at: string
  resolved_at: string | null
}

type LocalCashTransactionRow = {
  transaction_type: TransactionType
  amount_minor: number
  payload_json: string
}

type SessionLookup =
  | {
      sessionId: string
    }
  | {
      actorId: string
      branchId: string
      businessDate: string
    }

type LocalCashGuardrailAssessment = {
  guardrail: LocalGuardrailDecision
  hints: LocalFraudHint[]
}

function createId(prefix: string) {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}_${token}`
}

function mapSessionRow(row: LocalAgentCashSessionRow): LocalAgentCashSessionRecord {
  return {
    id: row.id,
    serverSessionId: row.server_session_id,
    actorId: row.actor_id,
    branchId: row.branch_id,
    deviceInstallationId: row.device_installation_id,
    businessDate: row.business_date,
    businessTimezone: row.business_timezone,
    openingFloatMinor: row.opening_float_minor,
    maxSessionCarryMinor: row.max_session_carry_minor,
    minimumReserveMinor: row.minimum_reserve_minor,
    authoritativeExpectedClosingCashMinor: row.authoritative_expected_closing_cash_minor,
    authoritativeCollectionsMinor: row.authoritative_collections_minor,
    authoritativeWithdrawalsMinor: row.authoritative_withdrawals_minor,
    authoritativeObservedAt: row.authoritative_observed_at,
    lastKnownServerVersion: row.last_known_server_version,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
  }
}

function mapDraftRow(row: LocalAgentCashDraftRow): LocalAgentCashReconciliationDraftRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    declaredCashMinor: row.declared_cash_minor,
    notes: row.notes,
    counts: JSON.parse(row.counts_json) as Record<string, unknown>,
    projectedCashOnHandMinor: row.projected_cash_on_hand_minor,
    varianceMinor: row.variance_minor,
    queueOperationId: row.queue_operation_id,
    lastKnownServerVersion: row.last_known_server_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapConflictRow(row: LocalAgentCashConflictRow): LocalAgentCashConflictRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    queueOperationId: row.queue_operation_id,
    conflictType: row.conflict_type,
    serverPayload: row.server_payload_json
      ? (JSON.parse(row.server_payload_json) as Record<string, unknown>)
      : null,
    localPayload: JSON.parse(row.local_payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

function buildCashLimitHint(message: string): LocalFraudHint {
  return {
    code: 'cash_limit_breach',
    severity: 'critical',
    message,
  }
}

async function ensureAgentCashSchema(database: DatabaseConnection) {
  for (const statement of AGENT_CASH_SCHEMA_STATEMENTS) {
    await database.execAsync(statement)
  }
}

async function getLocalCashSessionRow(
  database: DatabaseConnection,
  lookup: SessionLookup
): Promise<LocalAgentCashSessionRow | null> {
  if ('sessionId' in lookup) {
    return database.getFirstAsync<LocalAgentCashSessionRow>(
      `
        SELECT
          id,
          server_session_id,
          actor_id,
          branch_id,
          device_installation_id,
          business_date,
          business_timezone,
          opening_float_minor,
          max_session_carry_minor,
          minimum_reserve_minor,
          authoritative_expected_closing_cash_minor,
          authoritative_collections_minor,
          authoritative_withdrawals_minor,
          authoritative_observed_at,
          last_known_server_version,
          opened_at,
          updated_at
        FROM local_agent_cash_sessions
        WHERE id = ?
      `,
      [lookup.sessionId]
    )
  }

  return database.getFirstAsync<LocalAgentCashSessionRow>(
    `
      SELECT
        id,
        server_session_id,
        actor_id,
        branch_id,
        device_installation_id,
        business_date,
        business_timezone,
        opening_float_minor,
        max_session_carry_minor,
        minimum_reserve_minor,
        authoritative_expected_closing_cash_minor,
        authoritative_collections_minor,
        authoritative_withdrawals_minor,
        authoritative_observed_at,
        last_known_server_version,
        opened_at,
        updated_at
      FROM local_agent_cash_sessions
      WHERE actor_id = ? AND branch_id = ? AND business_date = ?
    `,
    [lookup.actorId, lookup.branchId, lookup.businessDate]
  )
}

async function getLocalCashDraftBySessionId(
  database: DatabaseConnection,
  sessionId: string
): Promise<LocalAgentCashReconciliationDraftRecord | null> {
  const row = await database.getFirstAsync<LocalAgentCashDraftRow>(
    `
      SELECT
        id,
        session_id,
        declared_cash_minor,
        notes,
        counts_json,
        projected_cash_on_hand_minor,
        variance_minor,
        queue_operation_id,
        last_known_server_version,
        created_at,
        updated_at
      FROM local_agent_cash_reconciliation_drafts
      WHERE session_id = ?
    `,
    [sessionId]
  )

  return row ? mapDraftRow(row) : null
}

async function listSessionTransactions(database: DatabaseConnection, session: LocalAgentCashSessionRecord) {
  const rows = await database.getAllAsync<LocalCashTransactionRow>(
    `
      SELECT transaction_type, amount_minor, payload_json
      FROM local_transactions
      WHERE actor_id = ?
        AND branch_id = ?
        AND substr(client_recorded_at, 1, 10) = ?
      ORDER BY client_recorded_at ASC, created_at ASC
    `,
    [session.actorId, session.branchId, session.businessDate]
  )

  return rows.map((row) => ({
    transactionType: row.transaction_type,
    amountMinor: row.amount_minor,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }))
}

export async function getLocalCashSession(
  database: DatabaseConnection,
  lookup: SessionLookup
): Promise<LocalAgentCashSessionRecord | null> {
  await ensureAgentCashSchema(database)
  const row = await getLocalCashSessionRow(database, lookup)
  return row ? mapSessionRow(row) : null
}

export async function applyAuthoritativeCashSnapshot(
  database: DatabaseConnection,
  input: {
    localSessionId?: string | null
    actorId: string
    branchId: string
    businessDate: string
    businessTimezone: string
    serverSessionId: string
    openingFloatMinor: number
    maxSessionCarryMinor: number | null
    minimumReserveMinor: number
    authoritativeExpectedClosingCashMinor: number
    authoritativeCollectionsMinor: number
    authoritativeWithdrawalsMinor: number
    lastKnownServerVersion: string | null
    observedAt: string
  }
): Promise<LocalAgentCashSessionRecord | null> {
  await ensureAgentCashSchema(database)

  const existing = input.localSessionId
    ? await getLocalCashSession(database, { sessionId: input.localSessionId })
    : await getLocalCashSession(database, {
        actorId: input.actorId,
        branchId: input.branchId,
        businessDate: input.businessDate,
      })

  if (!existing) {
    return null
  }

  await database.runAsync(
    `
      UPDATE local_agent_cash_sessions
      SET server_session_id = ?,
          business_timezone = ?,
          opening_float_minor = ?,
          max_session_carry_minor = ?,
          minimum_reserve_minor = ?,
          authoritative_expected_closing_cash_minor = ?,
          authoritative_collections_minor = ?,
          authoritative_withdrawals_minor = ?,
          authoritative_observed_at = ?,
          last_known_server_version = ?,
          updated_at = ?
      WHERE id = ?
    `,
    [
      input.serverSessionId,
      input.businessTimezone,
      input.openingFloatMinor,
      input.maxSessionCarryMinor,
      input.minimumReserveMinor,
      input.authoritativeExpectedClosingCashMinor,
      input.authoritativeCollectionsMinor,
      input.authoritativeWithdrawalsMinor,
      input.observedAt,
      input.lastKnownServerVersion,
      input.observedAt,
      existing.id,
    ]
  )

  await database.runAsync(
    `
      UPDATE local_agent_cash_reconciliation_drafts
      SET last_known_server_version = ?,
          updated_at = ?
      WHERE session_id = ?
    `,
    [input.lastKnownServerVersion, input.observedAt, existing.id]
  )

  return getLocalCashSession(database, { sessionId: existing.id })
}

export async function openLocalCashSession(
  database: DatabaseConnection,
  input: OpenLocalCashSessionInput
): Promise<LocalAgentCashSessionRecord> {
  await ensureAgentCashSchema(database)
  const existing = await getLocalCashSession(database, {
    actorId: input.actorId,
    branchId: input.branchId,
    businessDate: input.businessDate,
  })

  if (existing) {
    throw new Error('A local cash session is already open for this agent and business date.')
  }

  const id = createId('cash_session')
  const authoritativeSnapshot = input.authoritativeSnapshot ?? null

  await database.runAsync(
    `
      INSERT INTO local_agent_cash_sessions (
        id,
        server_session_id,
        actor_id,
        branch_id,
        device_installation_id,
        business_date,
        business_timezone,
        opening_float_minor,
        max_session_carry_minor,
        minimum_reserve_minor,
        authoritative_expected_closing_cash_minor,
        authoritative_collections_minor,
        authoritative_withdrawals_minor,
        authoritative_observed_at,
        last_known_server_version,
        opened_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      authoritativeSnapshot?.sessionId ?? null,
      input.actorId,
      input.branchId,
      input.deviceInstallationId,
      input.businessDate,
      input.businessTimezone,
      authoritativeSnapshot?.openingFloatMinor ?? input.openingFloatMinor,
      authoritativeSnapshot?.maxSessionCarryMinor ?? input.maxSessionCarryMinor,
      authoritativeSnapshot?.minimumReserveMinor ?? input.minimumReserveMinor,
      authoritativeSnapshot?.expectedClosingCashMinor ?? null,
      0,
      0,
      authoritativeSnapshot ? input.openedAt : null,
      authoritativeSnapshot?.serverVersion ?? input.lastKnownServerVersion,
      input.openedAt,
      input.openedAt,
    ]
  )

  const stored = await getLocalCashSession(database, { sessionId: id })
  if (!stored) {
    throw new Error('Failed to persist the local cash session.')
  }

  return stored
}

export async function openOrResumeLocalCashSession(
  database: DatabaseConnection,
  input: OpenLocalCashSessionInput
): Promise<{ session: LocalAgentCashSessionRecord; resumed: boolean }> {
  const existing = await getLocalCashSession(database, {
    actorId: input.actorId,
    branchId: input.branchId,
    businessDate: input.businessDate,
  })

  if (existing) {
    return {
      session: existing,
      resumed: true,
    }
  }

  return {
    session: await openLocalCashSession(database, input),
    resumed: false,
  }
}

export async function listLocalCashConflicts(
  database: DatabaseConnection,
  sessionId: string
): Promise<LocalAgentCashConflictRecord[]> {
  await ensureAgentCashSchema(database)
  const rows = await database.getAllAsync<LocalAgentCashConflictRow>(
    `
      SELECT
        id,
        session_id,
        queue_operation_id,
        conflict_type,
        server_payload_json,
        local_payload_json,
        created_at,
        resolved_at
      FROM local_agent_cash_conflicts
      WHERE session_id = ?
      ORDER BY created_at ASC
    `,
    [sessionId]
  )

  return rows.map(mapConflictRow)
}

export async function getLocalCashSessionDashboard(
  database: DatabaseConnection,
  lookup: SessionLookup
): Promise<LocalAgentCashDashboard | null> {
  await ensureAgentCashSchema(database)
  const session = await getLocalCashSession(database, lookup)
  if (!session) {
    return null
  }

  const [draft, conflicts, transactions] = await Promise.all([
    getLocalCashDraftBySessionId(database, session.id),
    listLocalCashConflicts(database, session.id),
    listSessionTransactions(database, session),
  ])

  return {
    session,
    summary: buildLocalCashSummary(session, transactions, draft !== null),
    draft,
    conflicts,
  }
}

export async function saveLocalCashReconciliationDraft(
  database: DatabaseConnection,
  input: SaveLocalCashReconciliationDraftInput
): Promise<LocalAgentCashReconciliationDraftRecord> {
  await ensureAgentCashSchema(database)
  const dashboard = await getLocalCashSessionDashboard(database, { sessionId: input.sessionId })
  if (!dashboard) {
    throw new Error('Open a local cash session before saving a reconciliation draft.')
  }

  const existing = await getLocalCashDraftBySessionId(database, input.sessionId)
  const draftId = existing?.id ?? createId('cash_recon_draft')
  const createdAt = existing?.createdAt ?? input.savedAt
  const notes = input.notes?.trim() ? input.notes.trim() : null
  const counts = input.counts ?? {}
  const varianceMinor = input.declaredCashMinor - dashboard.summary.projectedCashOnHandMinor

  await database.runAsync(
    `
      INSERT INTO local_agent_cash_reconciliation_drafts (
        id,
        session_id,
        declared_cash_minor,
        notes,
        counts_json,
        projected_cash_on_hand_minor,
        variance_minor,
        queue_operation_id,
        last_known_server_version,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        declared_cash_minor = excluded.declared_cash_minor,
        notes = excluded.notes,
        counts_json = excluded.counts_json,
        projected_cash_on_hand_minor = excluded.projected_cash_on_hand_minor,
        variance_minor = excluded.variance_minor,
        last_known_server_version = excluded.last_known_server_version,
        updated_at = excluded.updated_at
    `,
    [
      draftId,
      input.sessionId,
      input.declaredCashMinor,
      notes,
      JSON.stringify(counts),
      dashboard.summary.projectedCashOnHandMinor,
      varianceMinor,
      existing?.queueOperationId ?? null,
      input.lastKnownServerVersion,
      createdAt,
      input.savedAt,
    ]
  )

  const stored = await getLocalCashDraftBySessionId(database, input.sessionId)
  if (!stored) {
    throw new Error('Failed to persist the local reconciliation draft.')
  }

  return stored
}

export async function queueLocalCashReconciliationSubmission(
  database: DatabaseConnection,
  input: QueueLocalCashReconciliationSubmissionInput
): Promise<{
  draft: LocalAgentCashReconciliationDraftRecord
  queue: QueueEntryRecord
}> {
  await ensureAgentCashSchema(database)
  return database.withTransactionAsync(async (transactionDatabase) => {
    const draft = await saveLocalCashReconciliationDraft(transactionDatabase, {
      sessionId: input.sessionId,
      declaredCashMinor: input.declaredCashMinor,
      notes: input.notes ?? undefined,
      counts: input.counts,
      lastKnownServerVersion: input.lastKnownServerVersion,
      savedAt: input.queuedAt,
    })

    await createQueueEntry(transactionDatabase, {
      operationId: input.operationId,
      operationType: 'agent.cash.reconcile.submit',
      localEntityId: draft.id,
      actorId: input.actorId,
      branchId: input.branchId,
      deviceInstallationId: input.deviceInstallationId,
      payload: {
        action: 'agent.cash.reconcile.submit',
        sessionId: input.sessionId,
        declaredCashMinor: input.declaredCashMinor,
        notes: input.notes ?? null,
        counts: input.counts ?? {},
        projectedCashOnHandMinor: draft.projectedCashOnHandMinor,
        varianceMinor: draft.varianceMinor,
        localTotalsAreProvisional: true,
      },
      nextAttemptAt: input.queuedAt,
      createdAt: input.queuedAt,
      lastKnownServerVersion: input.lastKnownServerVersion,
    })

    await transactionDatabase.runAsync(
      `
        UPDATE local_agent_cash_reconciliation_drafts
        SET queue_operation_id = ?,
            updated_at = ?
        WHERE session_id = ?
      `,
      [input.operationId, input.queuedAt, input.sessionId]
    )

    const storedDraft = await getLocalCashDraftBySessionId(transactionDatabase, input.sessionId)
    const storedQueue = await getQueueEntryByOperationId(transactionDatabase, input.operationId)

    if (!storedDraft || !storedQueue) {
      throw new Error('Failed to persist the local reconciliation submission intent.')
    }

    return {
      draft: storedDraft,
      queue: storedQueue,
    }
  })
}

export async function recordLocalCashConflict(
  database: DatabaseConnection,
  input: Omit<LocalAgentCashConflictRecord, 'id' | 'resolvedAt'> & { id?: string; resolvedAt?: string | null }
): Promise<LocalAgentCashConflictRecord> {
  await ensureAgentCashSchema(database)
  const id = input.id ?? createId('cash_conflict')

  await database.runAsync(
    `
      INSERT INTO local_agent_cash_conflicts (
        id,
        session_id,
        queue_operation_id,
        conflict_type,
        server_payload_json,
        local_payload_json,
        created_at,
        resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      input.sessionId,
      input.queueOperationId,
      input.conflictType,
      input.serverPayload ? JSON.stringify(input.serverPayload) : null,
      JSON.stringify(input.localPayload),
      input.createdAt,
      input.resolvedAt ?? null,
    ]
  )

  return {
    id,
    sessionId: input.sessionId,
    queueOperationId: input.queueOperationId,
    conflictType: input.conflictType,
    serverPayload: input.serverPayload,
    localPayload: input.localPayload,
    createdAt: input.createdAt,
    resolvedAt: input.resolvedAt ?? null,
  }
}

export async function assessLocalCashTransactionGuardrails(
  database: DatabaseConnection,
  input: {
    actorId: string
    branchId: string
    capturedAt: string
    transactionType: TransactionType
    amountMinor: number
    payload: Record<string, unknown>
  }
): Promise<LocalCashGuardrailAssessment> {
  await ensureAgentCashSchema(database)
  if (!requiresLocalCashSession(input.transactionType)) {
    return {
      guardrail: {
        status: 'clear',
        title: 'Ready to queue',
        messages: [],
      },
      hints: [],
    }
  }

  const businessDate = input.capturedAt.slice(0, 10)
  const session = await getLocalCashSession(database, {
    actorId: input.actorId,
    branchId: input.branchId,
    businessDate,
  })

  if (!session) {
    return {
      guardrail: {
        status: 'blocked',
        title: 'Local cash session required',
        messages: ['Open a local cash session before queueing provisional cash transactions.'],
      },
      hints: [],
    }
  }

  const transactions = await listSessionTransactions(database, session)
  const previewTransactions = [
    ...transactions,
    {
      transactionType: input.transactionType,
      amountMinor: input.amountMinor,
      payload: input.payload,
    },
  ]
  const preview = buildLocalCashSummary(session, previewTransactions, false)

  if (preview.projectedCashOnHandMinor < 0) {
    const message = 'This transaction would make projected cash-on-hand negative for the open local session.'
    return {
      guardrail: {
        status: 'blocked',
        title: 'Projected cash would go negative',
        messages: [message],
      },
      hints: [buildCashLimitHint(message)],
    }
  }

  if (
    typeof session.maxSessionCarryMinor === 'number' &&
    preview.projectedCashOnHandMinor > session.maxSessionCarryMinor
  ) {
    const message = 'This transaction would exceed the local carry limit snapshot for the open session.'
    return {
      guardrail: {
        status: 'blocked',
        title: 'Carry limit would be breached',
        messages: [message],
      },
      hints: [buildCashLimitHint(message)],
    }
  }

  if (preview.limitStatus === 'reserve_low' && getCashDeltaMinor({ ...input }) < 0) {
    return {
      guardrail: {
        status: 'review',
        title: 'Reserve buffer is low',
        messages: ['Projected cash-on-hand would fall below the local reserve buffer snapshot.'],
      },
      hints: [],
    }
  }

  return {
    guardrail: {
      status: 'clear',
      title: 'Ready to queue',
      messages: [],
    },
    hints: [],
  }
}