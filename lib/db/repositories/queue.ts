import type { DatabaseConnection } from '../database'
import type { OfflineFraudEvidence, QueueEntryRecord } from '../../types/offline'

export type CreateQueueEntryRecordInput = {
  id?: string
  operationId: string
  operationType: string
  localEntityId: string
  actorId: string
  branchId: string
  deviceInstallationId: string
  payload: Record<string, unknown>
  status?: QueueEntryRecord['status']
  attemptCount?: number
  nextAttemptAt: string
  createdAt: string
  updatedAt?: string
  lastKnownServerVersion: string | null
}

type QueueRow = {
  id: string
  operation_id: string
  operation_type: string
  local_transaction_id: string
  actor_id: string
  branch_id: string
  device_installation_id: string
  payload_json: string
  status: QueueEntryRecord['status']
  attempt_count: number
  next_attempt_at: string
  created_at: string
  updated_at: string
  last_known_server_version: string | null
}

function mapQueueRow(row: QueueRow): QueueEntryRecord {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>

  return {
    id: row.id,
    operationId: row.operation_id,
    operationType: row.operation_type,
    localEntityId: row.local_transaction_id,
    localTransactionId: row.local_transaction_id,
    actorId: row.actor_id,
    branchId: row.branch_id,
    deviceInstallationId: row.device_installation_id,
    payload,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastKnownServerVersion: row.last_known_server_version,
    fraudHints: Array.isArray(payload.localRiskHints)
      ? (payload.localRiskHints as QueueEntryRecord['fraudHints'])
      : [],
    guardrailStatus:
      payload.guardrailStatus === 'review' || payload.guardrailStatus === 'blocked'
        ? payload.guardrailStatus
        : 'clear',
    fraudEvidence:
      payload.offlineEvidence && typeof payload.offlineEvidence === 'object'
        ? (payload.offlineEvidence as OfflineFraudEvidence)
        : null,
  }
}

function createId(prefix: string) {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}_${token}`
}

export async function createQueueEntry(
  database: DatabaseConnection,
  input: CreateQueueEntryRecordInput
): Promise<QueueEntryRecord> {
  const id = input.id ?? createId('queue')

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
        updated_at,
        last_known_server_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      input.operationId,
      input.operationType,
      input.localEntityId,
      input.actorId,
      input.branchId,
      input.deviceInstallationId,
      JSON.stringify(input.payload),
      input.status ?? 'pending',
      input.attemptCount ?? 0,
      input.nextAttemptAt,
      input.createdAt,
      input.updatedAt ?? input.createdAt,
      input.lastKnownServerVersion,
    ]
  )

  const stored = await getQueueEntryByOperationId(database, input.operationId)
  if (!stored) {
    throw new Error(`Failed to load queue entry for operation ${input.operationId}`)
  }

  return stored
}

export async function updateQueueEntryStatus(
  database: DatabaseConnection,
  operationId: string,
  status: QueueEntryRecord['status'],
  updatedAt: string,
  attemptCount?: number
): Promise<QueueEntryRecord | null> {
  const existing = await getQueueEntryByOperationId(database, operationId)
  if (!existing) {
    return null
  }

  await database.runAsync(
    `
      UPDATE queue_entries
      SET status = ?,
          attempt_count = ?,
          updated_at = ?
      WHERE operation_id = ?
    `,
    [status, attemptCount ?? existing.attemptCount, updatedAt, operationId]
  )

  return getQueueEntryByOperationId(database, operationId)
}

export async function listPendingQueueEntries(database: DatabaseConnection): Promise<QueueEntryRecord[]> {
  const rows = await database.getAllAsync<QueueRow>(
    `
      SELECT
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
        updated_at,
        last_known_server_version
      FROM queue_entries
      WHERE status = ?
      ORDER BY created_at ASC
    `,
    ['pending']
  )

  return rows.map(mapQueueRow)
}

export async function listQueueEntriesForSync(
  database: DatabaseConnection,
  operationTypes: string[],
  statuses: QueueEntryRecord['status'][] = ['pending', 'failed']
): Promise<QueueEntryRecord[]> {
  if (operationTypes.length === 0 || statuses.length === 0) {
    return []
  }

  const typePlaceholders = operationTypes.map(() => '?').join(', ')
  const statusPlaceholders = statuses.map(() => '?').join(', ')
  const rows = await database.getAllAsync<QueueRow>(
    `
      SELECT
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
        updated_at,
        last_known_server_version
      FROM queue_entries
      WHERE operation_type IN (${typePlaceholders})
        AND status IN (${statusPlaceholders})
      ORDER BY created_at ASC
    `,
    [...operationTypes, ...statuses]
  )

  return rows.map(mapQueueRow)
}

export async function getQueueEntryByOperationId(
  database: DatabaseConnection,
  operationId: string
): Promise<QueueEntryRecord | null> {
  const row = await database.getFirstAsync<QueueRow>(
    `
      SELECT
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
        updated_at,
        last_known_server_version
      FROM queue_entries
      WHERE operation_id = ?
    `,
    [operationId]
  )

  return row ? mapQueueRow(row) : null
}
