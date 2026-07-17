// @vitest-environment node
/*
 * Finance §B lane DEPTH (lane-visuals V3) — the two widened finance reads
 * exercised against a real Postgres via the REAL handlers:
 *   - GET /reports/finance → `billCheck.anthropicLanes` (the Anthropic
 *     chargeback split by surface lane — the bill-compare card's per-lane
 *     structure within the Anthropic provider group);
 *   - GET /reports/finance/[couId] → `anthropicCharges[].lanes` (the drill
 *     query grouped teammate × tool — the dominant-lane badge source).
 *
 * The BLANKET CONSERVATION RULE (r1-F6): cent-exact —
 *   Σ anthropicLanes == billCheck.chargebackUsd − billCheck.copilotChargebackUsd;
 *   Σ each teammate row's lanes == that row's chargeUsd;
 *   Σ rows == anthropicChargeableUsd (the pre-widening totals byte-identical).
 * Plus the firewall: a §A copilot tool in actual_spend NEVER surfaces as an
 * Anthropic lane, in either read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import indexHandler from '../../../server/api/v1/reports/finance/index.get'
import drillHandler from '../../../server/api/v1/reports/finance/[couId].get'

let t: TestDb
let regionA = ''
let ccA = ''
let alice = ''
let bob = ''

const ev = (session: Session, query = '', params: Record<string, string> = {}) => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof indexHandler>[0]
}
const gfo = (): Session =>
  ({ teammateId: '00000000-0000-0000-0000-000000000009', email: 'x@x.test', displayName: 'X', role: 'global-finops', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)

const cents = (n: number) => Math.round(n * 100)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('ra', 'Region A')`
  const [ra] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='ra'`
  regionA = ra!.id
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionA}::uuid, 'a'::ltree, 'a', 'Practice A', 'bu', true)`
  const [ua] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='a'`
  ccA = ua!.id

  const mkTeammate = async (email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${regionA}::uuid, ${ccA}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  alice = await mkTeammate('alice@a.test')
  bob = await mkTeammate('bob@a.test')

  // Anthropic bill (actual_spend): cent-odd figures so conservation is genuinely
  // CENT-exact. alice spans TWO surfaces (claude + claude-ai); bob one.
  const spend = async (tm: string, day: string, tool: string, cost: number) => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
      VALUES (${tm}::uuid, ${day}::date, ${tool}, 100, 100, ${cost}, 'anthropic-analytics-api', false)`
  }
  await spend(alice, '2026-05-05', 'claude-code', 12.34)
  await spend(alice, '2026-05-06', 'claude-ai', 5.55)
  await spend(bob, '2026-05-05', 'claude-code', 1.11)
  // §A copilot tool in actual_spend — must NEVER surface as an Anthropic lane.
  await spend(alice, '2026-05-07', 'copilot-cli', 99)

  // Copilot pooled §B lanes: license 100 / usage 20 / unclassified 7 → the
  // whole-truth copilot chargeback term (127) the anthropic complement excludes.
  await t.client`INSERT INTO provider_enterprise (provider, external_id, display_name)
    VALUES ('github', 'ent-x', 'Enterprise X')`
  const [{ id: entId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM provider_enterprise WHERE external_id='ent-x'`
  await t.client`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, unclassified_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-05-01'::date, ${entId}::uuid, NULL, ${ccA}::uuid, 5, 100, 20, 7, 80, 90)`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface Lane { lane: string; label: string; usd: number }
interface IndexResp {
  billCheck: { chargebackUsd: number; copilotChargebackUsd: number; anthropicLanes: Lane[]; copilotLanes: Lane[] }
}
interface DrillResp {
  anthropicCharges: { teammateId: string; label: string; chargeUsd: number; lanes: Lane[] }[]
  anthropicChargeableUsd: number
}

describe('GET /reports/finance — billCheck.anthropicLanes (V3 per-lane provider structure)', () => {
  it('CONSERVATION: Σ anthropicLanes == chargebackUsd − copilotChargebackUsd, cent-exact', async () => {
    const r = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
    const sum = r.billCheck.anthropicLanes.reduce((a, l) => a + l.usd, 0)
    expect(cents(sum)).toBe(cents(r.billCheck.chargebackUsd - r.billCheck.copilotChargebackUsd))
    expect(cents(sum)).toBe(cents(12.34 + 5.55 + 1.11))
  })

  it('lanes are registry ids in canonical order; the §A copilot row NEVER surfaces', async () => {
    const r = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
    expect(r.billCheck.anthropicLanes.map((l) => l.lane)).toEqual(['claude', 'claude-ai'])
    const byLane = new Map(r.billCheck.anthropicLanes.map((l) => [l.lane, cents(l.usd)]))
    expect(byLane.get('claude')).toBe(cents(12.34 + 1.11))
    expect(byLane.get('claude-ai')).toBe(cents(5.55))
    // The $99 copilot-cli row is §A vocabulary — not an Anthropic lane, not a
    // copilot §B lane, not in any footing (the mig-0085 firewall).
    expect(r.billCheck.anthropicLanes.some((l) => l.lane.includes('copilot'))).toBe(false)
    expect(cents(r.billCheck.copilotChargebackUsd)).toBe(cents(127))
  })
})

describe('GET /reports/finance/[couId] — anthropicCharges[].lanes (V3 dominant-lane source)', () => {
  it('CONSERVATION: Σ each row\'s lanes == that row\'s chargeUsd; Σ rows == anthropicChargeableUsd', async () => {
    const d = (await drillHandler(ev(gfo(), 'month=2026-05', { couId: ccA }))) as unknown as DrillResp
    expect(d.anthropicCharges.length).toBe(2)
    for (const c of d.anthropicCharges) {
      const laneSum = c.lanes.reduce((a, l) => a + l.usd, 0)
      expect(cents(laneSum)).toBe(cents(c.chargeUsd))
    }
    const total = d.anthropicCharges.reduce((a, c) => a + c.chargeUsd, 0)
    expect(cents(total)).toBe(cents(d.anthropicChargeableUsd))
    expect(cents(total)).toBe(cents(19.0))
  })

  it('rows sort by charge DESC and carry per-lane splits in canonical order (firewalled)', async () => {
    const d = (await drillHandler(ev(gfo(), 'month=2026-05', { couId: ccA }))) as unknown as DrillResp
    const [first, second] = d.anthropicCharges
    // alice (17.89) over bob (1.11) — the pre-widening ORDER BY preserved.
    expect(first!.label).toBe('alice@a.test')
    expect(cents(first!.chargeUsd)).toBe(cents(17.89))
    expect(first!.lanes.map((l) => l.lane)).toEqual(['claude', 'claude-ai'])
    expect(cents(first!.lanes.find((l) => l.lane === 'claude')!.usd)).toBe(cents(12.34))
    expect(cents(first!.lanes.find((l) => l.lane === 'claude-ai')!.usd)).toBe(cents(5.55))
    expect(second!.label).toBe('bob@a.test')
    expect(second!.lanes).toEqual([{ lane: 'claude', label: 'Claude Code', usd: 1.11 }])
    // alice's $99 copilot-cli actual_spend row never appears in any lane.
    expect(first!.lanes.some((l) => l.lane.includes('copilot'))).toBe(false)
  })
})

/*
 * NULL-tool chargeback row (r3-1). A NULL `tool` is structurally impossible
 * TODAY (actual_spend.tool is NOT NULL), but both reads guard for it because
 * SQL NOT IN is NULL-unsafe — an unguarded predicate silently DROPS the row
 * instead of letting chargeToVendor(null) land it in the 'other' catch-all.
 * Make the hypothetical REAL: recreate BOTH chargeback views as
 * <original> UNION ALL <one NULL-tool $3.21 row> (same column signature, so
 * every consumer sees the row exactly as if a future source produced it), then
 * assert the index read (billCheck.anthropicLanes) and the drill read
 * (anthropicCharges) AGREE and both surface it in the catch-all lane.
 *
 * MUTATES the suite's views — restored in afterAll (belt) AND kept as the
 * last describe (braces): test order or a future append must not observe the
 * injected row.
 */
describe('NULL-tool chargeback row (r3-1) — never vanishes; both reads agree on the catch-all lane', () => {
  const originalDefs = new Map<string, string>()
  afterAll(async () => {
    // Restore the untouched view definitions so nothing after this describe
    // (or a shuffled sequence) runs against the mutated views.
    for (const [view, def] of originalDefs) {
      await t.client.unsafe(
        `CREATE OR REPLACE VIEW ${view} WITH (security_invoker = true) AS ${def.replace(/;\s*$/, '')}`,
      )
    }
  })
  beforeAll(async () => {
    const inject = async (view: string, unionRow: string) => {
      const [row] = await t.client<{ def: string }[]>`
        SELECT pg_get_viewdef(${view}::regclass, true) AS def`
      originalDefs.set(view, row!.def)
      await t.client.unsafe(
        `CREATE OR REPLACE VIEW ${view} WITH (security_invoker = true) AS
         SELECT * FROM (${row!.def.replace(/;\s*$/, '')}) base
         UNION ALL ${unionRow}`,
      )
    }
    // Day grain (the drill's view): alice, 2026-05-08, tool NULL, $3.21.
    await inject(
      'v_finance_bill_chargeback',
      `SELECT '${alice}'::uuid, DATE '2026-05-08', NULL::text,
              '${ccA}'::uuid, '${regionA}'::uuid, 3.21::numeric, 0::numeric`,
    )
    // Month grain (billCheck's view). The bill view's NULL row does NOT flow
    // through here by itself (the month view's own NOT IN drops NULLs), so the
    // month grain carries its own injected twin — one row per grain, no double
    // count within either read.
    await inject(
      'v_finance_chargeback_month',
      `SELECT '${ccA}'::uuid, '${regionA}'::uuid, NULL::text,
              DATE '2026-05-01', 3.21::numeric`,
    )
  })

  it('billCheck: the NULL-tool row lands in the catch-all lane and Σ anthropicLanes still reconciles', async () => {
    const r = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
    const other = r.billCheck.anthropicLanes.find((l) => l.lane === 'other')
    expect(other).toBeDefined()
    expect(cents(other!.usd)).toBe(cents(3.21))
    // Conservation still holds WITH the NULL row inside both operands.
    const sum = r.billCheck.anthropicLanes.reduce((a, l) => a + l.usd, 0)
    expect(cents(sum)).toBe(cents(r.billCheck.chargebackUsd - r.billCheck.copilotChargebackUsd))
    expect(cents(sum)).toBe(cents(12.34 + 5.55 + 1.11 + 3.21))
  })

  it('drill: the NULL-tool row lands in the teammate\'s catch-all lane — never silently dropped', async () => {
    const d = (await drillHandler(ev(gfo(), 'month=2026-05', { couId: ccA }))) as unknown as DrillResp
    const alice_ = d.anthropicCharges.find((c) => c.label === 'alice@a.test')!
    const other = alice_.lanes.find((l) => l.lane === 'other')
    expect(other).toBeDefined()
    expect(cents(other!.usd)).toBe(cents(3.21))
    // Per-row and whole-drill conservation include the NULL row.
    expect(cents(alice_.chargeUsd)).toBe(cents(17.89 + 3.21))
    const total = d.anthropicCharges.reduce((a, c) => a + c.chargeUsd, 0)
    expect(cents(total)).toBe(cents(d.anthropicChargeableUsd))
    expect(cents(total)).toBe(cents(19.0 + 3.21))
  })

  it('the two reads AGREE: billCheck\'s Anthropic complement == the drill\'s anthropicChargeableUsd', async () => {
    const r = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
    const d = (await drillHandler(ev(gfo(), 'month=2026-05', { couId: ccA }))) as unknown as DrillResp
    expect(cents(r.billCheck.chargebackUsd - r.billCheck.copilotChargebackUsd)).toBe(
      cents(d.anthropicChargeableUsd),
    )
  })
})
