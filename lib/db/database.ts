import { migrateDatabase } from './migrations'
import { LOCAL_DATABASE_NAME } from './schema'

export type DatabaseScalar = string | number | null
export type DatabaseStatementArgs = DatabaseScalar[] | Record<string, DatabaseScalar>

export type DatabaseRunResult = {
  changes: number
  lastInsertRowId: number
}

export type DatabaseConnection = {
  execAsync(statement: string): Promise<void>
  runAsync(statement: string, params?: DatabaseStatementArgs): Promise<DatabaseRunResult>
  getFirstAsync<T>(statement: string, params?: DatabaseStatementArgs): Promise<T | null>
  getAllAsync<T>(statement: string, params?: DatabaseStatementArgs): Promise<T[]>
  withTransactionAsync<T>(operation: (database: DatabaseConnection) => Promise<T>): Promise<T>
}

export async function openDatabaseConnection(name = LOCAL_DATABASE_NAME): Promise<DatabaseConnection> {
  const sqlite = await import('expo-sqlite')
  return sqlite.openDatabaseAsync(name) as unknown as Promise<DatabaseConnection>
}

export async function openInitializedDatabase(name = LOCAL_DATABASE_NAME): Promise<DatabaseConnection> {
  const database = await openDatabaseConnection(name)
  await database.execAsync('PRAGMA foreign_keys = ON')
  await migrateDatabase(database)
  return database
}
