// @vitest-environment node
/*
 * Seasonality (day-of-week × ISO-week heatmap) + Active-user trend — the wave-B
 * additions that EXCEED the AEUF bar (real cyclical + active-over-time), for BOTH the
 * whole-company Across scope and the region-scoped Regional scope. Exercised against a
 * real testcontainers Postgres via the OWNER connection (RLS inert, so the in-query
 * scope clause is what's tested). Covers:
 *   - GET .../seasonality: ISO-week axis oldest→newest, dow 0..6, weekIdx in range,
 *     cells SUM BACK to window spend; a custom from/to range re-windows it;
 *   - GET .../active-trend: per-day COUNT(DISTINCT teammate) per tool (a 2-user day),
 *     region-scoped for Regional; range re-windows it;
 *   - RBAC: Across is whole-company-only (admin/manager/developer → 403).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup } from '../helpers/usage-rollup'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import regionSeasonality from '../../../server/api/v1/reports/region/seasonality.get'
import regionActiveTrend from '../../../server/api/v1/reports/region/active-trend.get'

let t: TestDb
let regionA = ''
let regionB = ''
let unitA = ''
let unitB = ''
/*
 * mig 0129: a DEDICATED teammate for the 'global-finops' session — NEVER the
 * shared `sess()` default sentinel ('00000000-0000-0000-0000-000000000009'),
 * which the 403-loop's admin/manager/developer sessions ALSO resolve to.
 * report_access_grant is keyed on teammate_id alone, not on the `role` string
 * handed to injectTestSession — so granting the shared sentinel would ALSO
 * elevate those three roles, silently flipping their "FORBIDDEN — whole-company
 * -only" assertions (same trap fixed in regional.test.ts / across-regions.test.ts).
 */
let finopsElevatedId = ''

const ev = (session: Session, query = '') => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params: {} },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof regionSeasonality>[0]
}
/*
 * The WHOLE-COMPANY width of the merged `/reports/region*` family (was the
 * separate `/reports/across-regions*` routes). `region=all` is not an optional
 * extra here — it is what selects the unclamped engine scope, so every call that
 * used to reach an across route reaches it through this.
 */
const evAll = (session: Session, query = '') =>
  ev(session, query ? `${query}&region=all` : 'region=all')

const sess = (role: string, regionId: string, orgPath = 'a', teammateId = '00000000-0000-0000-0000-000000000009'): Session =>
  ({ teammateId, email: 'x@x.test', displayName: 'X', role, regionId, orgPath, issuedAt: new Date().toISOString() } as unknown as Session)
const gfo = () => sess('global-finops', regionA, 'a', finopsElevatedId)

// ISO day-of-week, zero-based (Mon=0..Sun=6) from a YYYY-MM-DD string.
const isoDow0 = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const mkRegion = async (code: string, name: string) => {
    await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
    return r!.id
  }
  regionA = await mkRegion('ra', 'Region A')
  regionB = await mkRegion('rb', 'Region B')

  const mkUnit = async (region: string, code: string) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${code}::ltree, ${code}, ${code}, 'bu', true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  unitA = await mkUnit(regionA, 'a')
  unitB = await mkUnit(regionB, 'b')

  const mkTeammate = async (region: string, unit: string, email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  const alice = await mkTeammate(regionA, unitA, 'alice@a.test')
  const carol = await mkTeammate(regionA, unitA, 'carol@a.test')
  const dave = await mkTeammate(regionA, unitA, 'dave@a.test') // copilot-only via unaccounted
  const bob = await mkTeammate(regionB, unitB, 'bob@b.test')

  const mkInstance = async (tm: string, region: string, unit: string) => {
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${tm}::uuid, 'claude-code', ${region}::uuid, ${unit}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${tm}::uuid LIMIT 1`
    return r!.id
  }
  const ar = async (inst: string, tm: string, region: string, unit: string, cost: number, day: string) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${unit}::uuid, NULL::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated', ${day}::timestamptz, ${'conv-' + tm + day})`
  }
  const uu = async (tm: string, region: string, unit: string, day: string, cost: number) => {
    await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
      VALUES (${tm}::uuid, ${region}::uuid, ${unit}::uuid, ${day}::date, 'copilot-cli', ${cost}, 0, 'api-reconciled')`
  }

  // 2026-07-02 (Thu) and 2026-07-06 (Mon) — DIFFERENT ISO weeks.
  //   07-02: alice claude 20, carol claude 8, bob(regionB) claude 100, dave copilot 5
  //   07-06: alice claude 10, dave copilot 30
  const aliceInst = await mkInstance(alice, regionA, unitA)
  const carolInst = await mkInstance(carol, regionA, unitA)
  const bobInst = await mkInstance(bob, regionB, unitB)
  await ar(aliceInst, alice, regionA, unitA, 20, '2026-07-02T00:00:00Z')
  await ar(carolInst, carol, regionA, unitA, 8, '2026-07-02T00:00:00Z')
  await ar(bobInst, bob, regionB, unitB, 100, '2026-07-02T00:00:00Z')
  await ar(aliceInst, alice, regionA, unitA, 10, '2026-07-06T00:00:00Z')
  await uu(dave, regionA, unitA, '2026-07-02', 5)
  await uu(dave, regionA, unitA, '2026-07-06', 30)

  // A SEPARATE, DEDICATED teammate for this file's 'global-finops' session
  // (mig 0129) — see the `finopsElevatedId` declaration above. Granted BOTH
  // permissions so it keeps its pre-mig-0129 (unconditional org-wide) reach —
  // this file's own point is the seasonality/active-trend mechanics, not the
  // grants model itself.
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, is_active)
    VALUES ('oid-finops-elevated', 'finops-elevated@a.test', 'Finops Elevated', ${regionA}::uuid, ${unitA}::uuid, 'global-finops', true)`
  ;[{ id: finopsElevatedId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='finops-elevated@a.test'`
  await grantReportAccess(t.client, finopsElevatedId)
  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface SeasonalityResp {
  window: { from: string; to: string }
  weeks: string[]
  cells: { dow: number; weekIdx: number; value: number }[]
}
interface ActiveTrendResp {
  window: { from: string; to: string }
  series: { day: string; claudeCode: number; copilot: number }[]
}

const sumCells = (r: SeasonalityResp) => r.cells.reduce((a, c) => a + c.value, 0)
const assertWellFormed = (r: SeasonalityResp) => {
  // weeks sorted ascending + unique.
  expect([...r.weeks].sort()).toEqual(r.weeks)
  expect(new Set(r.weeks).size).toBe(r.weeks.length)
  for (const c of r.cells) {
    expect(c.dow).toBeGreaterThanOrEqual(0)
    expect(c.dow).toBeLessThanOrEqual(6)
    expect(c.weekIdx).toBeGreaterThanOrEqual(0)
    expect(c.weekIdx).toBeLessThan(r.weeks.length)
  }
}

describe('GET /reports/across-regions/seasonality — whole-company heatmap', () => {
  for (const role of ['admin', 'manager', 'developer'] as const) {
    it(`a ${role} is FORBIDDEN (403) — whole-company-only, same gate as the index`, async () => {
      await expect(regionSeasonality(evAll(sess(role, regionA), 'month=2026-07'))).rejects.toMatchObject({ statusCode: 403 })
    })
  }

  it('cells sum back to whole-company window spend; well-formed axis; two ISO weeks', async () => {
    const r = (await regionSeasonality(evAll(gfo(), 'month=2026-07'))) as unknown as SeasonalityResp
    expect(r.window).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    assertWellFormed(r)
    // 07-02 = 20+8+100+5 = 133; 07-06 = 10+30 = 40 → total 173 (two distinct days/weeks).
    expect(sumCells(r)).toBe(173)
    expect(r.weeks.length).toBe(2)
    expect(r.cells.length).toBe(2)
    // The 07-02 (Thursday) cell carries 133 at the right zero-based ISO dow.
    const thu = r.cells.find((c) => c.value === 133)!
    expect(thu.dow).toBe(isoDow0('2026-07-02'))
  })

  it('a custom from/to range re-windows the heatmap to just that span', async () => {
    // [07-05, 07-08] → only 07-06 (=40); 07-02 excluded.
    const r = (await regionSeasonality(evAll(gfo(), 'from=2026-07-05&to=2026-07-08'))) as unknown as SeasonalityResp
    expect(r.window).toEqual({ from: '2026-07-05', to: '2026-07-08' })
    expect(sumCells(r)).toBe(40)
    expect(r.cells.length).toBe(1)
    expect(r.cells[0]!.dow).toBe(isoDow0('2026-07-06'))
  })
})

describe('GET /reports/across-regions/active-trend — distinct active users per tool per day', () => {
  it('counts DISTINCT teammates per tool per day (a 2-claude-user day)', async () => {
    const r = (await regionActiveTrend(evAll(gfo(), 'month=2026-07'))) as unknown as ActiveTrendResp
    expect(r.window).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    const byDay = new Map(r.series.map((p) => [p.day, p]))
    // 07-02: alice + carol + bob claude = 3, dave copilot = 1.
    expect(byDay.get('2026-07-02')).toMatchObject({ claudeCode: 3, copilot: 1 })
    // 07-06: alice claude = 1, dave copilot = 1.
    expect(byDay.get('2026-07-06')).toMatchObject({ claudeCode: 1, copilot: 1 })
    expect(r.series.length).toBe(2)
  })

  it('a partial range (only from) is a 400', async () => {
    await expect(regionActiveTrend(evAll(gfo(), 'from=2026-07-05'))).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('GET /reports/regional/{seasonality,active-trend} — region-scoped', () => {
  it('regional seasonality is clamped to the region (bob in region B excluded)', async () => {
    const r = (await regionSeasonality(ev(gfo(), 'month=2026-07&region=' + regionA))) as unknown as SeasonalityResp
    assertWellFormed(r)
    // Region A only: 07-02 = 20+8+5 = 33; 07-06 = 40 → 73 (bob's 100 in region B excluded).
    expect(sumCells(r)).toBe(73)
  })

  it('regional active-trend is clamped to the region', async () => {
    const r = (await regionActiveTrend(ev(gfo(), 'month=2026-07&region=' + regionA))) as unknown as ActiveTrendResp
    const byDay = new Map(r.series.map((p) => [p.day, p]))
    // Region A 07-02: alice + carol claude = 2, dave copilot = 1 (bob excluded).
    expect(byDay.get('2026-07-02')).toMatchObject({ claudeCode: 2, copilot: 1 })
  })
})
