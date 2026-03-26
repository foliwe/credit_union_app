import type { DatabaseConnection } from '../database'
import type { SyncCheckpointRecord, SyncConflictRecord, SyncRunRecord, UpsertSyncCheckpointInput } from '../../types/offline'

type SyncCheckpointRow = {
  scope: string
  last_pulled_at: string | null
  server_cursor: string | null
  last_known_server_version: string | null
  updated_at: string
}

type SyncRunRow = {
  id: string
  status: SyncRunRecord['status']
  started_at: string
  completed_at: string | null
  error_message: string | null
  last_known_server_version: string | null
}

type SyncConflictRow = {
  id: string
  queue_entry_id: string
  local_transaction_id: string | null
  conflict_type: string
  server_payload_json: string | null
  local_payload_json: string
  created_at: string
  resolved_at: string | null
}

function createId(prefix: string) {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}_${token}`
}

function mapSyncCheckpointRow(row: SyncCheckpointRow): SyncCheckpointRecord {
  return {
    scope: row.scope,
    lastPulledAt: row.last_pulled_at,
    serverCursor: row.server_cursor,
    lastKnownServerVersion: row.last_known_server_version,
    updatedAt: row.updated_at,
  }
}

export async function upsertSyncCheckpoint(
  database: DatabaseConnection,
  checkpoint: UpsertSyncCheckpointInput
): Promise<SyncCheckpointRecord> {
  const updatedAt = checkpoint.lastPulledAt ?? new Date().toISOString()

  await database.runAsync(
    `
      INSERT INTO sync_checkpoints (
        scope,
        last_pulled_at,
        server_cursor,
        last_known_server_version,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        last_pulled_at = excluded.last_pulled_at,
        server_cursor = excluded.server_cursor,
        last_known_server_version = excluded.last_known_server_version,
        updated_at = excluded.updated_at
    `,
    [
      checkpoint.scope,
      checkpoint.lastPulledAt,
      checkpoint.serverCursor,
      checkpoint.lastKnownServerVersion,
      updatedAt,
    ]
  )

  const stored = await getSyncCheckpoint(database, checkpoint.scope)
  if (!stored) {
    throw new Error(`Failed to load sync checkpoint for scope ${checkpoint.scope}`)
  }

  return stored
}

export async function getSyncCheckpoint(
  database: DatabaseConnection,
  scope: string
): Promise<SyncCheckpointRecord | null> {
  const row = await database.getFirstAsync<SyncCheckpointRow>(
    `
      SELECT scope, last_pulled_at, server_cursor, last_known_server_version, updated_at
      FROM sync_checkpoints
      WHERE scope = ?
    `,
    [scope]
  )

  return row ? mapSyncCheckpointRow(row) : null
}

export async function createSyncRun(
  database: DatabaseConnection,
  input: Omit<SyncRunRecord, 'id'> & { id?: string }
): Promise<SyncRunRecord> {
  const id = input.id ?? createId('sync_run')

  await database.runAsync(
    `
      INSERT INTO sync_runs (
        id,
        status,
        started_at,
        completed_at,
        error_message,
        last_known_server_version
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      input.status,
      input.startedAt,
      input.completedAt,
      input.errorMessage,
      input.lastKnownServerVersion,
    ]
  )

  return {
    id,
    ...input,
  }
}

export async function updateSyncRun(
  database: DatabaseConnection,
  runId: string,
  input: Pick<SyncRunRecord, 'status' | 'completedAt' | 'errorMessage' | 'lastKnownServerVersion'>
): Promise<SyncRunRecord | null> {
  await database.runAsync(
    `
      UPDATE sync_runs
      SET status = ?,
          completed_at = ?,
          error_message = ?,
          last_known_server_version = ?
      WHERE id = ?
    `,
    [input.status, input.completedAt, input.errorMessage, input.lastKnownServerVersion, runId]
  )

  const row = await database.getFirstAsync<SyncRunRow>(
    `
      SELECT id, status, started_at, completed_at, error_message, last_known_server_version
      FROM sync_runs
      WHERE id = ?
    `,
    [runId]
  )

  return row
    ? {
        id: row.id,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        errorMessage: row.error_message,
        lastKnownServerVersion: row.last_known_server_version,
      }
    : null
}

export async function recordSyncConflict(
  database: DatabaseConnection,
  input: Omit<SyncConflictRecord, 'id'> & { id?: string }
): Promise<SyncConflictRecord> {
  const id = input.id ?? createId('sync_conflict')

  await database.runAsync(
    `
      INSERT INTO sync_conflicts (
        id,
        queue_entry_id,
        local_transaction_id,
        conflict_type,
        server_payload_json,
        local_payload_json,
        created_at,
        resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      input.queueEntryId,
      input.localTransactionId,
      input.conflictType,
      input.serverPayload ? JSON.stringify(input.serverPayload) : null,
      JSON.stringify(input.localPayload),
      input.createdAt,
      input.resolvedAt,
    ]
  )

  return {
    id,
    ...input,
  }
}

export async function listSyncConflicts(database: DatabaseConnection): Promise<SyncConflictRecord[]> {
  const rows = await database.getAllAsync<SyncConflictRow>(
    `
      SELECT
        id,
        queue_entry_id,
        local_transaction_id,
        conflict_type,
        server_payload_json,
        local_payload_json,
        created_at,
        resolved_at
      FROM sync_conflicts
      ORDER BY created_at ASC
    `
  )

  return rows.map((row) => ({
    id: row.id,
    queueEntryId: row.queue_entry_id,
    localTransactionId: row.local_transaction_id,
    conflictType: row.conflict_type,
    serverPayload: row.server_payload_json
      ? (JSON.parse(row.server_payload_json) as Record<string, unknown>)
      : null,
    localPayload: JSON.parse(row.local_payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }))
}

export async function listOpenSyncConflicts(database: DatabaseConnection): Promise<SyncConflictRecord[]> {
  const rows = await database.getAllAsync<SyncConflictRow>(
    `
      SELECT
        id,
        queue_entry_id,
        local_transaction_id,
        conflict_type,
        server_payload_json,
        local_payload_json,
        created_at,
        resolved_at
      FROM sync_conflicts
      WHERE resolved_at IS NULL
      ORDER BY created_at ASC
    `
  )

  return rows.map((row) => ({
    id: row.id,
    queueEntryId: row.queue_entry_id,
    localTransactionId: row.local_transaction_id,
    conflictType: row.conflict_type,
    serverPayload: row.server_payload_json
      ? (JSON.parse(row.server_payload_json) as Record<string, unknown>)
      : null,
    localPayload: JSON.parse(row.local_payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }))
}

export async function resolveSyncConflict(
  database: DatabaseConnection,
  conflictId: string,
  resolvedAt: string
): Promise<SyncConflictRecord | null> {
  await database.runAsync(
    `
      UPDATE sync_conflicts
      SET resolved_at = ?
      WHERE id = ?
    `,
    [resolvedAt, conflictId]
  )

  const conflicts = await listSyncConflicts(database)
  return conflicts.find((conflict) => conflict.id === conflictId) ?? null
}
