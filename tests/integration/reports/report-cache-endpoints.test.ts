// @vitest-environment node
/*
 * The report response cache AT THE HANDLERS — the plan's T3/T4/T6/T8
 * (docs/design/reporting-consolidation/09-reports-performance-plan.md D5-D8)
 * proven against real endpoints on a real Postgres:
 *
 *   T3 — the key IS the security boundary: a second identity with identical
 *        params MISSES the first's entry; the same identity HITS; a different
 *        `ccId` route param MISSES (r1-H1). Cached cross-user leakage would be
 *        a security defect — these assertions are the fence.
 *   T4 — coalescing: identical concurrent requests share ONE computation (the
 *        retry-storm killer), and both callers get the same body.
 *   T6 — the D8 scan memo: CONCURRENT drivers requests on different axes
 *        (different response-cache keys) still share ONE concentration scan.
 *   T8 — Cache-Control: `private, max-age=<ttl>` + `Vary: Cookie` when the
 *        cache is enabled; ABSENT when disabled (the VITEST default).
 *
 * The cache is opt-in here via TOKENSCOPE_REPORT_CACHE_TTL_MS — every other
 * test file in this repo runs with the VITEST zero-TTL default and sees
 * uncached behaviour.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import regionHandler from '../../../server/api/v1/reports/region/index.get'
import driversHandler from '../../../server/api/v1/reports/region/drivers.get'
import ccDrillHandler from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import {
  withReportCache,
  reportCacheStats,
  resetReportCache,
} from '../../../server/reporting/report-cache'

let t: TestDb
let regionId = ''
let ccA = ''
let ccB = ''
let tmOne = ''
let tmTwo = ''

const ev = (session: Session, query = '', params: Record<string, string> = {}) => {
  const url = '/x' + (query ? `?${query}` : '')
  const reqHeaders: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
  }
  const resHeaders: Record<string, unknown> = {}
  const e = {
    method: 'GET',
    path: url,
    context: { params },
    node: {
      req: {
        method: 'GET',
        url,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...reqHeaders }
        },
      },
      res: {
        _headers: resHeaders,
        statusCode: 200,
        getHeader(name: string) {
          return resHeaders[String(name).toLowerCase()]
        },
        setHeader(name: string, value: unknown) {
          resHeaders[String(name).toLowerCase()] = value
        },
        removeHeader(name: string) {
          Reflect.deleteProperty(resHeaders, String(name).toLowerCase())
        },
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return { event: e as unknown as Parameters<typeof regionHandler>[0], resHeaders }
}

const sess = (teammateId: string): Session =>
  ({
    teammateId,
    email: 'x@x.test',
    displayName: 'X',
    role: 'platform-admin',
    regionId,
    orgPath: 'rcx',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const c = t.client

  await c`INSERT INTO region (code, display_name) VALUES ('rcx', 'Report Cache Region')`
  ;[{ id: regionId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='rcx'`
  const mkUnit = async (code: string, path: string) => {
    await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId}::uuid, ${path}::ltree, ${code}, ${code}, 'practice', true)`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code=${code}`
    return r!.id
  }
  ccA = await mkUnit('rcx-a', 'rcx.a')
  ccB = await mkUnit('rcx-b', 'rcx.b')
  const mkTeammate = async (email: string, unit: string) => {
    await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${regionId}::uuid, ${unit}::uuid)`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  tmOne = await mkTeammate('one@rcx.test', ccA)
  tmTwo = await mkTeammate('two@rcx.test', ccB)
  /*
   * mig 0129: `sess()` here takes teammateId as a PARAMETER (always with the
   * hardcoded role 'platform-admin') and every caller in this file passes
   * either tmOne or tmTwo — two REAL, dedicated per-persona rows, never a
   * shared sentinel and never reused for a role expected to stay unelevated.
   * This file is about cache-key/coalescing behaviour, not RBAC narrowness, so
   * granting both permissions directly to both is safe — needed for the
   * `region=all&...` (whole-company) calls and the cross-ccId drill calls to
   * reach 200 at all under the new grants model.
   */
  await grantReportAccess(c, tmOne)
  await grantReportAccess(c, tmTwo)
  // A little spend so the composite has something to aggregate.
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
      region_id, org_unit_id, cost_owning_unit_id, dimension_source)
    VALUES (${tmOne}::uuid, '2026-07-10'::date, 'claude-ai', 1000, 1000, 12, 'anthropic-analytics-api',
      ${regionId}::uuid, ${ccA}::uuid, ${ccA}::uuid, 'ingest-snapshot')`
}, 180_000)

afterAll(async () => {
  delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
  await stopTestDb(t)
})

beforeEach(() => {
  process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '60000'
  resetReportCache()
})

describe('T3 — the key is the security boundary', () => {
  it('same identity HITS; a second identity MISSES the first entry', async () => {
    const q = 'region=all&month=2026-07'
    const a1 = await regionHandler(ev(sess(tmOne), q).event)
    const a2 = await regionHandler(ev(sess(tmOne), q).event)
    expect(a2).toEqual(a1)
    let s = reportCacheStats()
    expect(s.responseMisses).toBe(1)
    expect(s.responseHits).toBe(1)

    await regionHandler(ev(sess(tmTwo), q).event)
    s = reportCacheStats()
    expect(s.responseMisses).toBe(2) // tmTwo could NOT read tmOne's entry
  })

  it('a different ccId route param MISSES (r1-H1) — drills never share a body', async () => {
    const q = 'month=2026-07'
    const d1 = await ccDrillHandler(ev(sess(tmOne), q, { ccId: ccA }).event)
    const d2 = await ccDrillHandler(ev(sess(tmOne), q, { ccId: ccB }).event)
    const s = reportCacheStats()
    expect(s.responseMisses).toBe(2)
    expect(s.responseHits).toBe(0)
    expect((d1 as { cc: { id: string } }).cc.id).toBe(ccA)
    expect((d2 as { cc: { id: string } }).cc.id).toBe(ccB)
    // And the same drill again HITS.
    await ccDrillHandler(ev(sess(tmOne), q, { ccId: ccA }).event)
    expect(reportCacheStats().responseHits).toBe(1)
  })
})

describe('T4 — identical concurrent requests share one computation', () => {
  it('two concurrent composite calls: ONE computation, equal bodies', async () => {
    /*
     * The invariant is ONE COMPUTATION, and that is what is asserted. Which
     * sharing mechanism serves the second request — `join` (the first is still
     * in flight) or `hit` (it had already landed) — is decided by scheduling,
     * and pinning `responseJoins === 1` pinned the outcome of a race: on a
     * loaded CI runner the first computation can finish before the second
     * registers, and the run goes red having demonstrated nothing wrong. Both
     * outcomes mean the same thing here, because `miss` is the ONLY branch that
     * calls compute().
     *
     * The join path itself is covered deterministically below, with a compute
     * this test controls, rather than by hoping two handlers overlap.
     */
    const q = 'region=all&month=2026-07'
    const [a, b] = await Promise.all([
      regionHandler(ev(sess(tmOne), q).event),
      regionHandler(ev(sess(tmOne), q).event),
    ])
    expect(b).toEqual(a)
    const s = reportCacheStats()
    expect(s.responseMisses, 'the body was computed more than once').toBe(1)
    expect(
      s.responseJoins + s.responseHits,
      'the second request neither joined nor hit — it recomputed',
    ).toBe(1)
  })

  it('the JOIN path: a second caller arriving mid-flight never calls compute again', async () => {
    /*
     * Deterministic by construction. The first compute parks on a promise this
     * test resolves, so the second caller is GUARANTEED to arrive while the
     * entry is in flight — the exact window the handler test above cannot pin.
     * computes === 1 is the assertion that matters; responseJoins proves it was
     * the in-flight branch and not a cache hit that delivered it.
     */
    let computes = 0
    let release!: () => void
    const parked = new Promise<void>((r) => {
      release = r
    })
    const key = ['t4-join-probe']
    const compute = async () => {
      computes++
      await parked
      return { v: 'once' }
    }

    const first = withReportCache(ev(sess(tmOne)).event, key, compute)
    // Yield until the first call has registered as in flight. It cannot finish
    // in the meantime: compute() is parked until this test says otherwise.
    while (reportCacheStats().responseMisses === 0) await new Promise((r) => setImmediate(r))

    const second = withReportCache(ev(sess(tmOne)).event, key, compute)
    release()
    const [a, b] = await Promise.all([first, second])

    expect(computes, 'the second caller ran its own computation').toBe(1)
    expect(a).toEqual(b)
    expect(reportCacheStats().responseJoins).toBe(1)
  })
})

describe('T6 — the D8 scan memo shares across DIFFERENT response keys', () => {
  it('concurrent drivers on project+model axes run ONE concentration scan', async () => {
    const q = (axis: string) => `region=all&axis=${axis}&month=2026-07`
    await Promise.all([
      driversHandler(ev(sess(tmOne), q('project')).event),
      driversHandler(ev(sess(tmOne), q('model')).event),
    ])
    const s = reportCacheStats()
    expect(s.responseMisses).toBe(2) // different axes = different responses
    expect(s.memoMisses).toBe(1) // ONE concentration computation…
    // …and the other request read it — joined in flight or hit the fresh
    // entry, whichever the race produced. Either way: not a second scan.
    expect(s.memoHits + s.memoJoins).toBe(1)
  })
})

describe('T8 — Cache-Control rides exactly the enabled state', () => {
  it('enabled: private, max-age matches the TTL + Vary: Cookie, on hit AND miss', async () => {
    const q = 'region=all&month=2026-07'
    const miss = ev(sess(tmOne), q)
    await regionHandler(miss.event)
    expect(miss.resHeaders['cache-control']).toBe('private, max-age=60')
    expect(miss.resHeaders['vary']).toBe('Cookie')
    const hit = ev(sess(tmOne), q)
    await regionHandler(hit.event)
    expect(hit.resHeaders['cache-control']).toBe('private, max-age=60')
    expect(hit.resHeaders['vary']).toBe('Cookie')
  })

  it('disabled (the VITEST default): no cache headers at all', async () => {
    delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
    const { event, resHeaders } = ev(sess(tmOne), 'region=all&month=2026-07')
    await regionHandler(event)
    expect(resHeaders['cache-control']).toBeUndefined()
    expect(resHeaders['vary']).toBeUndefined()
  })
})
