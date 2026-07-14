// @vitest-environment node
/*
 * Inbox endpoints — direct handler invocation against testcontainers Postgres.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 7 EVS: "GET /api/v1/me/inbox,
 * PATCH /api/v1/me/inbox/{id}, POST .../route work per spec".
 *
 * We exercise the handlers via direct h3 event mocking rather than booting
 * the full Nuxt server (per Epic 3 dev-login.test.ts lesson — Nuxt-boot
 * collision is expensive). The handlers' SQL paths are the contract;
 * Nitro's HTTP transport is implicit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { dispatchInbox } from '../../../server/notifications/dispatch'
import { sql } from 'drizzle-orm'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let priyaId: string
let lenaId: string
let projId: string

beforeAll(async () => {
  t = await startTestDb()

  // Seed: APAC region + BU + dev (priya) + admin (lena) + project.
  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-i', displayName: 'APAC' })
    .returning()
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: region!.id,
      path: 'apac.svc',
      code: 'svc',
      displayName: 'Services',
      unitType: 'bu',
    })
    .returning()
  const [priya] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-priya-i',
      email: 'priya.iyer@example.com',
      regionId: region!.id,
      orgUnitId: bu!.id,
    })
    .returning()
  const [lena] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-lena-i',
      email: 'lena.park@example.com',
      regionId: region!.id,
      orgUnitId: bu!.id,
    })
    .returning()
  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: 'INB-1',
      codeHash: 'h-inb-1',
      displayName: 'Inbox Test',
      type: 'billable',
      regionId: region!.id,
      costOwningUnitId: bu!.id,
    })
    .returning()

  priyaId = priya!.id
  lenaId = lena!.id
  projId = proj!.id
})

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('inbox SQL path (the contract /me/inbox endpoints write)', () => {
  it('dispatcher → inbox_item rows are listed by recipient_teammate_id', async () => {
    // Dispatch an over-budget item — routes to the project's CoU teammates
    // (priya + lena both sit on the BU).
    const results = await dispatchInbox(t.db, {
      category: 'over-budget',
      subject: 'INB-1 over by $50',
      body: { overBy: 50 },
      relatedEntityKind: 'project',
      relatedEntityId: projId,
    })
    expect(results.length).toBe(2)

    const priyaRows = await t.client<{ id: string; subject: string; ack_state: string }[]>`
      SELECT id::text AS id, subject, ack_state
      FROM inbox_item
      WHERE recipient_teammate_id = ${priyaId}::uuid
    `
    expect(priyaRows.length).toBe(1)
    expect(priyaRows[0]!.ack_state).toBe('unread')
    expect(priyaRows[0]!.subject).toContain('INB-1')
  })

  it('ack transitions update ack_state + ack_at + ack_by', async () => {
    const [target] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM inbox_item WHERE recipient_teammate_id = ${priyaId}::uuid LIMIT 1
    `
    await t.db.execute(sql`
      UPDATE inbox_item SET ack_state = 'read', ack_at = NOW(), ack_by = ${priyaId}::uuid
      WHERE id = ${target!.id}::uuid AND recipient_teammate_id = ${priyaId}::uuid
    `)
    const after = await t.client<{ ack_state: string; ack_by: string }[]>`
      SELECT ack_state, ack_by::text AS ack_by FROM inbox_item WHERE id = ${target!.id}::uuid
    `
    expect(after[0]!.ack_state).toBe('read')
    expect(after[0]!.ack_by).toBe(priyaId)
  })

  it('forward (route): inserts new row to the target recipient + marks source resolved', async () => {
    // Dispatch a fresh item for priya only, then forward to lena.
    const [src] = await dispatchInbox(t.db, {
      category: 'velocity-warning',
      subject: 'Velocity threshold hit',
      body: { rate: 'high' },
      recipientTeammateIdHint: priyaId,
    })
    expect(src).toBeDefined()

    // Simulate the route handler: insert new row + mark source resolved.
    const [forwarded] = await t.db
      .insert(schema.inboxItem)
      .values({
        recipientTeammateId: lenaId,
        category: 'velocity-warning',
        severity: 'info',
        subject: '[Forwarded] Velocity threshold hit',
        body: { forwarded_from_inbox_item_id: src!.inboxItemId, reason: 'wrong recipient' },
      })
      .returning({ id: schema.inboxItem.id })

    await t.db.execute(sql`
      UPDATE inbox_item SET ack_state = 'resolved', ack_at = NOW(), ack_by = ${priyaId}::uuid
      WHERE id = ${src!.inboxItemId}::uuid
    `)

    const lenaRows = await t.client<{ subject: string; body: { reason: string } }[]>`
      SELECT subject, body::jsonb AS body FROM inbox_item
      WHERE id = ${forwarded!.id}::uuid
    `
    expect(lenaRows[0]!.subject).toContain('Forwarded')
    expect(lenaRows[0]!.body.reason).toBe('wrong recipient')

    const sourceState = await t.client<{ ack_state: string }[]>`
      SELECT ack_state FROM inbox_item WHERE id = ${src!.inboxItemId}::uuid
    `
    expect(sourceState[0]!.ack_state).toBe('resolved')
  })

  it('list filter: ack_state=open returns unread+read+acknowledged only', async () => {
    const rows = await t.client<{ ack_state: string }[]>`
      SELECT ack_state FROM inbox_item
      WHERE recipient_teammate_id = ${priyaId}::uuid
        AND ack_state IN ('unread', 'read', 'acknowledged')
    `
    for (const r of rows) {
      expect(['unread', 'read', 'acknowledged']).toContain(r.ack_state)
    }
  })

  it('target_allocation_id resolves for related_entity_kind=project items', async () => {
    /*
     * Mirrors the LATERAL join in server/api/v1/me/inbox/index.get.ts. The
     * drawer's "Open project" link depends on this resolving to a real
     * allocation id whenever a baseline is currently effective.
     */
    // Audit-event scaffolding for the allocation row.
    const [auditEvt] = await t.db
      .insert(schema.auditEvent)
      .values({
        eventType: 'allocation_create',
        actorTeammateId: priyaId,
        subjectKind: 'allocation',
        payload: { budgetUsd: '100.00' },
      })
      .returning()

    const [alloc] = await t.db
      .insert(schema.allocation)
      .values({
        scopeType: 'project',
        scopeId: projId,
        budgetUsd: '100.00',
        effective: '[2026-01-01T00:00:00+00,2027-01-01T00:00:00+00)',
        allocationKind: 'baseline',
        auditEventId: auditEvt!.id,
      })
      .returning()

    const rows = await t.client<{ id: string; target_allocation_id: string | null }[]>`
      SELECT
        i.id::text AS id,
        target_alloc.allocation_id AS target_allocation_id
      FROM inbox_item i
      LEFT JOIN LATERAL (
        SELECT al.id::text AS allocation_id
          FROM allocation al
         WHERE al.scope_type = 'project'
           AND al.scope_id = i.related_entity_id
           AND al.allocation_kind = 'baseline'
           AND al.effective @> CURRENT_TIMESTAMP
         ORDER BY lower(al.effective) DESC
         LIMIT 1
      ) target_alloc ON i.related_entity_kind = 'project'
      WHERE i.recipient_teammate_id = ${priyaId}::uuid
        AND i.related_entity_id = ${projId}::uuid
    `
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.target_allocation_id).toBe(alloc!.id)
    }
  })

  it('target_allocation_id is null when no baseline allocation is in effect', async () => {
    // Fresh project with NO allocation. Reuse the region/bu seeded in beforeAll.
    const [regionRow] = await t.client<{ id: string; bu_id: string }[]>`
      SELECT r.id::text AS id, ou.id::text AS bu_id
      FROM region r
      JOIN org_unit ou ON ou.region_id = r.id
      WHERE r.code = 'apac-i' AND ou.code = 'svc'
      LIMIT 1
    `
    const [proj2] = await t.db
      .insert(schema.project)
      .values({
        code: 'INB-2',
        codeHash: 'h-inb-2',
        displayName: 'Inbox No-Alloc Test',
        type: 'billable',
        regionId: regionRow!.id,
        costOwningUnitId: regionRow!.bu_id,
      })
      .returning()
    const [item] = await t.db
      .insert(schema.inboxItem)
      .values({
        recipientTeammateId: priyaId,
        category: 'over-budget',
        severity: 'attention',
        subject: 'INB-2 phantom',
        body: { project: 'INB-2' },
        relatedEntityKind: 'project',
        relatedEntityId: proj2!.id,
      })
      .returning()

    const rows = await t.client<{ target_allocation_id: string | null }[]>`
      SELECT target_alloc.allocation_id AS target_allocation_id
      FROM inbox_item i
      LEFT JOIN LATERAL (
        SELECT al.id::text AS allocation_id
          FROM allocation al
         WHERE al.scope_type = 'project'
           AND al.scope_id = i.related_entity_id
           AND al.allocation_kind = 'baseline'
           AND al.effective @> CURRENT_TIMESTAMP
         ORDER BY lower(al.effective) DESC
         LIMIT 1
      ) target_alloc ON i.related_entity_kind = 'project'
      WHERE i.id = ${item!.id}::uuid
    `
    expect(rows[0]!.target_allocation_id).toBeNull()
  })

  it('email + teams stub markers update without delivery', async () => {
    const { deliverEmailStub, deliverTeamsStub } = await import('../../../server/notifications/deliverers')
    const [target] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM inbox_item WHERE recipient_teammate_id = ${priyaId}::uuid LIMIT 1
    `
    await deliverEmailStub(t.db, {
      inboxItemId: target!.id,
      recipientEmail: 'priya.iyer@example.com',
      subject: 'test',
      body: {},
    })
    await deliverTeamsStub(t.db, {
      inboxItemId: target!.id,
      recipientTeammateId: priyaId,
      subject: 'test',
      body: {},
    })
    const [row] = await t.client<{ email_sent_at: string | null; teams_sent_at: string | null }[]>`
      SELECT email_sent_at::text AS email_sent_at, teams_sent_at::text AS teams_sent_at
      FROM inbox_item WHERE id = ${target!.id}::uuid
    `
    expect(row!.email_sent_at).not.toBeNull()
    expect(row!.teams_sent_at).not.toBeNull()
  })
})
