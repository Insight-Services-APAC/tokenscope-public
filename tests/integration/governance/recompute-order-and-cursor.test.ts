// @vitest-environment node
/*
 * Governance recompute ordering and convergence (docs/design/scaling-to-1000-users.md
 * 0.6), against real Postgres:
 *   - `order: 'desc'` recomputes the newest rows first and its cursor walks down;
 *   - advisory locks stay in ASCENDING period order within a batch, and across the
 *     billing PATCH's whole newest-first transaction;
 *   - both billing PATCH routes stop at their budget with `complete: false`, having
 *     recomputed the newest rows, and report `complete: true` otherwise;
 *   - the worker resumes from its stored kv cursor across invocations and wraps to
 *     reach rows that sort before the cursor.
 *
 * Fixtures carry a stale verdict (exempt, no source); with governance activated
 * and the org/enterprise `billed`, a recompute rewrites each row it reaches to
 * `governance:billed`, so "was this row reached" is a column read.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { recomputeGovernanceVerdicts, recomputeScopeNewestFirst } from '../../../server/governance/recompute'
import { runGovernanceRecompute } from '../../../server/workers/governance-recompute'
import { advisoryXactLock } from '../../../server/db/advisory-lock'
import orgPatch from '../../../server/api/v1/admin/reconciliation/orgs/[id].patch'
import entPatch from '../../../server/api/v1/admin/reconciliation/enterprises/[id].patch'

// Budget/batch seam for the PATCH routes: the handlers call recomputeScopeNewestFirst
// with production defaults; a test that sets `seam.patch` swaps in tiny ones.
// vi.mock is hoisted above the imports, so the handlers see the wrapper.
const seam = vi.hoisted(() => ({ patch: null as null | { budgetMs: number; batchSize: number } }))
vi.mock('../../../server/governance/recompute', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/governance/recompute')>()
  return {
    ...actual,
    recomputeScopeNewestFirst: (
      db: Parameters<typeof actual.recomputeScopeNewestFirst>[0],
      scope: Parameters<typeof actual.recomputeScopeNewestFirst>[1],
      opts?: Parameters<typeof actual.recomputeScopeNewestFirst>[2],
    ) => actual.recomputeScopeNewestFirst(db, scope, seam.patch ?? opts),
  }
})

let t: TestDb
let regionId: string
let adminId: string
let orgId: string
let entId: string
const teammates: string[] = []

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'gr-r', displayName: 'GR R' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'gr.svc', code: 'gr-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  const [adm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-gr-adm', email: 'gr-adm@x.test', role: 'platform-admin', regionId, orgUnitId: ou!.id })
    .returning()
  adminId = adm!.id
  for (let i = 0; i < 2; i++) {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: `oid-gr-${i}`, email: `gr-${i}@x.test`, role: 'developer', regionId, orgUnitId: ou!.id })
      .returning()
    teammates.push(tm!.id)
  }
  const [org] = await t.db
    .insert(schema.providerOrg)
    .values({
      provider: 'anthropic',
      externalOrgId: 'gr-org',
      displayName: 'GR org',
      reconciliationMode: 'indicative',
      apiKind: 'enterprise-analytics',
      billing: 'billed',
    })
    .returning()
  orgId = org!.id
  const [ent] = await t.db
    .insert(schema.providerEnterprise)
    .values({ provider: 'github', externalId: 'gr-ent', displayName: 'GR ent', reconciliationMode: 'reconciled', billing: 'billed' })
    .returning()
  entId = ent!.id
  await t.client`UPDATE governance_cutover_state SET status = 'activated' WHERE id = 1`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  seam.patch = null
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM kv_store WHERE mount = 'governance-recompute'`
  await t.client`UPDATE provider_org SET billing = 'billed' WHERE id = ${orgId}::uuid`
  await t.client`UPDATE provider_enterprise SET billing = 'billed' WHERE id = ${entId}::uuid`
})

/** One anthropic row per date, stale verdict. Returns ids in the given date order. */
async function seedOrgRows(dates: string[], teammateIdx = 0): Promise<string[]> {
  const ids: string[] = []
  for (const date of dates) {
    const [row] = await t.db
      .insert(schema.actualSpend)
      .values({
        teammateId: teammates[teammateIdx]!,
        date,
        tool: 'claude-code',
        inputTokens: 1n,
        outputTokens: 1n,
        costUsd: '1.000000',
        source: 'anthropic-analytics-api:gr-org',
        providerOrgId: orgId,
        chargebackExempt: true,
      })
      .returning()
    ids.push(row!.id)
  }
  return ids
}

async function seedEnterpriseRows(dates: string[]): Promise<string[]> {
  const ids: string[] = []
  for (const date of dates) {
    const [row] = await t.db
      .insert(schema.actualSpend)
      .values({
        teammateId: teammates[0]!,
        date,
        tool: 'copilot-cli',
        inputTokens: 1n,
        outputTokens: 1n,
        costUsd: '1.000000',
        source: 'github-copilot-seat:gr-lic-org',
        providerEnterpriseId: entId,
        chargebackExempt: true,
      })
      .returning()
    ids.push(row!.id)
  }
  return ids
}

/** Dates of rows whose verdict a recompute has written, ascending. */
async function recomputedDates(source: 'governance:billed' | 'governance:tracked' = 'governance:billed'): Promise<string[]> {
  const rows = await t.client<{ date: string }[]>`
    SELECT date::text AS date FROM actual_spend WHERE governance_verdict_source = ${source} ORDER BY date`
  return rows.map((r) => r.date)
}

/** Wraps a runner and records the period of every reportingSnapshot advisory lock, in call order. */
function recordingRunner(inner: { execute: (q: SQL) => Promise<unknown> }) {
  const dialect = new PgDialect()
  const locked: string[] = []
  const runner = {
    execute(q: SQL) {
      const { sql: text, params } = dialect.sqlToQuery(q)
      // Both the blocking form and the PATCH's up-front try-lock: same key space.
      if (/pg_(try_)?advisory_xact_lock/.test(text) && params[0] === 4) locked.push(String(params[1]))
      return inner.execute(q)
    },
  }
  return { runner: runner as unknown as Parameters<typeof recomputeGovernanceVerdicts>[0], locked }
}

describe("recomputeGovernanceVerdicts order: 'desc'", () => {
  it('recomputes the newest rows first and its cursor walks downward to the end', async () => {
    const dates = ['2026-07-30', '2026-08-02', '2026-08-15', '2026-09-01', '2026-09-20']
    const ids = await seedOrgRows(dates)

    const r1 = await t.db.transaction((tx) => recomputeGovernanceVerdicts(tx, { order: 'desc', limit: 2 }))
    expect(r1).toMatchObject({ scanned: 2, updated: 2, hasMore: true, lastDate: '2026-09-01', lastId: ids[3] })
    expect(await recomputedDates()).toEqual(['2026-09-01', '2026-09-20'])

    const r2 = await t.db.transaction((tx) =>
      recomputeGovernanceVerdicts(tx, { order: 'desc', limit: 2, afterDate: r1.lastDate, afterId: r1.lastId }),
    )
    expect(r2).toMatchObject({ scanned: 2, hasMore: true, lastDate: '2026-08-02', lastId: ids[1] })
    expect(await recomputedDates()).toEqual(['2026-08-02', '2026-08-15', '2026-09-01', '2026-09-20'])

    const r3 = await t.db.transaction((tx) =>
      recomputeGovernanceVerdicts(tx, { order: 'desc', limit: 2, afterDate: r2.lastDate, afterId: r2.lastId }),
    )
    expect(r3).toMatchObject({ scanned: 1, hasMore: false, lastDate: '2026-07-30', lastId: ids[0] })
    expect(await recomputedDates()).toEqual(dates)
  })

  it('the default order is ascending, unchanged', async () => {
    await seedOrgRows(['2026-07-30', '2026-08-02', '2026-09-20'])
    const r = await t.db.transaction((tx) => recomputeGovernanceVerdicts(tx, { limit: 2 }))
    expect(r).toMatchObject({ scanned: 2, hasMore: true, lastDate: '2026-08-02' })
    expect(await recomputedDates()).toEqual(['2026-07-30', '2026-08-02'])
  })

  it('takes period locks in ascending order within a newest-first batch', async () => {
    await seedOrgRows(['2026-07-30', '2026-08-15', '2026-09-20'])
    const locked = await t.db.transaction(async (tx) => {
      const rec = recordingRunner(tx)
      await recomputeGovernanceVerdicts(rec.runner, { order: 'desc', limit: 10 })
      return rec.locked
    })
    expect(locked).toEqual(['2026-07-01', '2026-08-01', '2026-09-01'])
  })
})

describe('recomputeScopeNewestFirst (the billing PATCH loop)', () => {
  it('acquires every period lock ascending across the whole transaction, though batches walk downward', async () => {
    await seedOrgRows(['2026-07-30', '2026-08-15', '2026-09-20'])
    const locked = await t.db.transaction(async (tx) => {
      const rec = recordingRunner(tx)
      const res = await recomputeScopeNewestFirst(rec.runner, { providerOrgId: orgId }, { budgetMs: 60_000, batchSize: 1 })
      expect(res).toEqual({ complete: true })
      return rec.locked
    })
    // First acquisition of each period is what can wait; re-acquiring a held
    // xact lock cannot. Those first acquisitions must be ascending.
    const firstAcquired = [...new Set(locked)]
    expect(firstAcquired).toEqual(['2026-07-01', '2026-08-01', '2026-09-01'])
    expect(await recomputedDates()).toEqual(['2026-07-30', '2026-08-15', '2026-09-20'])
  })

  it('reports complete:true when the budget expires exactly at the end of the scope', async () => {
    await seedOrgRows(['2026-08-15', '2026-09-20'])
    const res = await t.db.transaction((tx) => recomputeScopeNewestFirst(tx, { providerOrgId: orgId }, { budgetMs: 0, batchSize: 2 }))
    expect(res).toEqual({ complete: true })
  })
})

function ev(opts: { body: unknown; id: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'PATCH',
    path: '/x',
    context: { params: { id: opts.id } },
    node: {
      req: {
        method: 'PATCH',
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
        getHeader(n: string) {
          return this._headers[n.toLowerCase()]
        },
        setHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        removeHeader(n: string) {
          this._headers[n.toLowerCase()] = ''
        },
        appendHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        get headersSent() {
          return false
        },
      },
    },
  }
  const session: Session = { teammateId: adminId, email: 'gr-adm@x.test', displayName: 'Adm', role: 'platform-admin', regionId, orgPath: 'gr.svc' }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof orgPatch>[0]
}

describe('PATCH /admin/reconciliation/orgs/{id} — billing edit', () => {
  const dates = ['2026-07-30', '2026-08-15', '2026-09-01', '2026-09-20']

  it('stops at the budget with complete:false, having recomputed the newest rows', async () => {
    await seedOrgRows(dates)
    seam.patch = { budgetMs: 0, batchSize: 2 }
    const res = await orgPatch(ev({ id: orgId, body: { billing: 'tracked' } }))
    expect(res).toEqual({ id: orgId, updated: true, governanceRecompute: { complete: false } })
    expect(await recomputedDates('governance:tracked')).toEqual(['2026-09-01', '2026-09-20'])
  })

  it('recomputes every row and reports complete:true within the default budget', async () => {
    await seedOrgRows(dates)
    const res = await orgPatch(ev({ id: orgId, body: { billing: 'tracked' } }))
    expect(res).toEqual({ id: orgId, updated: true, governanceRecompute: { complete: true } })
    expect(await recomputedDates('governance:tracked')).toEqual(dates)
  })

  /*
   * A month the edit touches is held by someone else (the worker's batch, a
   * snapshot). The request must not wait for it: the billing edit commits, the
   * in-request recompute is skipped, and the worker converges the rows.
   */
  it('a month locked elsewhere: returns promptly with complete:false, and the billing edit is committed', async () => {
    await seedOrgRows(dates)
    let release!: () => void
    const released = new Promise<void>((r) => (release = r))
    let markHeld!: () => void
    const held = new Promise<void>((r) => (markHeld = r))
    const holder = t.db.transaction(async (tx) => {
      await tx.execute(advisoryXactLock('reportingSnapshot', '2026-08-01'))
      markHeld()
      await released
    })
    await held
    let res: unknown
    try {
      res = await Promise.race([
        orgPatch(ev({ id: orgId, body: { billing: 'tracked' } })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('the PATCH waited on a month lock')), 5_000)),
      ])
    } finally {
      release()
      await holder
    }
    expect(res).toEqual({ id: orgId, updated: true, governanceRecompute: { complete: false } })
    const [org] = await t.client<{ billing: string }[]>`SELECT billing FROM provider_org WHERE id = ${orgId}::uuid`
    expect(org!.billing).toBe('tracked')
    expect(await recomputedDates('governance:tracked')).toEqual([])
  })

  it('a PATCH without billing recomputes nothing and reports complete:true', async () => {
    await seedOrgRows(dates)
    const res = await orgPatch(ev({ id: orgId, body: { displayName: 'GR org renamed' } }))
    expect(res).toEqual({ id: orgId, updated: true, governanceRecompute: { complete: true } })
    expect(await recomputedDates()).toEqual([])
  })
})

describe('PATCH /admin/reconciliation/enterprises/{id} — billing edit', () => {
  const dates = ['2026-07-30', '2026-08-15', '2026-09-01', '2026-09-20']

  it('stops at the budget with complete:false, having recomputed the newest rows', async () => {
    await seedEnterpriseRows(dates)
    seam.patch = { budgetMs: 0, batchSize: 2 }
    const res = await entPatch(ev({ id: entId, body: { billing: 'tracked' } }))
    expect(res).toEqual({ id: entId, updated: true, governanceRecompute: { complete: false } })
    expect(await recomputedDates('governance:tracked')).toEqual(['2026-09-01', '2026-09-20'])
  })

  it('recomputes every row and reports complete:true within the default budget', async () => {
    await seedEnterpriseRows(dates)
    const res = await entPatch(ev({ id: entId, body: { billing: 'tracked' } }))
    expect(res).toEqual({ id: entId, updated: true, governanceRecompute: { complete: true } })
    expect(await recomputedDates('governance:tracked')).toEqual(dates)
  })
})

describe('runGovernanceRecompute — persisted cursor', () => {
  async function storedCursor(): Promise<unknown> {
    const rows = await t.client<{ value: string }[]>`
      SELECT value FROM kv_store WHERE mount = 'governance-recompute' AND key = 'cursor'`
    return rows[0] ? JSON.parse(rows[0].value) : null
  }

  it('resumes from the stored cursor across invocations and wraps to reach rows before it', async () => {
    const ids = await seedOrgRows(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'])
    const opts = { budgetMs: 0, batchSize: 2 }

    const r1 = await runGovernanceRecompute(t.db, opts)
    expect(r1).toMatchObject({ batches: 1, scanned: 2, hasMore: true, wrapped: false })
    expect(await storedCursor()).toEqual({ date: '2026-08-02', id: ids[1] })
    expect(await recomputedDates()).toEqual(['2026-08-01', '2026-08-02'])

    // A row that sorts BEFORE the cursor (late-arriving history) is not reached
    // until the sweep wraps.
    await seedOrgRows(['2026-07-15'], 1)

    const r2 = await runGovernanceRecompute(t.db, opts)
    expect(r2).toMatchObject({ scanned: 2, hasMore: true, wrapped: false })
    expect(await recomputedDates()).toEqual(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'])

    const r3 = await runGovernanceRecompute(t.db, opts)
    expect(r3).toMatchObject({ scanned: 0, hasMore: false, wrapped: true })
    expect(await storedCursor()).toBeNull()

    const r4 = await runGovernanceRecompute(t.db, opts)
    expect(r4).toMatchObject({ scanned: 2, wrapped: false })
    expect(await recomputedDates()).toEqual(['2026-07-15', '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'])
  })

  it.each([
    ['an impossible date', '{"date":"2026-02-31","id":"9a1e0000-0000-4000-8000-000000000001"}'],
    ['a malformed id', '{"date":"2026-08-02","id":"x"}'],
    ['non-JSON', 'not json'],
  ])('a corrupt stored cursor (%s) starts from the oldest row', async (_label, value) => {
    await seedOrgRows(['2026-08-01', '2026-08-02', '2026-08-03'])
    await t.client`
      INSERT INTO kv_store (mount, key, value) VALUES ('governance-recompute', 'cursor', ${value})`
    const r = await runGovernanceRecompute(t.db, { budgetMs: 0, batchSize: 1 })
    expect(r).toMatchObject({ scanned: 1, wrapped: false })
    expect(await recomputedDates()).toEqual(['2026-08-01'])
  })
})
