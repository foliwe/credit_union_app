declare module 'sql.js' {
  export type SqlJsValue = string | number | Uint8Array | null

  export type SqlJsPreparedStatement = {
    bind(values?: unknown): void
    step(): boolean
    getAsObject(): Record<string, unknown>
    free(): void
  }

  export type Database = {
    exec(sql: string): Array<{ values: SqlJsValue[][] }>
    prepare(sql: string): SqlJsPreparedStatement
    getRowsModified(): number
    export(): Uint8Array
  }

  export type SqlJsStatic = {
    Database: new (data?: Uint8Array) => Database
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string
  }): Promise<SqlJsStatic>
}