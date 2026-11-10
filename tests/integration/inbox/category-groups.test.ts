// @vitest-environment node
/*
 * GET /api/v1/me/inbox filters by category group, and counts per group (#546).
 *
 * One item of every category the server writes is seeded for one teammate
 * (open), plus one resolved and one dismissed item. Each group returns exactly
 * its own categories; `open` hides resolved and dismissed, `closed` shows only
 * them; group_counts follows status and ignores the group. Runs the REAL
 * handler against Postgres (same event shape as open-project-link.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/me/inbox/index.get'
import {
  INBOX_CATEGORY_GROUPS,
  KNOWN_INBOX_CATEGORIES,
  categoriesInGroup,
  type InboxCategoryGroup,
} from '../../../shared/inbox/categories'

let t: TestDb
let regionId = ''
const ME = '9a1e0000-0000-4000-8000-0000000000b1'
const OTHER = '9a1e0000-0000-4000-8000-0000000000b2'
const UNKNOWN = 'brand-new-category'

const ev = (session: Session, qs: string) => {
  const url = `/api/v1/me/inbox${qs ? `?${qs}` : ''}`
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET', path: url, context: { params: {} },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof handler>[0]
}
const me = (): Session =>
  ({ teammateId: ME, email: 'me@x.test', displayName: 'Me', role: 'developer', regionId, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)

interface Resp { items: { category: string; ack_state: string }[]; total: number; group_counts: Record<InboxCategoryGroup, number> }
const list = async (qs: string) => (await handler(ev(me(), qs))) as unknown as Resp

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  await t.client`INSERT INTO region (code, display_name) VALUES ('icg', 'Inbox groups')`
  regionId = (await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'icg'`)[0]!.id
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'icg'::ltree, 'icg', 'Unit', 'bu', true)`
  const unitId = (await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = 'icg'`)[0]!.id
  for (const id of [ME, OTHER]) {
    await t.client`INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id, role)
      VALUES (${id}::uuid, ${`oid-${id}`}, ${`${id}@x.test`}, ${regionId}::uuid, ${unitId}::uuid, 'developer')`
  }
  // Open items in all three open states, and two severities, so Open and the
  // counts are proven across states rather than on unread alone.
  const OPEN_STATES = ['unread', 'read', 'acknowledged'] as const
  for (const [i, category] of KNOWN_INBOX_CATEGORIES.entries()) {
    await t.client`INSERT INTO inbox_item (recipient_teammate_id, category, severity, subject, body, ack_state)
      VALUES (${ME}::uuid, ${category}, ${i === 0 ? 'urgent' : 'info'}, ${`open ${category}`}, '{}'::jsonb, ${OPEN_STATES[i % 3]!})`
  }
  // A category this build does not know (a newer producer mid-deploy).
  await t.client`INSERT INTO inbox_item (recipient_teammate_id, category, severity, subject, body)
    VALUES (${ME}::uuid, ${UNKNOWN}, 'info', 'from a newer server', '{}'::jsonb)`
  await t.client`INSERT INTO inbox_item (recipient_teammate_id, category, severity, subject, body, ack_state)
    VALUES (${ME}::uuid, 'over-budget', 'info', 'resolved one', '{}'::jsonb, 'resolved'),
           (${ME}::uuid, 'quota-request', 'info', 'dismissed one', '{}'::jsonb, 'dismissed'),
           (${OTHER}::uuid, 'over-budget', 'info', 'not mine', '{}'::jsonb, 'unread')`
})

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('inbox category groups', () => {
  it.each(INBOX_CATEGORY_GROUPS.map((g) => [g]))('group=%s returns exactly its own categories', async (group) => {
    const r = await list(`group=${group}&ack_state=open&limit=200`)
    const expected = [...categoriesInGroup(group), ...(group === 'other' ? [UNKNOWN] : [])].sort()
    expect(r.items.map((i) => i.category).sort()).toEqual(expected)
  })

  it('open hides resolved and dismissed; closed shows only them', async () => {
    const open = await list('ack_state=open&limit=200')
    expect(open.items.every((i) => ['unread', 'read', 'acknowledged'].includes(i.ack_state))).toBe(true)
    expect(new Set(open.items.map((i) => i.ack_state))).toEqual(new Set(['unread', 'read', 'acknowledged']))
    expect(open.total).toBe(KNOWN_INBOX_CATEGORIES.length + 1)
    const closed = await list('ack_state=closed&limit=200')
    expect(closed.items.map((i) => i.ack_state).sort()).toEqual(['dismissed', 'resolved'])
  })

  it('group_counts follows status, ignores the group, and counts only my items', async () => {
    const open = await list('ack_state=open&group=budgets')
    for (const g of INBOX_CATEGORY_GROUPS) {
      expect(open.group_counts[g]).toBe(categoriesInGroup(g).length + (g === 'other' ? 1 : 0))
    }
    const closed = await list('ack_state=closed')
    expect(closed.group_counts.budgets).toBe(1)
    expect(closed.group_counts.requests).toBe(1)
    expect(closed.group_counts['data-health']).toBe(0)
  })

  it('group_counts follows severity too', async () => {
    const urgent = await list('ack_state=open&severity=urgent')
    const total = INBOX_CATEGORY_GROUPS.reduce((n, g) => n + urgent.group_counts[g], 0)
    expect(total).toBe(1)
    expect(urgent.items).toHaveLength(1)
  })

  it('refuses a group that does not exist', async () => {
    await expect(list('group=everything')).rejects.toMatchObject({ statusCode: 400 })
  })
})
