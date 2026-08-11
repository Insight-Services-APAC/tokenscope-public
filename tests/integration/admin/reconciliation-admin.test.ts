// @vitest-environment node
/*
 * Reconciliation admin observability — DB-path contract.
 * Covers the load-bearing bits the endpoints rely on (the endpoints are thin
 * requireRole + getValidatedQuery wrappers over this SQL/these functions):
 *  - worker_run.result round-trips (the write seam), with size-cap + unserialisable guards
 *  - reconciliation_record.run_id is stamped by the engine (runs<->records linkage)
 *  - the records region-clamp excludes org-scope (region-NULL) rows for a region admin
 *  - the split summary aggregation (untaggedUsd disposition-only, walkBackUsd abs, net)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { recordWorkerRunStart, recordWorkerRunOutcome } from '../../../server/workers/run-health'
import { runReconcileEngine } from '../../../server/reconciliation/engine'
import type { ReconciledLine } from '../../../server/reconciliation/types'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import mapPost from '../../../server/api/v1/admin/reconciliation/github/map.post'

let t: TestDb
let regionA = ''
let regionB = ''
let teammateA = ''
let teammateB = ''
let adminAId = ''
let finopsId = ''
let ghEnterpriseId = ''
const NOW = new Date('2026-06-08T12:00:00.000Z')

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(),'ra','RA'),(gen_random_uuid(),'rb','RB')`
  const regions = await t.client<{ id: string; code: string }[]>`SELECT id::text AS id, code FROM region`
  regionA = regions.find((r) => r.code === 'ra')!.id
  regionB = regions.find((r) => r.code === 'rb')!.id
  await t.client`INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
    VALUES (gen_random_uuid(), ${regionA}, 'ra.b', 'ra-bu', 'RA BU', 'bu'),
           (gen_random_uuid(), ${regionB}, 'rb.b', 'rb-bu', 'RB BU', 'bu')`
  const ous = await t.client<{ id: string; code: string }[]>`SELECT id::text AS id, code FROM org_unit`
  const ouA = ous.find((o) => o.code === 'ra-bu')!.id
  const ouB = ous.find((o) => o.code === 'rb-bu')!.id
  await t.client`INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id, role)
    VALUES (gen_random_uuid(),'oid-a','a@x.com',${regionA},${ouA},'developer'),
           (gen_random_uuid(),'oid-b','b@x.com',${regionB},${ouB},'developer'),
           (gen_random_uuid(),'oid-ra-admin','ra-admin@x.com',${regionA},${ouA},'admin'),
           (gen_random_uuid(),'oid-ra-finops','ra-finops@x.com',${regionA},${ouA},'global-finops')`
  const tms = await t.client<{ id: string; oid: string }[]>`SELECT id::text AS id, entra_oid AS oid FROM teammate`
  teammateA = tms.find((m) => m.oid === 'oid-a')!.id
  teammateB = tms.find((m) => m.oid === 'oid-b')!.id
  adminAId = tms.find((m) => m.oid === 'oid-ra-admin')!.id
  finopsId = tms.find((m) => m.oid === 'oid-ra-finops')!.id

  const [ent] = await t.client<{ id: string }[]>`
    INSERT INTO provider_enterprise (id, provider, external_id, display_name)
    VALUES (gen_random_uuid(), 'github', 'ra-map-ent', 'RA Map Ent') RETURNING id::text AS id`
  ghEnterpriseId = ent!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client`DELETE FROM reconciliation_record`
  await t.client`DELETE FROM worker_run`
})

describe('worker_run.result write seam', () => {
  it('round-trips a worker result object', async () => {
    const id = await recordWorkerRunStart(t.db, 'reconciliation-sync')
    await recordWorkerRunOutcome(t.db, id, {
      status: 'success',
      durationMs: 12,
      rowsAffected: 5,
      result: { scopesRun: 2, scopesErrored: 1, rowsWritten: 5 },
    })
    const [row] = await t.client<{ result: { scopesErrored: number } }[]>`
      SELECT result FROM worker_run WHERE id = ${id}::uuid`
    expect(row!.result.scopesErrored).toBe(1)
  })

  it('size-caps an oversized result + survives an unserialisable one', async () => {
    const big = await recordWorkerRunStart(t.db, 'x')
    await recordWorkerRunOutcome(t.db, big, {
      status: 'success',
      durationMs: 1,
      result: { blob: 'z'.repeat(70_000) },
    })
    const [r1] = await t.client<{ result: { truncated?: boolean } }[]>`SELECT result FROM worker_run WHERE id = ${big}::uuid`
    expect(r1!.result.truncated).toBe(true)

    const bad = await recordWorkerRunStart(t.db, 'y')
    await recordWorkerRunOutcome(t.db, bad, { status: 'success', durationMs: 1, result: { n: 1n } })
    const [r2] = await t.client<{ result: { reason?: string } }[]>`SELECT result FROM worker_run WHERE id = ${bad}::uuid`
    expect(r2!.result.reason).toBe('unserialisable')
  })
})

describe('reconciliation_record.run_id stamping', () => {
  it('stamps the engine run id onto the records it writes', async () => {
    const runId = await recordWorkerRunStart(t.db, 'reconciliation-sync')
    const line: ReconciledLine = {
      provider: 'anthropic',
      enterpriseRef: 'org-x',
      licenseOrg: null,
      periodDate: '2026-06-08',
      subject: { kind: 'teammate', teammateId: teammateA },
      category: 'model_tokens',
      unit: { quantity: 1000, unitType: 'tokens' },
      rateUsdPerUnit: '0',
      amountUsd: '9.00',
      spendClass: 'estimated',
      raw: {},
    }
    const r = await runReconcileEngine(t.db, [line], { now: NOW, runId })
    expect(r.recordsWritten).toBe(1)
    const [row] = await t.client<{ run_id: string | null }[]>`
      SELECT run_id::text AS run_id FROM reconciliation_record WHERE teammate_id = ${teammateA}::uuid`
    expect(row!.run_id).toBe(runId)
  })
})

describe('records region clamp + summary', () => {
  async function seed() {
    // region A: untagged +5 (model_tokens) and walk_back -1 (copilot_interactive)
    // region B: untagged +3 ; org-scope (region NULL): untagged +2
    await t.client`
      INSERT INTO reconciliation_record
        (provider, enterprise_ref, period_date, category, scope, teammate_id, region_id,
         actual_usd, otel_attributed_usd, delta_usd, spend_class, disposition, status)
      VALUES
        ('anthropic','o','2026-06-08','model_tokens','teammate',${teammateA},${regionA}, 5,0, 5,'estimated','untagged','proposed'),
        ('anthropic','o','2026-06-08','copilot_interactive','teammate',${teammateA},${regionA}, 4,5,-1,'estimated','walk_back','proposed'),
        ('anthropic','o','2026-06-08','model_tokens','teammate',${teammateB},${regionB}, 3,0, 3,'estimated','untagged','proposed'),
        ('anthropic','o','2026-06-08','web_search','org',NULL,NULL, 2,0, 2,'estimated','untagged','proposed')`
  }
  // The summary aggregation the endpoint runs, parameterised by the region clause.
  // Uses t.db.execute (drizzle) so the conditional `sql` fragment composes.
  function summary(regionClamp: string | null) {
    const regionClause = regionClamp ? sql`AND region_id = ${regionClamp}::uuid` : sql``
    return t.db.execute<{ total: string; untagged_usd: string; walk_back_usd: string; net: string }>(sql`
      SELECT COUNT(*)::text AS total,
             COALESCE(SUM(delta_usd) FILTER (WHERE disposition='untagged'),0)::text AS untagged_usd,
             COALESCE(SUM(ABS(delta_usd)) FILTER (WHERE disposition='walk_back'),0)::text AS walk_back_usd,
             COALESCE(SUM(delta_usd),0)::text AS net
      FROM reconciliation_record WHERE status='proposed' ${regionClause}`)
  }

  it('global-finops (no clamp) sees all rows incl org-scope', async () => {
    await seed()
    const [g] = await summary(null)
    expect(Number(g!.total)).toBe(4)
    expect(Number(g!.untagged_usd)).toBeCloseTo(10, 6) // 5+3+2
    expect(Number(g!.walk_back_usd)).toBeCloseTo(1, 6)
    expect(Number(g!.net)).toBeCloseTo(9, 6) // 5-1+3+2
  })

  it('region admin clamp excludes other regions AND org-scope (region-NULL) rows', async () => {
    await seed()
    const [a] = await summary(regionA)
    expect(Number(a!.total)).toBe(2) // A1 + A2 only; B + org-NULL excluded
    expect(Number(a!.untagged_usd)).toBeCloseTo(5, 6) // A1 untagged only (not the org +2)
    expect(Number(a!.walk_back_usd)).toBeCloseTo(1, 6) // abs(-1)
    expect(Number(a!.net)).toBeCloseTo(4, 6) // 5-1
  })
})

// github/map region clamp (server-api-app:idor:0004 / T3-xregion-05) — the real handler,
// through the same ev()/injectTestSession shape used across the admin integration suite.
function ev(opts: { session: Session; body: unknown }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: {} },
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof mapPost>[0]
}

const raAdmin = (): Session => ({ teammateId: adminAId, email: 'ra-admin@x.com', displayName: 'RA Admin', role: 'admin', regionId: regionA, orgPath: 'ra.b' })
const raFinops = (): Session => ({ teammateId: finopsId, email: 'ra-finops@x.com', displayName: 'RA Finops', role: 'global-finops', regionId: regionA, orgPath: 'ra.b' })

async function mapBoundTeammateId(login: string): Promise<string | null> {
  const rows = await t.client<{ teammate_id: string }[]>`
    SELECT teammate_id::text AS teammate_id FROM teammate_identity_map
    WHERE system = 'github' AND COALESCE(enterprise_slug, '') = 'ra-map-ent' AND lower(identifier) = ${login}
    LIMIT 1`
  return rows[0]?.teammate_id ?? null
}

describe('github/map region clamp', () => {
  it('region-A admin maps a login to a region-B teammate → 403, no teammate_identity_map row written', async () => {
    await expect(
      mapPost(ev({ session: raAdmin(), body: { enterpriseId: ghEnterpriseId, teammateId: teammateB, login: 'ra-map-to-b' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(await mapBoundTeammateId('ra-map-to-b')).toBeNull()
  })

  it('region-A admin re-maps a login currently bound to a region-B teammate → 403', async () => {
    await mapPost(ev({ session: raFinops(), body: { enterpriseId: ghEnterpriseId, teammateId: teammateB, login: 'ra-map-bound-b' } }))
    expect(await mapBoundTeammateId('ra-map-bound-b')).toBe(teammateB)
    await expect(
      mapPost(ev({ session: raAdmin(), body: { enterpriseId: ghEnterpriseId, teammateId: teammateA, login: 'ra-map-bound-b' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(await mapBoundTeammateId('ra-map-bound-b')).toBe(teammateB) // unchanged
  })

  it('same-region map → 200', async () => {
    const res = (await mapPost(ev({ session: raAdmin(), body: { enterpriseId: ghEnterpriseId, teammateId: teammateA, login: 'ra-map-same' } }))) as { teammateId: string }
    expect(res.teammateId).toBe(teammateA)
  })

  it('global-finops → succeeds', async () => {
    const res = (await mapPost(ev({ session: raFinops(), body: { enterpriseId: ghEnterpriseId, teammateId: teammateB, login: 'ra-map-finops' } }))) as { teammateId: string }
    expect(res.teammateId).toBe(teammateB)
  })
})
