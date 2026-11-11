// @vitest-environment node
/*
 * POST /api/v1/me/inbox/bulk (#574) and the list's page cursor (#569), on the
 * REAL handlers against Postgres (the event shape of category-groups.test.ts).
 *
 *   - Selected rows: exactly those change; another teammate's id is ignored and
 *     reported as not changed; Mark read never reopens a closed item; one
 *     `inbox-acked` audit row per changed item, none for the rest.
 *   - "Mark all read": every unread item matching the filters, past the first
 *     page too; other groups and other teammates untouched.
 *   - The cursor: pages are disjoint and cover every match, newest first, even
 *     when many rows share one created_at (a dispatcher fan-out); `total`
 *     counts every match whatever the cursor; a forged cursor is a 400.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import listHandler from '../../../server/api/v1/me/inbox/index.get'
import bulkHandler from '../../../server/api/v1/me/inbox/bulk.post'

let t: TestDb
let regionId = ''
const ME = '9a1e0000-0000-4000-8000-0000000000c1'
const OTHER = '9a1e0000-0000-4000-8000-0000000000c2'

const session = (): Session =>
  ({ teammateId: ME, email: 'me@x.test', displayName: 'Me', role: 'developer', regionId, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)

function event(method: 'GET' | 'POST', url: string, body?: unknown) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450', 'content-type': 'application/json' }
  const e = {
    method, path: url, context: { params: {} },
    node: {
      req: { method, url, body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: {
        _headers: {} as Record<string, unknown>, statusCode: 200,
        getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session())
  return e
}
interface ListResp { items: { id: string; category: string; ack_state: string; created_at: string }[]; total: number; next_cursor: string | null }
const list = async (qs: string) => (await listHandler(event('GET', `/api/v1/me/inbox?${qs}`) as never)) as unknown as ListResp
const bulk = async (body: unknown) =>
  (await bulkHandler(event('POST', '/api/v1/me/inbox/bulk', body) as never)) as unknown as { changed: number; not_changed: string[] }

async function seed(recipient: string, category: string, n: number, opts: { createdAt?: string; ackState?: string } = {}): Promise<string[]> {
  const rows = await t.client<{ id: string }[]>`
    INSERT INTO inbox_item (recipient_teammate_id, category, severity, subject, body, ack_state, created_at)
    SELECT ${recipient}::uuid, ${category}, 'info', 'seeded ' || g, '{}'::jsonb, ${opts.ackState ?? 'unread'},
           COALESCE(${opts.createdAt ?? null}::timestamptz, now() - (g || ' minutes')::interval)
      FROM generate_series(1, ${n}) g
    RETURNING id::text AS id`
  return rows.map((r) => r.id)
}
const states = async (ids: string[]) =>
  Object.fromEntries(
    (await t.client<{ id: string; ack_state: string }[]>`
      SELECT id::text AS id, ack_state FROM inbox_item WHERE id = ANY(${ids}::uuid[])`).map((r) => [r.id, r.ack_state]),
  )
const audits = async (ids: string[]) =>
  Number((await t.client<{ n: string }[]>`
    SELECT count(*)::text AS n FROM audit_event
     WHERE event_type = 'inbox-acked' AND subject_kind = 'inbox_item' AND subject_id = ANY(${ids}::uuid[])`)[0]!.n)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  await t.client`INSERT INTO region (code, display_name) VALUES ('ibp', 'Inbox bulk')`
  regionId = (await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'ibp'`)[0]!.id
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'ibp'::ltree, 'ibp', 'Unit', 'bu', true)`
  const unitId = (await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = 'ibp'`)[0]!.id
  for (const id of [ME, OTHER]) {
    await t.client`INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id, role)
      VALUES (${id}::uuid, ${`oid-${id}`}, ${`${id}@x.test`}, ${regionId}::uuid, ${unitId}::uuid, 'developer')`
  }
})

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('bulk: selected rows', () => {
  it('Resolve on three rows closes exactly those three, and audits each', async () => {
    const mine = await seed(ME, 'velocity-warning', 5)
    const pick = mine.slice(0, 3)
    const res = await bulk({ ids: pick, ack_state: 'resolved' })
    expect(res).toMatchObject({ changed: 3, not_changed: [] })
    const after = await states(mine)
    expect(pick.map((id) => after[id])).toEqual(['resolved', 'resolved', 'resolved'])
    expect(mine.slice(3).map((id) => after[id])).toEqual(['unread', 'unread'])
    expect(await audits(pick)).toBe(3)
    expect(await audits(mine.slice(3))).toBe(0)
  })

  it("another teammate's item id is ignored and reported as not changed", async () => {
    const [mine] = await seed(ME, 'velocity-warning', 1)
    const [theirs] = await seed(OTHER, 'velocity-warning', 1)
    const res = await bulk({ ids: [mine, theirs], ack_state: 'dismissed' })
    expect(res.changed).toBe(1)
    expect(res.not_changed).toEqual([theirs])
    expect(await states([mine!, theirs!])).toEqual({ [mine!]: 'dismissed', [theirs!]: 'unread' })
    expect(await audits([theirs!])).toBe(0)
  })

  it('Mark read never reopens a resolved item', async () => {
    const [closed] = await seed(ME, 'velocity-warning', 1, { ackState: 'resolved' })
    const [open] = await seed(ME, 'velocity-warning', 1)
    const res = await bulk({ ids: [closed, open], ack_state: 'read' })
    expect(res).toMatchObject({ changed: 1, not_changed: [closed] })
    expect(await states([closed!, open!])).toEqual({ [closed!]: 'resolved', [open!]: 'read' })
  })

  it('refuses an empty list, a state it does not offer, and ids that are not uuids', async () => {
    await expect(bulk({ ids: [], ack_state: 'read' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(bulk({ ids: [ME], ack_state: 'unread' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(bulk({ ids: ['x'], ack_state: 'read' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(bulk({ all_unread: {}, ack_state: 'resolved' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a refused body names the field that failed, for either shape', async () => {
    await expect(bulk({ all_unread: {}, ack_state: 'resolved' })).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: expect.stringContaining('ack_state'),
    })
    await expect(bulk({ ids: ['x'], ack_state: 'read' })).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: expect.stringContaining('ids'),
    })
  })
})

describe('bulk: Mark all read', () => {
  it('marks every unread item in the group, past the first page, and nothing else', async () => {
    const health = await seed(ME, 'went-silent', 120)
    const budgets = await seed(ME, 'over-budget', 2)
    const theirs = await seed(OTHER, 'went-silent', 2)
    const firstPage = await list('ack_state=unread&group=data-health')
    expect(firstPage.items).toHaveLength(50)
    expect(firstPage.total).toBe(120)

    const res = await bulk({ all_unread: { group: 'data-health' }, ack_state: 'read' })
    expect(res.changed).toBe(120)
    expect(Object.values(await states(health)).every((s) => s === 'read')).toBe(true)
    expect(Object.values(await states(budgets))).toEqual(['unread', 'unread'])
    expect(Object.values(await states(theirs))).toEqual(['unread', 'unread'])
    expect(await audits(health)).toBe(120)
    expect((await list('ack_state=unread&group=data-health')).total).toBe(0)
  })
})

describe('bulk: a large Mark all read', () => {
  it('1,200 unread items are marked and audited in one call (audit rows go in batches)', async () => {
    const many = await seed(ME, 'ops-alert', 1200)
    const res = await bulk({ all_unread: { category: 'ops-alert' }, ack_state: 'read' })
    expect(res.changed).toBe(1200)
    expect(await audits(many)).toBe(1200)
  })
})

describe('list: the page cursor', () => {
  it('pages are disjoint, cover every match newest first, and total ignores the cursor', async () => {
    // 30 rows in one instant (a fan-out) and 40 spread out: ties on created_at.
    const tied = await seed(ME, 'project-ending-soon', 30, { createdAt: '2026-11-01T00:00:00Z' })
    const spread = await seed(ME, 'project-ending-soon', 40)
    const all = new Set([...tied, ...spread])
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const r: ListResp = await list(`group=projects&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(r.total).toBe(70)
      seen.push(...r.items.map((i) => i.id))
      cursor = r.next_cursor
      pages += 1
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toHaveLength(70)
    expect(new Set(seen)).toEqual(all)
    const stamps = (await list('group=projects&limit=200')).items.map((i) => Date.parse(i.created_at))
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps)
  })

  it('the last page has no next cursor', async () => {
    const r = await list('group=requests&limit=50')
    expect(r.next_cursor).toBeNull()
  })

  it('refuses a cursor it did not mint', async () => {
    await expect(list('cursor=2026-11-01')).rejects.toMatchObject({ statusCode: 400 })
    await expect(list(`cursor=${encodeURIComponent("2026-11-01T00:00:00.000000Z_x' OR 1=1")}`)).rejects.toMatchObject({ statusCode: 400 })
  })
})
