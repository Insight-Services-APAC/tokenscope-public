// @vitest-environment node
/*
 * Device names (#576): PATCH /api/v1/me/instances/{id}, and every read that
 * shows a name. Real Postgres; the handlers called directly.
 *
 * What is pinned:
 *   - only the device's own teammate can name it (a peer's id answers 404, and
 *     the name is untouched); trimmed, at most 40 characters, refused with
 *     control characters; empty clears; a purged device refuses (409);
 *   - the audit event says a name was set or cleared and never carries it;
 *   - the name shows on My account's list, Admin > Devices (read-only), the
 *     Activity page, the worklist, the session drawer and the silent-device
 *     alert, and ONLY for the caller's own device;
 *   - the Activity CSV never carries it.
 * The 12-month purge clearing it is pinned beside the existing purge test
 * (tests/integration/sessions/workers.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

import renameHandler from '../../../server/api/v1/me/instances/[instanceId]/index.patch'
import meInstances from '../../../server/api/v1/me/instances.get'
import adminInstances from '../../../server/api/v1/admin/instances.get'
import activityList from '../../../server/api/v1/me/activity.get'
import activityExport from '../../../server/api/v1/me/activity/export.get'
import untagged from '../../../server/api/v1/me/sessions/untagged.get'
import sessionDetail from '../../../server/api/v1/me/sessions/[sid]/index.get'
import inboxList from '../../../server/api/v1/me/inbox/index.get'

let t: TestDb
let regionId = ''
let ouId = ''
let devId = ''
let peerId = ''
const ADMIN_ID = '9a1e0000-0000-4000-8000-0000000000d1'
const inst = randomUUID()
const peerInst = randomUUID()
const purgedInst = randomUUID()
const CONV = 'conv-device-name-1'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'device-name-test-padded-to-thirty-two-chars'
  process.env.NUXT_HMAC_SESSION_KEY = 'device-name-test-hmac-key-padded-well-beyond-32'

  const [r] = await t.db.insert(schema.region).values({ code: 'dn-r', displayName: 'DN' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'dn.svc', code: 'dn-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = o!.id
  const [d] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-dn-dev', email: 'dn-dev@example.com', displayName: 'Dev', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  devId = d!.id
  const [p] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-dn-peer', email: 'dn-peer@example.com', displayName: 'Peer', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  peerId = p!.id
  await t.db.insert(schema.teammate).values({
    id: ADMIN_ID, entraOid: 'oid-dn-admin', email: 'dn-admin@example.com', displayName: 'Admin', role: 'admin', regionId, orgUnitId: ouId,
  })

  const base = { tool: 'claude-code', regionId, orgUnitId: ouId, attestationState: 'unassigned' }
  await t.db.insert(schema.instanceAttestation).values([
    { ...base, instanceId: inst, principalOid: 'oid-dn-dev', teammateId: devId, sessionTokenHash: `h-${inst}` },
    { ...base, instanceId: peerInst, principalOid: 'oid-dn-peer', teammateId: peerId, sessionTokenHash: `h-${peerInst}`, displayName: 'Peer laptop' },
    {
      ...base, instanceId: purgedInst, principalOid: 'oid-dn-dev', teammateId: devId, sessionTokenHash: `h-${purgedInst}`,
      tsActualEnd: new Date('2025-05-01T00:00:00Z'), tsPurged: new Date('2026-06-01T00:00:00Z'),
    },
  ])

  // One untagged session on the dev's device, and one on the peer's device
  // recorded under the DEV (the foil: the dev must not learn the peer's name).
  const [rc] = await t.db.select({ id: schema.rateCard.id, version: schema.rateCard.version }).from(schema.rateCard).limit(1)
  const rec = (instanceId: string, conv: string, at: string) => ({
    instanceId,
    claudeSessionId: conv,
    teammateId: devId,
    projectId: null,
    regionId,
    orgUnitId: ouId,
    costOwningUnitId: null,
    tool: 'claude-code',
    model: 'claude-sonnet-4-6',
    tokenType: 'input',
    tokens: BigInt(1000),
    costUsd: '1.000000',
    rateCardId: rc!.id,
    rateCardVersion: rc!.version,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: new Date(at),
  })
  // A project, so the conversation can have a TAGGED first hour: the worklist
  // must still say the session started then (#577).
  const [proj] = await t.db
    .insert(schema.project)
    .values({ code: 'DN-P', codeHash: 'h-dn-p', displayName: 'DN Project', type: 'billable', regionId, costOwningUnitId: ouId })
    .returning()
  await t.db.insert(schema.attributionRecord).values([
    { ...rec(inst, CONV, '2026-11-09T03:00:00Z'), projectId: proj!.id, costOwningUnitId: ouId },
    rec(inst, CONV, '2026-11-09T04:05:00Z'),
    rec(inst, CONV, '2026-11-09T06:40:00Z'),
    rec(peerInst, 'conv-device-name-foil', '2026-11-08T04:05:00Z'),
  ])

  await t.db.insert(schema.inboxItem).values([
    { recipientTeammateId: devId, category: 'went-silent', severity: 'attention', subject: 'mine', body: { instanceId: inst }, relatedEntityKind: 'instance', relatedEntityId: inst },
    { recipientTeammateId: devId, category: 'went-silent', severity: 'attention', subject: 'foil', body: { instanceId: peerInst }, relatedEntityKind: 'instance', relatedEntityId: peerInst },
  ])
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(opts: { session: Session; params?: Record<string, string>; body?: unknown; method?: string; query?: string }) {
  const method = opts.method ?? 'GET'
  const url = '/x' + (opts.query ? `?${opts.query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450', 'content-type': 'application/json' }
  const e = {
    method,
    path: url,
    context: { params: opts.params ?? {} },
    node: {
      req: { method, url, body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as never
}

const dev = (): Session =>
  ({ teammateId: devId, email: 'dn-dev@example.com', displayName: 'Dev', role: 'developer', regionId, orgPath: 'dn.svc' }) as Session
const admin = (): Session =>
  ({ teammateId: ADMIN_ID, email: 'dn-admin@example.com', displayName: 'Admin', role: 'admin', regionId, orgPath: 'dn.svc' }) as Session

const rename = (id: string, name: unknown, session = dev()) =>
  (renameHandler as (e: never) => Promise<unknown>)(ev({ session, params: { instanceId: id }, body: { name }, method: 'PATCH' }))

async function storedName(id: string): Promise<string | null> {
  const rows = await t.db.execute<{ display_name: string | null }>(sql`
    SELECT display_name FROM instance_attestation WHERE instance_id = ${id}::uuid`)
  return [...rows][0]!.display_name
}

describe('PATCH /me/instances/{id}: who may name a device, and how', () => {
  it('the owner names their device; the name is trimmed and stored', async () => {
    await expect(rename(inst, '  Work laptop  ')).resolves.toEqual({ id: inst, display_name: 'Work laptop' })
    expect(await storedName(inst)).toBe('Work laptop')
  })

  it("another teammate's device answers 404, and its name is untouched", async () => {
    await expect(rename(peerInst, 'Mine now')).rejects.toMatchObject({ statusCode: 404 })
    expect(await storedName(peerInst)).toBe('Peer laptop')
  })

  it('an unknown device answers 404', async () => {
    await expect(rename(randomUUID(), 'x')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('over 40 characters, or with a control character, is a 400 and nothing changes', async () => {
    await expect(rename(inst, 'x'.repeat(41))).rejects.toMatchObject({ statusCode: 400 })
    await expect(rename(inst, 'evil‮name')).rejects.toMatchObject({ statusCode: 400 })
    expect(await storedName(inst)).toBe('Work laptop')
  })

  it('a purged device refuses (409): naming it would put a personal field back', async () => {
    await expect(rename(purgedInst, 'Old box')).rejects.toMatchObject({ statusCode: 409 })
    expect(await storedName(purgedInst)).toBeNull()
  })

  it('the audit event records that a name was set, never the name', async () => {
    const rows = await t.db.execute<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM audit_event WHERE event_type = 'instance-renamed' AND subject_id = ${inst}::uuid ORDER BY ts_recorded`)
    const all = [...rows]
    expect(all.length).toBeGreaterThan(0)
    expect(all[0]!.payload).toMatchObject({ byUser: true, cleared: false })
    expect(JSON.stringify(all)).not.toContain('Work laptop')
  })

  it('an empty name clears it, and the CHECK refuses a blank written past the route', async () => {
    await expect(rename(inst, '   ')).resolves.toEqual({ id: inst, display_name: null })
    expect(await storedName(inst)).toBeNull()
    await expect(
      t.db.execute(sql`UPDATE instance_attestation SET display_name = ' padded ' WHERE instance_id = ${inst}::uuid`),
    ).rejects.toThrow()
    await rename(inst, 'Work laptop')
  })
})

describe('where the name shows, and only to its owner', () => {
  it("My account's device list and Admin > Devices carry it", async () => {
    const mine = (await (meInstances as (e: never) => Promise<{ instances: { instance_id: string; display_name: string | null }[] }>)(ev({ session: dev() })))
    expect(mine.instances.find((i) => i.instance_id === inst)!.display_name).toBe('Work laptop')
    const adm = (await (adminInstances as (e: never) => Promise<{ instances: { instance_id: string; display_name: string | null }[] }>)(ev({ session: admin() })))
    expect(adm.instances.find((i) => i.instance_id === inst)!.display_name).toBe('Work laptop')
  })

  it('Activity names the caller\'s own device and not a peer\'s, and the CSV never carries a name', async () => {
    const page = (await (activityList as (e: never) => Promise<{ rows: { id: string; kind: string; device_name?: string | null; ts_first?: string }[] }>)(ev({ session: dev() })))
    const own = page.rows.find((r) => r.id === CONV)!
    expect(own.device_name).toBe('Work laptop')
    expect(own.ts_first).toMatch(/^2026-11-09 03:00:00/)
    expect(page.rows.find((r) => r.id === 'conv-device-name-foil')!.device_name).toBeNull()
    const csv = (await (activityExport as (e: never) => Promise<string>)(ev({ session: dev() })))
    expect(csv).not.toContain('Work laptop')
    expect(csv).not.toContain('Peer laptop')
  })

  it("the worklist names the caller's own device and not a peer's, and spans the WHOLE session", async () => {
    const out = (await (untagged as (e: never) => Promise<{ sessions: { session_id: string; device_name: string | null; session_first: string; first_event: string }[] }>)(ev({ session: dev() })))
    const own = out.sessions.find((s) => s.session_id === CONV)!
    expect(own.device_name).toBe('Work laptop')
    // The tagged first hour counts for "when it ran"; the untagged slice starts later.
    expect(own.session_first).toMatch(/^2026-11-09 03:00:00/)
    expect(own.first_event).toMatch(/^2026-11-09 04:05:00/)
    expect(out.sessions.find((s) => s.session_id === 'conv-device-name-foil')!.device_name).toBeNull()
  })

  it('the session drawer names the device', async () => {
    const d = (await (sessionDetail as (e: never) => Promise<{ device_name: string | null }>)(ev({ session: dev(), params: { sid: CONV } })))
    expect(d.device_name).toBe('Work laptop')
  })

  it("the silent-device alert carries the recipient's own device name only", async () => {
    const out = (await (inboxList as (e: never) => Promise<{ items: { subject: string; target_device_name: string | null }[] }>)(ev({ session: dev() })))
    expect(out.items.find((i) => i.subject === 'mine')!.target_device_name).toBe('Work laptop')
    expect(out.items.find((i) => i.subject === 'foil')!.target_device_name).toBeNull()
  })
})
