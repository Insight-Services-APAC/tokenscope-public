/*
 * Integration-test DB helper — testcontainers-backed Postgres.
 *
 * Per AGENTS.md anti-pattern §"Never mock Drizzle — use a real test DB
 * via testcontainers". Each test file spins up its own container and
 * runs migrations once. Slow but honest.
 *
 * Container image is `postgres:16` so the test environment matches prod
 * (data-model.md is PG-16-specific).
 *
 * TEST_PG_URL escape hatch: environments with NO container runtime (e.g. a
 * devcontainer without a docker/podman socket) can point TEST_PG_URL at any
 * PG-16 server with ltree/pgcrypto/btree_gist available; each suite then
 * provisions its own throwaway database there — same real-PG16 +
 * full-migrations honesty, per-suite isolation preserved.
 */
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Wait } from 'testcontainers'
import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '../../../drizzle/schema'

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'drizzle',
  'migrations',
)

export interface TestDb {
  /** null when running against an external server (TEST_PG_URL). */
  container: StartedPostgreSqlContainer | null
  client: ReturnType<typeof postgres>
  db: PostgresJsDatabase<typeof schema>
  url: string
  /** External-server teardown (drops the per-suite database). */
  teardown?: () => Promise<void>
}

async function runMigrations(client: ReturnType<typeof postgres>): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    await client.unsafe(body)
  }
}

export async function startTestDb(): Promise<TestDb> {
  const external = process.env.TEST_PG_URL
  if (external) {
    const dbName = `tokenscope_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    // dbName is self-generated hex, but it is interpolated into unsafe() DDL
    // (CREATE/DROP DATABASE cannot be parameterised) — pin the shape so a
    // future edit to the generation can't turn this into identifier injection.
    if (!/^tokenscope_test_[0-9a-f]{12}$/.test(dbName)) {
      throw new Error(`test db name escaped its expected shape: ${dbName}`)
    }
    const admin = postgres(external, { max: 1 })
    try {
      await admin.unsafe(`CREATE DATABASE ${dbName}`)
    } finally {
      await admin.end({ timeout: 5 })
    }
    let u: URL
    try {
      u = new URL(external)
    } catch {
      throw new Error(`TEST_PG_URL is not a valid URL: ${external}`)
    }
    u.pathname = `/${dbName}`
    const url = u.toString()
    const client = postgres(url, { max: 4, idle_timeout: 5 })
    const db = drizzle(client, { schema })
    await runMigrations(client)
    return {
      container: null,
      client,
      db,
      url,
      teardown: async () => {
        const adm = postgres(external, { max: 1 })
        try {
          await adm.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
        } finally {
          await adm.end({ timeout: 5 })
        }
      },
    }
  }

  // Disable Ryuk — rootless podman in the cw worker can't bind-mount the
  // docker socket into Ryuk's container (statfs perm denied). Our afterAll
  // hooks own teardown explicitly, so the reaper isn't load-bearing here.
  if (!process.env.TESTCONTAINERS_RYUK_DISABLED) {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true'
  }

  // Two paths:
  //   1. cw worker (CW_NETWORK set + the worker owns host ports 3451-3455):
  //      attach to the cw network, use container DNS, log-message wait.
  //   2. anywhere else (GitHub Actions, plain docker): default host-port
  //      mapping + HostPortWaitStrategy.
  const cwNetwork = process.env.CW_NETWORK
  const usingCw = Boolean(cwNetwork) && cwNetwork !== 'bridge'

  let builder = new PostgreSqlContainer('postgres:16')
    .withDatabase('tokenscope_test')
    .withUsername('tokenscope')
    .withPassword('tokenscope')

  if (usingCw) {
    builder = builder
      .withNetworkMode(cwNetwork!)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
  }

  const container = await builder.start()

  let url: string
  if (usingCw) {
    const containerName = container.getName().replace(/^\//, '')
    url = `postgresql://tokenscope:tokenscope@${containerName}:5432/tokenscope_test`
  } else {
    url = container.getConnectionUri()
  }
  const client = postgres(url, { max: 4, idle_timeout: 5 })
  const db = drizzle(client, { schema })

  await runMigrations(client)

  return { container, client, db, url }
}

export async function stopTestDb(t: TestDb): Promise<void> {
  await t.client.end({ timeout: 5 })
  if (t.container) await t.container.stop()
  if (t.teardown) await t.teardown()
}
