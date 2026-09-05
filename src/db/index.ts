import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../config.js'
import { MIGRATIONS } from './migrations.js'

export type Db = DatabaseSync

let instance: Db | null = null

export function openDatabase(path: string = config.db.path): Db {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)

  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

  migrate(db)
  return db
}

export function migrate(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined

  let current = row?.version ?? 0
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()

  for (const [index, sql] of MIGRATIONS.entries()) {
    const version = index + 1
    if (version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('UPDATE schema_version SET version = ?').run(version)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${version} failed: ${(err as Error).message}`, { cause: err })
    }
    current = version
  }
  return current
}

export function db(): Db {
  if (!instance) instance = openDatabase()
  return instance
}
