import {
  LOCAL_SCHEMA_VERSION,
  SCHEMA_V1_STATEMENTS,
  SCHEMA_V2_STATEMENTS,
  SCHEMA_V3_STATEMENTS,
  SCHEMA_V4_STATEMENTS,
} from './schema'
import type { DatabaseConnection } from './database'

type MigrationStep = {
  version: number
  statements: readonly string[]
}

const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    statements: SCHEMA_V1_STATEMENTS,
  },
  {
    version: 2,
    statements: SCHEMA_V2_STATEMENTS,
  },
  {
    version: 3,
    statements: SCHEMA_V3_STATEMENTS,
  },
  {
    version: 4,
    statements: SCHEMA_V4_STATEMENTS,
  },
]

export async function getSchemaVersion(database: DatabaseConnection): Promise<number> {
  await database.execAsync('PRAGMA foreign_keys = ON')

  const row = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version')
  return row?.user_version ?? 0
}

export async function migrateDatabase(
  database: DatabaseConnection,
  targetVersion = LOCAL_SCHEMA_VERSION
): Promise<number> {
  if (targetVersion < 1 || targetVersion > LOCAL_SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version target: ${targetVersion}`)
  }

  let currentVersion = await getSchemaVersion(database)
  if (currentVersion >= targetVersion) {
    return currentVersion
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion || migration.version > targetVersion) {
      continue
    }

    await database.withTransactionAsync(async (transaction) => {
      for (const statement of migration.statements) {
        await transaction.execAsync(statement)
      }

      await transaction.execAsync(`PRAGMA user_version = ${migration.version}`)
    })

    currentVersion = migration.version
  }

  return currentVersion
}
