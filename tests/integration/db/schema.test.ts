/*
 * Schema smoke — migrations apply cleanly and all v0.5 tables exist.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 2 verifiable end state:
 * `npm run db:migrate` applies all migrations cleanly against the container
 * Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

const REQUIRED_TABLES = [
  'region',
  'org_unit',
  'teammate',
  'teammate_identity_map',
  'project',
  'repo_project_map',
  'project_assignment',
  'instance_attestation',
  'attribution_record',
  'attribution_aggregate',
  'activity_type',
  'rate_card',
  'rate_line',
  'allocation',
  'limit_policy',
  'tier_assignment',
  'actual_spend',
  'spill_record',
  'inbox_item',
  'audit_event',
  'sync_conflict',
]

describe('schema migrations', () => {
  it('creates every v0.5 table', async () => {
    const rows = await t.client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `
    const present = new Set(rows.map((r) => r.table_name))
    for (const expected of REQUIRED_TABLES) {
      expect(present.has(expected), `table ${expected} missing`).toBe(true)
    }
  })

  it('installs the required PG extensions', async () => {
    const rows = await t.client<{ extname: string }[]>`
      SELECT extname FROM pg_extension
    `
    const present = new Set(rows.map((r) => r.extname))
    for (const ext of ['btree_gist', 'ltree', 'pgcrypto']) {
      expect(present.has(ext), `extension ${ext} missing`).toBe(true)
    }
  })
})
