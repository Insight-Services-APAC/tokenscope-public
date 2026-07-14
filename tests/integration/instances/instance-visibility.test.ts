// @vitest-environment node
/*
 * Instance visibility + spot-and-block (ADR-0005 decision 3 / E2 follow-on).
 * Real DB via testcontainers + the actual handlers called directly (the
 * region-lifecycle.test.ts pattern: ev() builds an h3-shaped event with an
 * injected session + same-origin headers so assertSameOrigin passes, then
 * handler(ev(...)) runs against withRequestRls).
 *
 * The STRIDE-critical scoping invariants under test (RLS is inert under the
 * owner DB connection, so the app-level predicates ARE the live gate):
 *   1. me/instances — owner-scoping: a dev sees ONLY their own instances,
 *      never a peer's.
 *   2. me revoke — owner-scoping: 404 (NOT 403, no existence leak) on a peer's
 *      instance; 200 on own; 409 if already ended.
 *   3. admin/instances — region-scoping: an admin in region A passing
 *      ?region=B gets the requireRegionScope 403.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

import meInstances from '../../../server/api/v1/me/instances.get'
import meRevoke from '../../../server/api/v1/me/instances/[instanceId]/revoke.post'
import adminInstances from '../../../server/api/v1/admin/instances.get'

let t: TestDb
let regionAId: string
let regionBId: string
let ouAId: string
let ouBId: string
// Two devs in region A (owner-scoping foils) + one admin per region.
let devAId: string
let devA2Id: string
// Instances: one owned by devA (revocable), one owned by devA2 (peer foil),
// one already-ended owned by devA (409 foil).
let instDevA: string
let instDevA2: string
let instDevAEnded: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'inst-test-padded-to-thirty-two-characters'
  process.env.NUXT_HMAC_SESSION_KEY = 'inst-test-hmac-key-padded-well-beyond-32-chars'

  const [ra] = await t.db.insert(schema.region).values({ code: 'inst-a', displayName: 'Region A' }).returning()
  regionAId = ra!.id
  const [oa] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionAId, path: 'a.svc', code: 'a-svc', displayName: 'A Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouAId = oa!.id

  const [rb] = await t.db.insert(schema.region).values({ code: 'inst-b', displayName: 'Region B' }).returning()
  regionBId = rb!.id
  const [ob] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'b.svc', code: 'b-svc', displayName: 'B Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouBId = ob!.id

  // Two devs in region A.
  const [da] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'inst-oid-dev-a', email: 'dev-a@example.com', displayName: 'Dev A', role: 'developer', regionId: regionAId, orgUnitId: ouAId })
    .returning()
  devAId = da!.id
  const [da2] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'inst-oid-dev-a2', email: 'dev-a2@example.com', displayName: 'Dev A2', role: 'developer', regionId: regionAId, orgUnitId: ouAId })
    .returning()
  devA2Id = da2!.id

  // Admins (caller sessions need a matching teammate row for audit FKs).
  await t.db.insert(schema.teammate).values([
    { id: '00000000-0000-4000-8000-0000000000a1', entraOid: 'inst-oid-admin-a', email: 'admin-a@example.com', displayName: 'Admin A', role: 'admin', regionId: regionAId, orgUnitId: ouAId },
    { id: '00000000-0000-4000-8000-0000000000b1', entraOid: 'inst-oid-admin-b', email: 'admin-b@example.com', displayName: 'Admin B', role: 'admin', regionId: regionBId, orgUnitId: ouBId },
  ])

  // Instances.
  instDevA = randomUUID()
  instDevA2 = randomUUID()
  instDevAEnded = randomUUID()
  // attestation_state='unassigned' → may carry a NULL project (the
  // attested_has_project check requires a project only for 'attested').
  await t.db.insert(schema.instanceAttestation).values([
    { instanceId: instDevA, principalOid: 'inst-oid-dev-a', teammateId: devAId, tool: 'claude-code', sessionTokenHash: 'h-dev-a', regionId: regionAId, orgUnitId: ouAId, attestationState: 'unassigned' },
    { instanceId: instDevA2, principalOid: 'inst-oid-dev-a2', teammateId: devA2Id, tool: 'claude-code', sessionTokenHash: 'h-dev-a2', regionId: regionAId, orgUnitId: ouAId, attestationState: 'unassigned' },
    { instanceId: instDevAEnded, principalOid: 'inst-oid-dev-a', teammateId: devAId, tool: 'claude-code', sessionTokenHash: 'h-dev-a-ended', regionId: regionAId, orgUnitId: ouAId, attestationState: 'unassigned', tsActualEnd: new Date() },
  ])
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

type AnyHandler = (e: unknown) => Promise<unknown>

function ev(opts: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; session: Session }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : ''
  const url = '/x' + qs
  const e = {
    method: 'GET',
    path: url,
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: 'GET',
        url,
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown
}

const devA = (): Session =>
  ({ teammateId: devAId, email: 'dev-a@example.com', displayName: 'Dev A', role: 'developer', regionId: regionAId, orgPath: 'a.svc' }) as Session
const devA2 = (): Session =>
  ({ teammateId: devA2Id, email: 'dev-a2@example.com', displayName: 'Dev A2', role: 'developer', regionId: regionAId, orgPath: 'a.svc' }) as Session
const adminA = (): Session =>
  ({ teammateId: '00000000-0000-4000-8000-0000000000a1', email: 'admin-a@example.com', displayName: 'Admin A', role: 'admin', regionId: regionAId, orgPath: 'a.svc' }) as Session

async function call<R = unknown>(h: unknown, e: unknown): Promise<R> {
  return (h as AnyHandler)(e) as Promise<R>
}

describe('1. me/instances — owner-scoping', () => {
  it('dev A sees only their own instances, never a peer\'s', async () => {
    const out = await call<{ instances: { instance_id: string; revoked: boolean }[] }>(
      meInstances,
      ev({ session: devA() }),
    )
    const ids = out.instances.map((i) => i.instance_id)
    // Owns the live + the already-ended; must NOT see dev A2's.
    expect(ids).toContain(instDevA)
    expect(ids).toContain(instDevAEnded)
    expect(ids).not.toContain(instDevA2)
    // The ended one is flagged revoked.
    expect(out.instances.find((i) => i.instance_id === instDevAEnded)?.revoked).toBe(true)
    expect(out.instances.find((i) => i.instance_id === instDevA)?.revoked).toBe(false)
  })

  it('dev A2 sees only their own instance', async () => {
    const out = await call<{ instances: { instance_id: string }[] }>(meInstances, ev({ session: devA2() }))
    const ids = out.instances.map((i) => i.instance_id)
    expect(ids).toEqual([instDevA2])
  })
})

describe('2. me revoke — owner-scoping + lifecycle', () => {
  it('404 (no existence leak) revoking a peer\'s instance', async () => {
    await expect(
      call(meRevoke, ev({ params: { instanceId: instDevA2 }, session: devA() })),
    ).rejects.toMatchObject({ statusCode: 404 })
    // And it must NOT have been ended.
    const rows = await t.db.execute<{ ts_actual_end: string | null }>(sql`
      SELECT ts_actual_end FROM instance_attestation WHERE instance_id = ${instDevA2}::uuid
    `)
    expect([...rows][0]!.ts_actual_end).toBeNull()
  })

  it('404 on an unknown instance', async () => {
    await expect(
      call(meRevoke, ev({ params: { instanceId: randomUUID() }, session: devA() })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('409 revoking an already-ended own instance', async () => {
    await expect(
      call(meRevoke, ev({ params: { instanceId: instDevAEnded }, session: devA() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('200 revoking own active instance → sets ts_actual_end', async () => {
    const out = await call<{ id: string; revoked: boolean }>(
      meRevoke,
      ev({ params: { instanceId: instDevA }, session: devA() }),
    )
    expect(out).toMatchObject({ id: instDevA, revoked: true })
    const rows = await t.db.execute<{ ts_actual_end: string | null }>(sql`
      SELECT ts_actual_end FROM instance_attestation WHERE instance_id = ${instDevA}::uuid
    `)
    expect([...rows][0]!.ts_actual_end).not.toBeNull()
  })

  it('409 once it has been revoked (idempotency guard)', async () => {
    await expect(
      call(meRevoke, ev({ params: { instanceId: instDevA }, session: devA() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('3. admin/instances — region-scoping', () => {
  it('admin in region A lists region A devices (default region)', async () => {
    const out = await call<{ instances: { instance_id: string; teammate_email: string }[]; region: string }>(
      adminInstances,
      ev({ session: adminA() }),
    )
    expect(out.region).toBe(regionAId)
    // Sees both devs' instances in region A; carries teammate email.
    const ids = out.instances.map((i) => i.instance_id)
    expect(ids).toContain(instDevA2)
    expect(out.instances.every((i) => typeof i.teammate_email === 'string')).toBe(true)
  })

  it('admin in region A passing ?region=B → 403 (requireRegionScope)', async () => {
    await expect(
      call(adminInstances, ev({ query: { region: regionBId }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
