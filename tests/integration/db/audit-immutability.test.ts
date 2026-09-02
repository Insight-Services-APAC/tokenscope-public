/*
 * audit_event DDL guarantees.
 *
 * 1. Append-only — UPDATE and DELETE rejected. Per
 *    docs/build/mvp-lite-epic.md §Epic 2 testing: "audit_event UPDATE/DELETE
 *    rejected". Verifies the trigger in drizzle/migrations/0001_schema.sql
 *    fires.
 * 2. The admin Audit log's default page is index-served (mig 0139): the
 *    planner picks `audit_event_recorded_desc` for the handler's unfiltered
 *    `ORDER BY ts_recorded DESC, id DESC LIMIT 50` shape.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { recordAuditEvent } from '../../../server/db/audit'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('audit_event append-only enforcement', () => {
  it('rejects UPDATE on existing rows', async () => {
    const { id } = await recordAuditEvent(t.db, {
      eventType: 'test-event',
      actorSystem: 'test',
      payload: { hello: 'world' },
    })

    await expect(
      t.client`UPDATE audit_event SET event_type = 'tampered' WHERE id = ${id}`,
    ).rejects.toThrow(/append-only/)
  })

  it('rejects DELETE on existing rows', async () => {
    const { id } = await recordAuditEvent(t.db, {
      eventType: 'test-event-2',
      actorSystem: 'test',
      payload: {},
    })

    await expect(t.client`DELETE FROM audit_event WHERE id = ${id}`).rejects.toThrow(
      /append-only/,
    )
  })

  it('recordAuditEvent helper writes a row through INSERT', async () => {
    const { id } = await recordAuditEvent(t.db, {
      eventType: 'allocation-created',
      actorTeammateId: null,
      actorSystem: 'worker:test',
      subjectKind: 'allocation',
      subjectId: null,
      payload: { before: null, after: { budget: 100 }, context: {} },
    })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    const rows = await t.client<{ event_type: string }[]>`
      SELECT event_type FROM audit_event WHERE id = ${id}
    `
    expect(rows[0]!.event_type).toBe('allocation-created')
  })
})

/*
 * Mig 0139 — the Audit log's default query (server/api/v1/admin/audit/
 * index.get.ts, no filters) must not sort the whole table. Asserted with the
 * REAL planner on 5 000 rows — no `enable_seqscan` knob — so the test says the
 * planner chooses the index at a realistic size, not merely that it exists.
 * 5 000 rows is enough that a seq scan + top-N sort costs more than a 50-row
 * index walk; at a handful of rows Postgres would seq-scan and this would
 * certify nothing.
 */
describe('audit_event newest-first index (mig 0139)', () => {
  beforeAll(async () => {
    await t.client`
      INSERT INTO audit_event (event_type, actor_system, payload, ts_recorded)
      SELECT 'index-fixture', 'test', '{}'::jsonb,
             NOW() - (g * INTERVAL '1 second')
      FROM generate_series(1, 5000) AS g
    `
    await t.client`ANALYZE audit_event`
  })

  it('exists with the handler\'s ORDER BY as its key', async () => {
    const rows = await t.client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'audit_event' AND indexname = 'audit_event_recorded_desc'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.indexdef).toMatch(/\(ts_recorded DESC, id DESC\)/)
  })

  it('serves the unfiltered newest-first page without a sort', async () => {
    // The handler's default shape verbatim: LEFT JOIN teammate for the actor
    // email, no WHERE, first page.
    const rows = await t.client<Record<string, string>[]>`
      EXPLAIN (COSTS OFF)
      SELECT ae.id::text, ae.event_type, ta.email, ae.ts_recorded
      FROM audit_event ae
      LEFT JOIN teammate ta ON ta.id = ae.actor_teammate_id
      ORDER BY ae.ts_recorded DESC, ae.id DESC
      LIMIT 50 OFFSET 0
    `
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(plan).toMatch(/Index Scan using audit_event_recorded_desc on audit_event/)
    expect(plan).not.toMatch(/Seq Scan on audit_event/)
    expect(plan).not.toMatch(/^\s*->\s+Sort/m)
  })
})
