import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

class Statement {
  constructor(
    readonly db: DatabaseSync,
    readonly sql: string,
    readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(
      this.db,
      this.sql,
      values.map(
        (value) =>
          (typeof value === 'boolean'
            ? Number(value)
            : (value ?? null)) as SQLInputValue,
      ),
    )
  }

  execute() {
    const statement = this.db.prepare(this.sql)
    if (statement.columns().length) {
      const results = statement.all(...this.values).map((row) => ({ ...row }))
      return { results, success: true, meta: { changes: results.length } }
    }
    const info = statement.run(...this.values)
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    }
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.execute().results[0] as Record<string, unknown> | undefined
    if (!row) return null
    return (column ? row[column] : row) as T
  }

  async all<T>() {
    return this.execute() as {
      results: T[]
      success: true
      meta: { changes: number }
    }
  }

  async run() {
    return this.execute()
  }
}

export function createD1(): D1Database {
  const db = new DatabaseSync(':memory:')
  const d1 = {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec('BEGIN')
      try {
        const results = statements.map((statement) => statement.execute())
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    async exec(sql: string) {
      db.exec(sql)
      return { count: 0, duration: 0 }
    },
  }
  return d1 as unknown as D1Database
}
