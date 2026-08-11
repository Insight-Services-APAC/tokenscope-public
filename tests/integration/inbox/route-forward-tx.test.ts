// @vitest-environment node
/*
 * Inbox forward transactionality (API-2) — the forward INSERT, the source
 * resolve UPDATE, and the audit row must commit or roll back as ONE unit.
 * Before the fix these were three separate statements on the pooled db: a
 * partial failure left a forwarded copy with the source still open
 * (double-forwarding) or an unaudited cross-recipient insert.
 *
 * Success path exercises the REAL handler; the rollback path replicates the
 * handler's transaction shape with a realistically failing audit write (FK
 * violation on actor_teammate_id) — per the endpoints.test.ts SQL-contract
 * convention.
 *
 * Cross-region (server-api-app:idor:0004 / T3-xregion-03) — RLS is inert at
 * runtime (no FORCE, owner connection), so requireRegionScope on BOTH the
 * source item's recipient AND the forward target is the live gate. Clamping
 * only one end leaves the mirror-image leak.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { recordAuditEvent } from '../../../server/db/audit'
import routePost from '../../../server/api/v1/me/inbox/[id]/route.post'

let t: TestDb
let regionId: string
let ouId: string
let regionBId: string
let ouBId: string
let lenaId: string // admin (forwarder), region A
let priyaId: string // original recipient, region A
let anilId: string // forward target, region A
let priyaBId: string // original recipient, region B
let anilBId: string // forward target, region B
let finopsId: string // global-finops (region-unbounded)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [r] = await t.db.insert(schema.region).values({ code: 'fw-r', displayName: 'FW R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'fw.svc', code: 'fw-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [rb] = await t.db.insert(schema.region).values({ code: 'fw-rb', displayName: 'FW RB' }).returning()
  regionBId = rb!.id
  const [ob] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'fwb.svc', code: 'fwb-svc', displayName: 'Svc B', unitType: 'bu' })
    .returning()
  ouBId = ob!.id
  const mk = async (oid: string, email: string, opts?: { role?: string; regionId?: string; orgUnitId?: string }) => {
    const [row] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: oid,
        email,
        regionId: opts?.regionId ?? regionId,
        orgUnitId: opts?.orgUnitId ?? ouId,
        ...(opts?.role ? { role: opts.role } : {}),
      })
      .returning()
    return row!.id
  }
  lenaId = await mk('oid-fw-lena', 'fw-lena@x.test', { role: 'admin' })
  priyaId = await mk('oid-fw-priya', 'fw-priya@x.test')
  anilId = await mk('oid-fw-anil', 'fw-anil@x.test')
  priyaBId = await mk('oid-fw-priya-b', 'fw-priya-b@x.test', { regionId: regionBId, orgUnitId: ouBId })
  anilBId = await mk('oid-fw-anil-b', 'fw-anil-b@x.test', { regionId: regionBId, orgUnitId: ouBId })
  finopsId = await mk('oid-fw-finops', 'fw-finops@x.test', { role: 'global-finops' })
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function seedItem(recipientTeammateId: string = priyaId): Promise<string> {
  const [item] = await t.db
    .insert(schema.inboxItem)
    .values({
      recipientTeammateId,
      category: 'budget-alert',
      severity: 'warning',
      subject: 'Project over budget',
      body: { detail: 'seed' },
    })
    .returning({ id: schema.inboxItem.id })
  return item!.id
}

function ev(opts: { id: string; body: unknown; session?: Session }) {
  const session: Session = opts.session ?? {
    teammateId: lenaId,
    email: 'fw-lena@x.test',
    displayName: 'Lena',
    role: 'admin',
    regionId,
    orgPath: 'fw.svc',
  }
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: { id: opts.id } },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof routePost>[0]
}

describe('inbox forward (API-2)', () => {
  it('handler success path: forwarded item + resolved source + audit row all land', async () => {
    const sourceId = await seedItem()
    const res = (await routePost(
      ev({ id: sourceId, body: { recipient_teammate_id: anilId, reason: 'wrong manager' } }),
    )) as { source_id: string; forwarded_id: string | null }

    expect(res.source_id).toBe(sourceId)
    expect(res.forwarded_id).toBeTruthy()

    const [source] = await t.db.execute<{ ack_state: string }>(sql`
      SELECT ack_state FROM inbox_item WHERE id = ${sourceId}::uuid
    `)
    expect(source!.ack_state).toBe('resolved')

    const [forwarded] = await t.db.execute<{ recipient_teammate_id: string; subject: string }>(sql`
      SELECT recipient_teammate_id::text AS recipient_teammate_id, subject
      FROM inbox_item WHERE id = ${res.forwarded_id}::uuid
    `)
    expect(forwarded!.recipient_teammate_id).toBe(anilId)
    expect(forwarded!.subject).toBe('[Forwarded] Project over budget')

    const [audit] = await t.db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'inbox-routed' AND subject_id = ${sourceId}::uuid
    `)
    expect(Number(audit!.n)).toBe(1)
  })

  it('a failing audit write rolls back the forward AND the resolve (atomicity)', async () => {
    const sourceId = await seedItem()
    const ghostActor = randomUUID() // not a teammate → FK violation on audit insert

    await expect(
      t.db.transaction(async (tx) => {
        // Same three writes as the handler's transaction.
        const [forwarded] = await tx
          .insert(schema.inboxItem)
          .values({
            recipientTeammateId: anilId,
            category: 'budget-alert',
            severity: 'warning',
            subject: '[Forwarded] Project over budget',
            body: { forwarded_from_inbox_item_id: sourceId },
          })
          .returning({ id: schema.inboxItem.id })
        await tx.execute(sql`
          UPDATE inbox_item
          SET ack_state = 'resolved', ack_at = NOW(), ack_by = ${lenaId}::uuid
          WHERE id = ${sourceId}::uuid
        `)
        await recordAuditEvent(tx as never, {
          eventType: 'inbox-routed',
          actorTeammateId: ghostActor,
          actorSystem: 'inbox',
          subjectKind: 'inbox_item',
          subjectId: sourceId,
          payload: { new_inbox_item_id: forwarded?.id ?? null },
        })
      }),
    ).rejects.toThrow()

    // Nothing from the failed forward may persist: source still open, no copy.
    const [source] = await t.db.execute<{ ack_state: string }>(sql`
      SELECT ack_state FROM inbox_item WHERE id = ${sourceId}::uuid
    `)
    expect(source!.ack_state).toBe('unread')

    const [copies] = await t.db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM inbox_item
      WHERE body->>'forwarded_from_inbox_item_id' = ${sourceId}
    `)
    expect(Number(copies!.n)).toBe(0)
  })
})

// Lazy: finopsId/regionId are only populated once beforeAll has run, which is
// guaranteed by the time any `it()` body calls this (a plain const object here
// would capture undefined — evaluated at module load, before beforeAll runs).
const finopsSession = (): Session => ({
  teammateId: finopsId,
  email: 'fw-finops@x.test',
  displayName: 'Finops',
  role: 'global-finops',
  regionId,
  orgPath: 'fw.svc',
})

describe('inbox forward — cross-region clamp (both ends)', () => {
  it('region-A admin forwarding a region-B recipient\'s item is denied, source unchanged (SOURCE clamp)', async () => {
    const sourceId = await seedItem(priyaBId) // recipient is in region B
    await expect(
      routePost(ev({ id: sourceId, body: { recipient_teammate_id: anilId } })),
    ).rejects.toMatchObject({ statusCode: 403 })

    const [source] = await t.db.execute<{ ack_state: string }>(sql`
      SELECT ack_state FROM inbox_item WHERE id = ${sourceId}::uuid
    `)
    expect(source!.ack_state).toBe('unread')
  })

  it('region-A admin forwarding to a region-B target is denied, source unchanged (TARGET clamp)', async () => {
    const sourceId = await seedItem(priyaId) // recipient is in region A (lena's own region)
    await expect(
      routePost(ev({ id: sourceId, body: { recipient_teammate_id: anilBId } })),
    ).rejects.toMatchObject({ statusCode: 403 })

    const [source] = await t.db.execute<{ ack_state: string }>(sql`
      SELECT ack_state FROM inbox_item WHERE id = ${sourceId}::uuid
    `)
    expect(source!.ack_state).toBe('unread')
  })

  it('global-finops forwards a region-B item to a region-A target — succeeds (region-unbounded)', async () => {
    const sourceId = await seedItem(priyaBId)
    const res = (await routePost(
      ev({ id: sourceId, body: { recipient_teammate_id: anilId }, session: finopsSession() }),
    )) as { source_id: string; forwarded_id: string | null }
    expect(res.forwarded_id).toBeTruthy()
    const [source] = await t.db.execute<{ ack_state: string }>(sql`
      SELECT ack_state FROM inbox_item WHERE id = ${sourceId}::uuid
    `)
    expect(source!.ack_state).toBe('resolved')
  })

  it('global-finops forwards a region-A item to a region-B target — succeeds (region-unbounded)', async () => {
    const sourceId = await seedItem(priyaId)
    const res = (await routePost(
      ev({ id: sourceId, body: { recipient_teammate_id: anilBId }, session: finopsSession() }),
    )) as { source_id: string; forwarded_id: string | null }
    expect(res.forwarded_id).toBeTruthy()
    const [source] = await t.db.execute<{ ack_state: string }>(sql`
      SELECT ack_state FROM inbox_item WHERE id = ${sourceId}::uuid
    `)
    expect(source!.ack_state).toBe('resolved')
  })
})
