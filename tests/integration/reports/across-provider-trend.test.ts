// @vitest-environment node
/*
 * Across-Regions per-provider split + day-grain trend + date-range windowing —
 * the foundation:backend additions to the whole-company scope, exercised against a
 * real testcontainers Postgres via the OWNER connection (RLS inert, so the
 * no-scope-clause whole-company query is what's tested). Covers:
 *   - providerSplit: per-vendor spend + distinct active users, SUMMING BACK to the
 *     genuine headline (claude-code / copilot-cli / other buckets over v_complete_usage);
 *   - GET /reports/region/trend (region=all): day-grain vendor-stacked series shape + RBAC;
 *   - custom from/to range: range aggregates with forecast:null + momDeltaPct:null,
 *     and the trend windowed to the range (month path left untouched).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup } from '../helpers/usage-rollup'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import acrossHandler from '../../../server/api/v1/reports/region/index.get'
import trendHandler from '../../../server/api/v1/reports/region/trend.get'

let t: TestDb
let regionA = ''
let unitA = ''
let alice = ''
let dave = ''
/*
 * mig 0129: a DEDICATED teammate for this file's 'global-finops' session —
 * NEVER the shared sess() default sentinel ('00000000-0000-0000-0000-
 * 000000000009'), which the admin/manager/developer 403 loop below ALSO
 * resolves to. See regional.test.ts / across-regions.test.ts for the same fix.
 */
let trendElevatedId = ''

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
  return e as unknown as Parameters<typeof acrossHandler>[0]
}
/*
 * The WHOLE-COMPANY width of the merged `/reports/region*` family (was the
 * separate `/reports/across-regions*` routes). `region=all` is not an optional
 * extra here — it is what selects the unclamped engine scope, so every call that
 * used to reach an across route reaches it through this.
 */
const evAll = (session: Session, query = '') =>
  ev(session, query ? `${query}&region=all` : 'region=all')

const sess = (role: string, regionId: string, teammateId = '00000000-0000-0000-0000-000000000009'): Session =>
  ({ teammateId, email: 'x@x.test', displayName: 'X', role, regionId, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)
const gfo = () => sess('global-finops', regionA, trendElevatedId)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('ra', 'Region A')`
  const [ra] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='ra'`
  regionA = ra!.id

  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionA}::uuid, 'a'::ltree, 'a', 'a', 'bu', true)`
  const [ua] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='a'`
  unitA = ua!.id

  const mkTeammate = async (email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${regionA}::uuid, ${unitA}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  alice = await mkTeammate('alice@a.test')
  dave = await mkTeammate('dave@a.test')

  // A SEPARATE, DEDICATED teammate for this file's 'global-finops' session
  // (mig 0129) — see the `trendElevatedId` declaration above. Granted BOTH
  // permissions so gfo() keeps its pre-mig-0129 (unconditional org-wide) reach.
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, is_active)
    VALUES ('oid-finops-elevated', 'finops-elevated@a.test', 'Finops Elevated', ${regionA}::uuid, ${unitA}::uuid, 'global-finops', true)`
  ;[{ id: trendElevatedId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='finops-elevated@a.test'`
  await grantReportAccess(t.client, trendElevatedId)

  await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${alice}::uuid, 'claude-code', ${regionA}::uuid, ${unitA}::uuid, 'h', 'P')`
  const [ai] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${alice}::uuid LIMIT 1`
  const aliceInst = ai!.id

  const ar = async (cost: number, day: string) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${aliceInst}::uuid, ${alice}::uuid, ${regionA}::uuid, ${unitA}::uuid, NULL::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated', ${day}::timestamptz, ${'conv-' + day})`
  }
  // alice — Claude Code: July 02 = 20, July 05 = 10 (→ claude total 30); June 01 = 15
  // (the MoM operand — dated June-01 so it lands inside the like-for-like day-of-month
  // PACE window for any in-July run day; see the momDeltaPct assertion below).
  await ar(20, '2026-07-02T00:00:00Z')
  await ar(10, '2026-07-05T00:00:00Z')
  await ar(15, '2026-06-01T00:00:00Z')

  // dave — Copilot CLI via the unaccounted (API−OTel) gap: July 02 = 5, July 10 = 30 (→ copilot total 35).
  const uu = async (day: string, cost: number) => {
    await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
      VALUES (${dave}::uuid, ${regionA}::uuid, ${unitA}::uuid, ${day}::date, 'copilot-cli', ${cost}, 0, 'api-reconciled')`
  }
  await uu('2026-07-02', 5)
  await uu('2026-07-10', 30)
  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface ProviderEntry { spendUsd: number; activeUsers: number }
interface AcrossResp {
  meta: { scope: string; month: string; range?: { from: string; to: string } }
  kpis: { genuineUsd: number; activeUsers: number; momDeltaPct: number | null }
  providerSplit: { claudeCode: ProviderEntry; copilotCli: ProviderEntry; copilotAgent: ProviderEntry; other: ProviderEntry }
  forecast: unknown | null
}
interface TrendResp {
  window: { from: string; to: string }
  series: { day: string; key: string; value: number }[]
}

describe('GET /reports/region (region=all) — providerSplit', () => {
  it('splits genuine into the three named §A lanes + other, summing back to the headline', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(r.kpis.genuineUsd).toBe(65) // claude 30 + copilot 35
    const ps = r.providerSplit
    expect(ps.claudeCode.spendUsd).toBe(30)
    expect(ps.copilotCli.spendUsd).toBe(35)
    // copilot-agent is structurally absent from v_complete_usage (mig 0086) — the
    // widened bucket exists (three-lane §A ceiling) and reads 0.
    expect(ps.copilotAgent.spendUsd).toBe(0)
    expect(ps.other.spendUsd).toBe(0)
    // The four buckets SUM BACK to the genuine headline (the split invariant).
    expect(
      ps.claudeCode.spendUsd + ps.copilotCli.spendUsd + ps.copilotAgent.spendUsd + ps.other.spendUsd,
    ).toBe(r.kpis.genuineUsd)
  })

  it('per-vendor activeUsers = COUNT(DISTINCT teammate) in that vendor', async () => {
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(r.providerSplit.claudeCode.activeUsers).toBe(1) // alice
    expect(r.providerSplit.copilotCli.activeUsers).toBe(1) // dave
    expect(r.providerSplit.copilotAgent.activeUsers).toBe(0)
    expect(r.providerSplit.other.activeUsers).toBe(0)
    expect(r.kpis.activeUsers).toBe(2) // distinct across the whole window
  })
})

describe('GET /reports/region/trend (region=all) — RBAC + day-grain vendor-stacked shape', () => {
  for (const role of ['admin', 'manager', 'developer'] as const) {
    it(`a ${role} is FORBIDDEN (403) — same gate as the across index`, async () => {
      await expect(trendHandler(evAll(sess(role, regionA), 'month=2026-07'))).rejects.toMatchObject({ statusCode: 403 })
    })
  }

  it('global-finops sees one point per (day, vendor) with positive cost; values sum to genuine', async () => {
    const r = (await trendHandler(evAll(gfo(), 'month=2026-07'))) as unknown as TrendResp
    expect(r.window).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    // 2026-07-02 (claude 20 + copilot 5), 2026-07-05 (claude 10), 2026-07-10 (copilot 30) → 4 points.
    expect(r.series).toHaveLength(4)
    for (const p of r.series) {
      expect(['claude-code', 'copilot-cli', 'copilot-agent', 'other']).toContain(p.key)
      expect(p.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(p.value).toBeGreaterThan(0)
    }
    const byKey = (k: string) => r.series.filter((p) => p.key === k).reduce((a, p) => a + p.value, 0)
    expect(byKey('claude-code')).toBe(30)
    expect(byKey('copilot-cli')).toBe(35)
    expect(r.series.reduce((a, p) => a + p.value, 0)).toBe(65)

    const july2 = r.series.filter((p) => p.day === '2026-07-02')
    expect(new Map(july2.map((p) => [p.key, p.value]))).toEqual(
      new Map([['claude-code', 20], ['copilot-cli', 5]]),
    )
  })
})

describe('custom from/to range — range aggregates, month-anchored figures nulled', () => {
  it('the KPIs/providerSplit window on [from, to] and forecast + momDeltaPct are null', async () => {
    // [2026-07-03, 2026-07-08] → only alice July-05 (claude 10); July-02 + July-10 excluded.
    const r = (await acrossHandler(evAll(gfo(), 'from=2026-07-03&to=2026-07-08'))) as unknown as AcrossResp
    expect(r.kpis.genuineUsd).toBe(10)
    expect(r.providerSplit.claudeCode.spendUsd).toBe(10)
    expect(r.providerSplit.copilotCli.spendUsd).toBe(0)
    expect(r.forecast).toBeNull()
    expect(r.kpis.momDeltaPct).toBeNull()
    expect(r.meta.range).toEqual({ from: '2026-07-03', to: '2026-07-08' })
  })

  it('the trend is windowed to the range and echoes the from/to bounds', async () => {
    const r = (await trendHandler(evAll(gfo(), 'from=2026-07-03&to=2026-07-08'))) as unknown as TrendResp
    expect(r.window).toEqual({ from: '2026-07-03', to: '2026-07-08' })
    expect(r.series).toEqual([{ day: '2026-07-05', key: 'claude-code', value: 10 }])
  })

  it('a partial range (only from) is a 400', async () => {
    await expect(trendHandler(evAll(gfo(), 'from=2026-07-03'))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('the month path is untouched — month=2026-07 still carries a non-null MoM (July 65 vs June 15)', async () => {
    // MoM is LIKE-FOR-LIKE: the June operand (dated June-01) sits inside the
    // day-of-month PACE window, so July MTD (65) is compared to June's matching pace (15).
    const r = (await acrossHandler(evAll(gfo(), 'month=2026-07'))) as unknown as AcrossResp
    expect(r.meta.range).toBeUndefined()
    expect(r.kpis.momDeltaPct).toBeCloseTo((65 - 15) / 15, 6)
  })
})
