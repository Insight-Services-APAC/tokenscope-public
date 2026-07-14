// TokenScope migration runner.
//
// Runs all numbered .sql files in drizzle/migrations/ in lexical order
// against $DATABASE_URL. Hand-written migrations (not drizzle-kit-managed)
// because the data model uses PG-native constructs Drizzle's diff doesn't
// render cleanly (EXCLUDE USING gist, RLS policies, custom triggers).
//
// Records applied migrations in `_drizzle_migrations(name TEXT PRIMARY KEY,
// applied_at TIMESTAMPTZ)` so re-runs skip already-applied steps.

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }

  const sql = postgres(url, { max: 1, idle_timeout: 5 })
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS _drizzle_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    const applied = new Set(
      (await sql`SELECT name FROM _drizzle_migrations`).map((r) => r.name as string),
    )

    let appliedCount = 0
    for (const file of files) {
      if (applied.has(file)) continue
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      console.warn(`Applying ${file}...`)
      await sql.begin(async (tx) => {
        await tx.unsafe(body)
        await tx`INSERT INTO _drizzle_migrations (name) VALUES (${file})`
      })
      appliedCount += 1
    }

    console.warn(
      appliedCount
        ? `Applied ${appliedCount} migration${appliedCount === 1 ? '' : 's'}.`
        : 'All migrations already applied.',
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
