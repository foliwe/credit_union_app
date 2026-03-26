import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js'

import type { DatabaseConnection, DatabaseStatementArgs } from './database'

const require = createRequire(import.meta.url)

let sqlPromise: Promise<SqlJsStatic> | null = null

async function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile(file: string) {
        return pathToFileURL(require.resolve(`sql.js/dist/${file}`)).href
      },
    })
  }

  return sqlPromise
}

export class SqlJsTestDatabase implements DatabaseConnection {
  constructor(private readonly database: SqlJsDatabase) {}

  static async create(snapshot?: Uint8Array) {
    const sql = await getSql()
    return new SqlJsTestDatabase(new sql.Database(snapshot))
  }

  async execAsync(statements: string) {
    this.database.exec(statements)
  }

  async runAsync(statement: string, params: DatabaseStatementArgs = []) {
    const prepared = this.database.prepare(statement)

    try {
      prepared.bind(params as never)
      prepared.step()
    } finally {
      prepared.free()
    }

    const lastInsertRow = this.database.exec('SELECT last_insert_rowid() AS id')
    const result = lastInsertRow[0]?.values[0]?.[0]

    return {
      changes: this.database.getRowsModified(),
      lastInsertRowId: typeof result === 'number' ? result : Number(result ?? 0),
    }
  }

  async getFirstAsync<T>(statement: string, params: DatabaseStatementArgs = []): Promise<T | null> {
    const rows = await this.getAllAsync<T>(statement, params)
    return rows[0] ?? null
  }

  async getAllAsync<T>(statement: string, params: DatabaseStatementArgs = []): Promise<T[]> {
    const prepared = this.database.prepare(statement)

    try {
      prepared.bind(params as never)
      const rows: T[] = []

      while (prepared.step()) {
        rows.push(prepared.getAsObject() as T)
      }

      return rows
    } finally {
      prepared.free()
    }
  }

  async withTransactionAsync<T>(operation: (database: DatabaseConnection) => Promise<T>): Promise<T> {
    this.database.exec('BEGIN')

    try {
      const result = await operation(this)
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  export() {
    return this.database.export()
  }
}