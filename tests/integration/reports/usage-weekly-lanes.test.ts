// @vitest-environment node
/*
 * §A per-surface weekly usage lanes (requirement 1 — the screenshot-derived fix):
 *   - GET /reports/across-regions/trend → `usageWeeklyLanes`
 *   - GET /reports/regional/trend       → `usageWeeklyLanes` (region-clamped)
 *
 * REPLACES `showback-weekly-lanes.test.ts` (deleted): that suite pinned the OLD,
 * WRONG contract — a usage-mode hero fed from `v_finance_bill_showback` (a §B
 * billed-basis view), firewalling GitHub tools OUT specifically because they were
 * usage-basis rows riding a billed view. This suite pins the CORRECT contract:
 *   - Σ(usageWeeklyLanes) == the window's `v_complete_usage` genuine total,
 *     cent-exact, recomputed independently against the view;
 *   - EVERY §A surface — including `copilot`/`copilot-agent`, invisible under the
 *     old billed-basis firewall — rides the cells natively;
 *   - THE HEADLINE INVARIANT (requirement 9): for the SAME window, the trend
 *     endpoint's `usageWeeklyLanes` sum equals the index endpoint's
 *     `kpis.genuineUsd` EXACTLY — "usage surface hero equals §A headline for
 *     same window";
 *   - weeks are ISO Mondays (`date_trunc('week')`), lanes are registry ids;
 *   - the regional mirror is clamped by the SAME usage scope `fetchRegionalKpis`
 *     uses (a foreign region's usage rows never leak in).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import acrossHandler from '../../../server/api/v1/reports/region/index.get'
import regionTrend from '../../../server/api/v1/reports/region/trend.get'

let t: TestDb
let regionA = ''
let regionB = ''
let unitA = ''
let unitB = ''
let alice = ''
let bob = ''
let instAlice = ''
let instBob = ''

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
  return e as unknown as Parameters<typeof regionTrend>[0]
}
/*
 * The WHOLE-COMPANY width of the merged `/reports/region*` family (was the
 * separate `/reports/across-regions*` routes). `region=all` is not an optional
 * extra here — it is what selects the unclamped engine scope, so every call that
 * used to reach an across route reaches it through this.
 */
const evAll = (session: Session, query = '') =>
  ev(session, query ? `${query}&region=all` : 'region=all')

const gfo = (): Session =>
  ({ teammateId: '00000000-0000-0000-0000-000000000009', email: 'x@x.test', displayName: 'X', role: 'global-finops', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)

const cents = (n: number) => Math.round(n * 100)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const mkRegion = async (code: string, name: string) => {
    await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
    return r!.id
  }
  regionA = await mkRegion('uwla', 'UWL Region A')
  regionB = await mkRegion('uwlb', 'UWL Region B')

  const mkUnit = async (region: string, path: string, code: string) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  unitA = await mkUnit(regionA, 'uwla', 'uwla')
  unitB = await mkUnit(regionB, 'uwlb', 'uwlb')

  const mkTeammate = async (region: string, unit: string, email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  alice = await mkTeammate(regionA, unitA, 'alice@uwl.test')
  bob = await mkTeammate(regionB, unitB, 'bob@uwl.test')

  /*
   * mig 0129: `gfo()` below resolves to this DEDICATED sentinel id — the ONLY
   * place in this file that id appears (grep confirms no other role/persona
   * shares it). A real backing row is required for the `report_access_grant`
   * FK; both permissions are granted so the whole-company (`region=all`) width
   * and the region-clamped trend calls the tests below exercise keep working
   * under the new per-teammate grants model.
   */
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('00000000-0000-0000-0000-000000000009'::uuid, 'oid-uwl-finops', 'uwl-finops@x.test', 'UWL Finops', ${regionA}::uuid, ${unitA}::uuid, true)`
  await grantReportAccess(t.client, '00000000-0000-0000-0000-000000000009')

  const mkInstance = async (teammate: string, region: string, unit: string) => {
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p-'||${teammate}, ${teammate}::uuid, 'claude-code', ${region}::uuid, ${unit}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammate}::uuid LIMIT 1`
    return r!.id
  }
  instAlice = await mkInstance(alice, regionA, unitA)
  instBob = await mkInstance(bob, regionB, unitB)

  // arm 1 (otel-emitted, attribution_record): claude-code AND copilot-cli — the
  // exact case the OLD billed-showback firewall made invisible in the hero.
  const ar = async (inst: string, tm: string, region: string, unit: string, day: string, tool: string, cost: number) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${unit}::uuid, ${tool}, 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated',
              (${day}::date)::timestamp, 'conv-'||${tool}||'-'||${day})`
  }
  await ar(instAlice, alice, regionA, unitA, '2026-07-01', 'claude-code', 12.34)
  await ar(instAlice, alice, regionA, unitA, '2026-07-02', 'claude-code', 1.11)
  await ar(instAlice, alice, regionA, unitA, '2026-07-03', 'copilot-cli', 99.00)
  await ar(instBob, bob, regionB, unitB, '2026-07-02', 'claude-code', 7.77)

  // arm 3 (provider-usage, via v_teammate_usage_daily): a non-Code Claude surface
  // (actual_spend) AND the coding-agent lane (reconciliation_record) — genuinely
  // NEW visible lanes under the §A basis (never in ANY showback element before).
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
      region_id, org_unit_id, cost_owning_unit_id, dimension_source)
    VALUES (${alice}::uuid, '2026-07-02'::date, 'claude-ai', 500, 500, 5.55, 'anthropic-analytics-api',
      ${regionA}::uuid, ${unitA}::uuid, ${unitA}::uuid, 'ingest-snapshot')`
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
      region_id, org_unit_id, cost_owning_unit_id, dimension_source)
    VALUES (${alice}::uuid, '2026-07-07'::date, 'claude-cowork', 200, 200, 7.89, 'anthropic-analytics-api',
      ${regionA}::uuid, ${unitA}::uuid, ${unitA}::uuid, 'ingest-snapshot')`
  await t.client`INSERT INTO reconciliation_record
      (teammate_id, provider, enterprise_ref, period_date, category, scope, region_id, org_unit_id, cost_owning_unit_id,
       actual_qty, actual_unit_type, actual_usd, otel_attributed_usd, delta_usd, spend_class, disposition, status)
    VALUES (${alice}::uuid, 'github', 'ent-uwl', '2026-07-03'::date, 'copilot_coding_agent', 'teammate',
      ${regionA}::uuid, ${unitA}::uuid, ${unitA}::uuid,
      '10', 'ai-credits', '44.00', '0', '44.00', 'indicative', 'ingest_only', 'proposed')`
  // Region B's claude row (7.77) is the ONLY region-B row — must never leak into region A.
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface TrendResp {
  window: { from: string; to: string }
  usageWeeklyLanes: { weekStart: string; lane: string; usd: number }[]
}
interface AcrossResp {
  kpis: { genuineUsd: number }
}

// July: 12.34+1.11 (claude-code) + 99 (copilot-cli) + 5.55 (claude-ai) + 7.89 (claude-cowork)
// + 44 (copilot-agent, coding agent) + 7.77 (bob, claude-code) = company total.
const ALICE_TOTAL = 12.34 + 1.11 + 99 + 5.55 + 7.89 + 44
const COMPANY_TOTAL = ALICE_TOTAL + 7.77

describe('GET /reports/across-regions/trend — usageWeeklyLanes (whole company)', () => {
  it('CONSERVATION: Σ cells == the v_complete_usage window total, cent-exact, incl. GitHub lanes', async () => {
    const r = (await regionTrend(evAll(gfo(), 'month=2026-07'))) as unknown as TrendResp
    const sum = r.usageWeeklyLanes.reduce((a, c) => a + c.usd, 0)
    expect(cents(sum)).toBe(cents(COMPANY_TOTAL))
    // Independent recompute straight off v_complete_usage (never v_finance_bill_showback).
    const [indep] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total
      FROM v_complete_usage
      WHERE ts_event >= '2026-07-01'::timestamptz AND ts_event < '2026-08-01'::timestamptz`
    expect(cents(sum)).toBe(cents(Number(indep!.total)))
  })

  it('GitHub lanes (copilot / copilot-agent) NOW surface — the old billed-showback firewall is gone', async () => {
    const r = (await regionTrend(evAll(gfo(), 'month=2026-07'))) as unknown as TrendResp
    const lanes = new Set(r.usageWeeklyLanes.map((c) => c.lane))
    expect(lanes.has('copilot')).toBe(true)
    expect(lanes.has('copilot-agent')).toBe(true)
    expect(lanes).toEqual(new Set(['claude', 'claude-ai', 'claude-cowork', 'copilot', 'copilot-agent']))
  })

  it('weeks are ISO Mondays; lanes are registry ids', async () => {
    const r = (await regionTrend(evAll(gfo(), 'month=2026-07'))) as unknown as TrendResp
    expect(new Set(r.usageWeeklyLanes.map((c) => c.weekStart))).toEqual(
      new Set(['2026-06-29', '2026-07-06']),
    )
    // Week 2026-06-29 (Jul 1–3): claude 12.34+1.11+7.77, claude-ai 5.55, copilot 99, copilot-agent 44.
    const w1 = new Map(
      r.usageWeeklyLanes.filter((c) => c.weekStart === '2026-06-29').map((c) => [c.lane, cents(c.usd)]),
    )
    expect(w1).toEqual(
      new Map([
        ['claude', cents(12.34 + 1.11 + 7.77)],
        ['claude-ai', cents(5.55)],
        ['copilot', cents(99)],
        ['copilot-agent', cents(44)],
      ]),
    )
  })

  it('HEADLINE INVARIANT (requirement 9): Σ(usageWeeklyLanes) == kpis.genuineUsd for the SAME window', async () => {
    const win = 'from=2026-07-01&to=2026-07-31'
    const trend = (await regionTrend(evAll(gfo(), win))) as unknown as TrendResp
    const index = (await acrossHandler(evAll(gfo(), win))) as unknown as AcrossResp
    const sum = trend.usageWeeklyLanes.reduce((a, c) => a + c.usd, 0)
    expect(cents(sum)).toBe(cents(index.kpis.genuineUsd))
    expect(cents(sum)).toBe(cents(COMPANY_TOTAL))
  })

  it('windows to a custom range like the other series (the ONE shared window object)', async () => {
    const r = (await regionTrend(evAll(gfo(), 'from=2026-07-07&to=2026-07-07'))) as unknown as TrendResp
    expect(r.window).toEqual({ from: '2026-07-07', to: '2026-07-07' })
    expect(r.usageWeeklyLanes).toEqual([
      { weekStart: '2026-07-06', lane: 'claude-cowork', usd: 7.89 },
    ])
  })
})

describe('GET /reports/regional/trend — usageWeeklyLanes (region-clamped)', () => {
  it('CONSERVATION within the region: Σ cells == region A total; bob NEVER leaks', async () => {
    const r = (await regionTrend(ev(gfo(), 'month=2026-07'))) as unknown as TrendResp
    const sum = r.usageWeeklyLanes.reduce((a, c) => a + c.usd, 0)
    expect(cents(sum)).toBe(cents(ALICE_TOTAL))
    const w1Claude = r.usageWeeklyLanes.find(
      (c) => c.weekStart === '2026-06-29' && c.lane === 'claude',
    )!
    expect(cents(w1Claude.usd)).toBe(cents(12.34 + 1.11)) // bob's 7.77 excluded
  })

  it('echoes the shared window object; the other region sees ONLY its own rows', async () => {
    const r = (await regionTrend(ev(gfo(), 'month=2026-07'))) as unknown as TrendResp
    expect(r.window).toEqual({ from: '2026-07-01', to: '2026-07-31' })

    const rb = (await regionTrend(
      ev(gfo(), `month=2026-07&region=${regionB}`),
    )) as unknown as TrendResp
    expect(rb.usageWeeklyLanes).toEqual([
      { weekStart: '2026-06-29', lane: 'claude', usd: 7.77 },
    ])
  })
})
