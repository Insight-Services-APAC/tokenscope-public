/*
 * audit_event is append-only — UPDATE and DELETE rejected.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 2 testing: "audit_event
 * UPDATE/DELETE rejected". Verifies the trigger in
 * drizzle/migrations/0001_schema.sql fires.
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
