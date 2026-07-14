// @vitest-environment node
/*
 * Allocation write-path robustness (API-6 + SYS-1/SYS-2 adoption) —
 * handler-level against testcontainers Postgres (the lifecycle-policy.test.ts
 * harness pattern: direct h3 event mocking, no Nuxt boot).
 *
 * Regressions pinned:
 *   - PATCH effective overlapping a sibling → 409 from the gist EXCLUDE
 *     translation (was a raw 23P01 → 500)
 *   - garbage tstzrange / oversized budget rejected with 400 BEFORE Postgres
 *     (was 22007/22003 → 500)
 *   - malformed allocation id → 400 via requireUuidParam (representative
 *     route for the SYS-1 sweep; the old 36-char regex 500'd on ::uuid)
 *   - GET returns normalised effective_from/effective_to ISO fields (FE-1)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import allocationGet from '../../../server/api/v1/allocations/[id].get'
import allocationPatch from '../../../server/api/v1/allocations/[id].patch'
import allocationsPost from '../../../server/api/v1/allocations/index.post'
import topupsPost from '../../../server/api/v1/allocations/[id]/topups.post'

let t: TestDb
let regionId: string
let ouId: string
let finopsId: string
let projectId: string
let mayAllocationId: string
let juneAllocationId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [r] = await t.db.insert(schema.region).values({ code: 'oc-r', displayName: 'OC R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'oc.svc', code: 'oc-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [f] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-oc-fin', email: 'oc-fin@x.test', role: 'global-finops', regionId, orgUnitId: ouId })
    .returning()
  finopsId = f!.id
  const [p] = await t.db
    .insert(schema.project)
    .values({
      code: 'OC-PRJ',
      codeHash: 'h-oc-prj',
      displayName: 'Overlap Conflict',
      type: 'billable',
      regionId,
      costOwningUnitId: ouId,
    })
    .returning()
  projectId = p!.id

  async function seedBaseline(effective: string): Promise<string> {
    const [evt] = await t.db
      .insert(schema.auditEvent)
      .values({
        eventType: 'allocation-created',
        actorTeammateId: finopsId,
        subjectKind: 'project',
        subjectId: projectId,
        payload: { seed: true },
      })
      .returning({ id: schema.auditEvent.id })
    const [alloc] = await t.db
      .insert(schema.allocation)
      .values({
        scopeType: 'project',
        scopeId: projectId,
        budgetUsd: '1000.00',
        effective,
        allocationKind: 'baseline',
        auditEventId: evt!.id,
      })
      .returning({ id: schema.allocation.id })
    return alloc!.id
  }
  mayAllocationId = await seedBaseline('[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)')
  juneAllocationId = await seedBaseline('[2026-06-01T00:00:00+00,2026-07-01T00:00:00+00)')
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

const finops = (): Session => ({
  teammateId: finopsId,
  email: 'oc-fin@x.test',
  displayName: 'Fin',
  role: 'global-finops',
  regionId,
  orgPath: 'oc.svc',
})

function ev(opts: { method: string; id?: string; body?: unknown; session: Session }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method,
    path: '/x',
    context: { params: opts.id ? { id: opts.id } : {} },
    node: {
      req: {
        method: opts.method,
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof allocationGet>[0]
}

describe('SYS-1 — malformed allocation id → 400 (representative route)', () => {
  it('GET with 36 hex chars (no dashes) is a 400, not a PG 22P02 → 500', async () => {
    await expect(
      allocationGet(ev({ method: 'GET', id: 'abcdefabcdefabcdefabcdefabcdefabcdef', session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('PATCH with a non-uuid id is a 400 too', async () => {
    await expect(
      allocationPatch(
        ev({
          method: 'PATCH',
          id: 'not-a-uuid',
          body: { budget_usd: '10.00', effective: '[2026-05-01T00:00:00Z,2026-06-01T00:00:00Z)' },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('API-6 — zod rejects garbage before Postgres', () => {
  it('PATCH with unparseable tstzrange bounds → 400 (was 22007 → 500)', async () => {
    await expect(
      allocationPatch(
        ev({
          method: 'PATCH',
          id: juneAllocationId,
          body: { budget_usd: '10.00', effective: '[banana,cherry)' },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('PATCH with lower >= upper → 400', async () => {
    await expect(
      allocationPatch(
        ev({
          method: 'PATCH',
          id: juneAllocationId,
          body: {
            budget_usd: '10.00',
            effective: '[2026-07-01T00:00:00Z,2026-06-01T00:00:00Z)',
          },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('POST with a budget exceeding NUMERIC(14,2) → 400 (was 22003 → 500)', async () => {
    await expect(
      allocationsPost(
        ev({
          method: 'POST',
          body: {
            project_id: projectId,
            budget_usd: '99999999999999999',
            effective: '[2027-01-01T00:00:00Z,2027-02-01T00:00:00Z)',
          },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('API-6 / SYS-2 — overlap is a clean 409', () => {
  it('PATCH moving June onto May trips the gist EXCLUDE → 409 (was 23P01 → 500)', async () => {
    await expect(
      allocationPatch(
        ev({
          method: 'PATCH',
          id: juneAllocationId,
          body: {
            budget_usd: '1000.00',
            effective: '[2026-05-15T00:00:00Z,2026-06-15T00:00:00Z)',
          },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })

    // The aborted write must not have moved the row (tx rollback).
    const rows = await t.db
      .select({ effective: schema.allocation.effective })
      .from(schema.allocation)
    const june = rows.find((r) => String(r.effective).includes('2026-07-01'))
    expect(june).toBeDefined()
  })

  it('POST of an overlapping baseline pool → 409', async () => {
    await expect(
      allocationsPost(
        ev({
          method: 'POST',
          body: {
            project_id: projectId,
            budget_usd: '500.00',
            effective: '[2026-05-10T00:00:00Z,2026-05-20T00:00:00Z)',
          },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('mig 0052 — top-ups stack (overlapping top-ups allowed)', () => {
  it('two OVERLAPPING top-ups on the same project both persist', async () => {
    // First top-up covering all of June.
    const first = (await topupsPost(
      ev({
        method: 'POST',
        id: juneAllocationId,
        body: { budget_usd: '500.00', effective: '[2026-06-01T00:00:00Z,2026-07-01T00:00:00Z)' },
        session: finops(),
      }),
    )) as { id: string }
    expect(first.id).toBeTruthy()

    // Second top-up FULLY OVERLAPPING the first — would have tripped the gist
    // EXCLUDE (409) before mig 0052. The user's exact case: a budget already
    // has a top-up and needs another for the same month.
    const second = (await topupsPost(
      ev({
        method: 'POST',
        id: juneAllocationId,
        body: { budget_usd: '650.00', effective: '[2026-06-10T00:00:00Z,2026-07-01T00:00:00Z)' },
        session: finops(),
      }),
    )) as { id: string }
    expect(second.id).toBeTruthy()
    expect(second.id).not.toBe(first.id)

    // Both rows persisted; the project's June budget now sums baseline + both
    // top-ups (fetchProjectAllocation's @> now() sum).
    const cnt = await t.db.execute<{ c: string }>(sql`
      SELECT COUNT(*)::text AS c FROM allocation
      WHERE scope_id = ${projectId}::uuid AND allocation_kind = 'top-up'
    `)
    expect(Number([...cnt][0]!.c)).toBeGreaterThanOrEqual(2)
  })
  // NB: the baseline-overlap 409 tests above run against the SAME post-0052
  // schema, so they already prove baselines stay mutually non-overlapping —
  // the partial rebuild preserved that guarantee.
})

describe('FE-1 (server half) — normalised effective bounds', () => {
  it('GET returns effective_from/effective_to as ISO-8601 alongside the raw text', async () => {
    const res = (await allocationGet(ev({ method: 'GET', id: mayAllocationId, session: finops() }))) as {
      focused: { effective: string; effective_from: string | null; effective_to: string | null }
    }
    expect(res.focused.effective).toBeTruthy()
    expect(res.focused.effective_from).toBe('2026-05-01T00:00:00.000Z')
    expect(res.focused.effective_to).toBe('2026-06-01T00:00:00.000Z')
  })
})
