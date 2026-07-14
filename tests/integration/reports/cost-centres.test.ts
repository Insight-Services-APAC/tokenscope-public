// @vitest-environment node
/*
 * Cost-Centre reporting scope — the Wave 3 endpoints (`/reports/cost-centres{,/
 * [ccId]}`, `/reports/export?scope=cost-centre`) exercised against a real
 * testcontainers Postgres via the OWNER connection (RLS inert in prod too, so the
 * in-query scope clauses are what's tested). Covers build-design §7:
 *   - RBAC: owner sees only owned + subtree cost-owning; non-owner/foreign 403;
 *     anti-IDOR on `ccId` (foreign region → 403, missing → 404);
 *   - the burn drill RECONCILES to the tracker card burn (both the §A PROJECT-CoU
 *     usage axis) — incl. a spender whose CURRENT placement moved (§A homes by
 *     emit-time cost_owning_unit_id, so they never vanish from the burn), and the
 *     NULL-CoU Copilot gap is excluded from both;
 *   - forecast (run-rate $) + exhaustion (budget DATE) are distinct mechanics;
 *   - burn drivers sum-back = headline (each drill axis, incl. the NULL bucket);
 *   - month-boundary invariance;
 *   - export byte-identical to the JSON figures.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import cardsHandler from '../../../server/api/v1/reports/cost-centres/index.get'
import drillHandler from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import exportHandler from '../../../server/api/v1/reports/export.get'

let t: TestDb
let regionA = ''
let regionB = ''
let ccA = '' // cost-owning practice 'a' (region A)
let ccCur = '' // cost-owning 'cur' (region A) — current-month forecast fixture
let ccB = '' // cost-owning 'b' (region B)
let alice = ''
let ownerDev = ''
let projA = ''

const now = new Date()
const currentMonth = now.toISOString().slice(0, 7)
const currentMonthStartIso = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
).toISOString()

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
  return e as unknown as Parameters<typeof cardsHandler>[0]
}
const sess = (role: string, orgPath: string, regionId: string, teammateId = '00000000-0000-0000-0000-000000000009'): Session =>
  ({ teammateId, email: 'x@x.test', displayName: 'X', role, regionId, orgPath, issuedAt: new Date().toISOString() } as unknown as Session)

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

  const mkUnit = async (region: string, path: string, code: string, costOwning: boolean, type = 'bu') => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${code}, ${type}, ${costOwning})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  ccA = await mkUnit(regionA, 'a', 'a', true)
  await mkUnit(regionA, 'a.team', 'a-team', false, 'team') // where alice/ellen/frank home → nearest CoU 'a'
  await mkUnit(regionA, 'a.owners', 'a-owners', false, 'team') // ownerDev's home (no cost-owning descendants)
  ccCur = await mkUnit(regionA, 'cur', 'cur', true)
  ccB = await mkUnit(regionB, 'b', 'b', true)

  const mkTeammate = async (region: string, path: string, email: string) => {
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND path=${path}::ltree`
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${u!.id}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  alice = await mkTeammate(regionA, 'a.team', 'alice@a.test')
  const carol = await mkTeammate(regionA, 'cur', 'carol@a.test')
  const daveNull = await mkTeammate(regionA, 'a.team', 'dave@a.test')
  ownerDev = await mkTeammate(regionA, 'a.owners', 'owner@a.test')
  // Phil H — ccA's largest spender, now placed in REGION B (a role/region change);
  // his July usage still HOMED to ccA at emit, so §A keeps him in ccA's burn drill.
  const phil = await mkTeammate(regionB, 'b', 'phil@b.test')

  // ownerDev OWNS ccA (a relationship, not a role) — sits outside their own subtree.
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${ccA}::uuid, ${ownerDev}::uuid)`

  // Projects (allocation source, homed to the CC).
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-A', 'hash-a', 'Project A', 'billable', ${regionA}::uuid, ${ccA}::uuid)`
  ;[{ id: projA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='PROJ-A'`
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-CUR', 'hash-cur', 'Project Cur', 'billable', ${regionA}::uuid, ${ccCur}::uuid)`
  const [{ id: projCur }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='PROJ-CUR'`

  // Allocations: ccA has 100 (burn 50 → 50% util); ccCur has 50 (burn 100 → over budget).
  await t.client`INSERT INTO audit_event (event_type, actor_system, payload) VALUES ('seed', 'test', '{}'::jsonb)`
  const [{ id: auditId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM audit_event ORDER BY ts_recorded DESC LIMIT 1`
  await t.client`INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
    VALUES ('project', ${projA}::uuid, 100.00, tstzrange('2020-01-01', NULL, '[)'), 'baseline', ${auditId}::uuid)`
  await t.client`INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
    VALUES ('project', ${projCur}::uuid, 50.00, tstzrange('2020-01-01', NULL, '[)'), 'baseline', ${auditId}::uuid)`

  const mkInstance = async (teammateId: string, region: string, path: string) => {
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND path=${path}::ltree`
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${region}::uuid, ${u!.id}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`
    return r!.id
  }
  const aliceInst = await mkInstance(alice, regionA, 'a.team')
  const carolInst = await mkInstance(carol, regionA, 'cur')
  const philInst = await mkInstance(phil, regionB, 'b')

  // Attribution = the PROJECT-CoU usage axis (cost_owning_unit_id set explicitly).
  const ar = async (inst: string, tm: string, region: string, cou: string, model: string, cost: number, day: string, projectId: string | null) => {
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE id=${cou}::uuid`
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${u!.id}::uuid, ${cou}::uuid, ${projectId}::uuid, 'claude-code', ${model}, 'input', 1000, ${cost}, 'tier-1', 'estimated', ${day}::timestamptz, ${'conv-' + tm + day})`
  }
  // ccA — alice: July sonnet 30 + opus 20 = 50 (project-CoU axis); June sonnet 15.
  await ar(aliceInst, alice, regionA, ccA, 'claude-sonnet-4-6', 30, '2026-07-02T00:00:00Z', projA)
  await ar(aliceInst, alice, regionA, ccA, 'claude-opus-4-6', 20, '2026-07-03T00:00:00Z', projA)
  await ar(aliceInst, alice, regionA, ccA, 'claude-sonnet-4-6', 15, '2026-06-05T00:00:00Z', projA)
  // ccCur — carol: current-month burn 100 (forecast/exhaustion fixture).
  await ar(carolInst, carol, regionA, ccCur, 'claude-sonnet-4-6', 100, currentMonthStartIso, projCur)
  // ccA — phil: July opus 90, emit-homed to ccA (region A) though he now sits in region B.
  // Proves §A groups by emit-time cost_owning_unit_id: a placement-moved spender STAYS.
  await ar(philInst, phil, regionA, ccA, 'claude-opus-4-6', 90, '2026-07-04T00:00:00Z', projA)

  // NULL-CoU Copilot gap (unaccounted): must NEVER appear in any CC burn.
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${daveNull}::uuid, ${regionA}::uuid, (SELECT id FROM org_unit WHERE region_id=${regionA}::uuid AND path='a.team'::ltree), '2026-07-10'::date, 'copilot-cli', 30, 0, 'api-reconciled')`

  // §B chargeback bill (region A, July) — alice actual_spend homes (teammate org_unit
  // 'a.team' → nearest cost-owning ancestor ccA) to ccA. Feeds the per-CC `chargeUsd`
  // (bill lane), NOT the burn (v_complete_usage). Distinct from the burn on purpose.
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${alice}::uuid, '2026-07-06'::date, 'claude-code', 800, 800, 40, 'anthropic-analytics-api', false)`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface Card { id: string; code: string; burnUsd: number; chargeUsd: number; allocationUsd: number; utilisation: number | null; exhaustionDate: string | null; forecast: { projectedUsd: number } | null }
interface CardsResp { cards: Card[]; laneNote: string; meta: { scope: string } }
interface DrillResp {
  cc: { id: string; code: string }
  burnUsd: number
  vendor: { claudeUsd: number; copilotUsd: number; otherUsd: number }
  allocationUsd: number
  axis: string; headlineUsd: number; denominatorLabel: string
  rows: { key: string; label: string; usd: number; sharePct: number; spendClass: string }[]
}

const adminA = () => sess('admin', 'a', regionA)
const ccOf = (r: CardsResp, code: string) => r.cards.find((c) => c.code === code)

describe('GET /reports/cost-centres — RBAC scope (owned ∪ subtree cost-owning)', () => {
  it('a pure owner (developer) sees ONLY their owned CC — not a region sibling', async () => {
    const r = (await cardsHandler(ev(sess('developer', 'a.owners', regionA, ownerDev), 'month=2026-07'))) as unknown as CardsResp
    expect(r.cards.map((c) => c.code).sort()).toEqual(['a'])
  })

  it('a manager sees the cost-owning units in their SUBTREE, never another region', async () => {
    const r = (await cardsHandler(ev(sess('manager', 'a', regionA), 'month=2026-07'))) as unknown as CardsResp
    expect(r.cards.map((c) => c.code)).toContain('a')
    expect(r.cards.map((c) => c.code)).not.toContain('b') // region B never
    expect(r.cards.map((c) => c.code)).not.toContain('cur') // 'cur' is not under 'a'
  })

  it('a region admin sees every cost-owning unit in their region (not another)', async () => {
    const r = (await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp
    expect(r.cards.map((c) => c.code).sort()).toEqual(['a', 'cur'])
  })

  it('global-finops sees every cost-owning unit across regions', async () => {
    const r = (await cardsHandler(ev(sess('global-finops', 'a', regionA), 'month=2026-07'))) as unknown as CardsResp
    expect(r.cards.map((c) => c.code).sort()).toEqual(['a', 'b', 'cur'])
  })

  it('a developer with no ownership and no cost-owning subtree sees nothing (not a 403)', async () => {
    const r = (await cardsHandler(ev(sess('developer', 'a.team', regionA, alice), 'month=2026-07'))) as unknown as CardsResp
    expect(r.cards).toEqual([])
  })
})

describe('GET /reports/cost-centres/[ccId] — resource-anchored RBAC (anti-IDOR)', () => {
  const drill = (s: Session, ccId: string, query = '') => drillHandler(ev(s, query, { ccId }))

  it('a region admin can drill a CC in their own region', async () => {
    const r = (await drill(adminA(), ccA, 'month=2026-07')) as unknown as DrillResp
    expect(r.cc.id).toBe(ccA)
  })

  it('an owner can drill their owned CC (any role)', async () => {
    const r = (await drill(sess('developer', 'a.owners', regionA, ownerDev), ccA, 'month=2026-07')) as unknown as DrillResp
    expect(r.cc.id).toBe(ccA)
  })

  it('anti-IDOR: a region admin drilling a FOREIGN-region CC → 403', async () => {
    await expect(drill(adminA(), ccB, 'month=2026-07')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a non-owner developer drilling a CC → 403 (no region scope, not owned)', async () => {
    await expect(
      drill(sess('developer', 'a.team', regionA, alice), ccA, 'month=2026-07'),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a non-existent CC uuid → 404 (not 403 — resolvable id, just absent)', async () => {
    await expect(
      drill(adminA(), '11111111-1111-4111-8111-111111111111', 'month=2026-07'),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('the burn drill is the §A usage axis — it RECONCILES to the tracker card burn', () => {
  it('the card burn is the PROJECT-CoU usage axis; the NULL-CoU Copilot gap is excluded', async () => {
    const r = (await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp
    const a = ccOf(r, 'a')!
    // alice 30+20 + phil 90 (emit-homed to ccA) = 140; dave's NULL-CoU copilot 30 EXCLUDED.
    expect(a.burnUsd).toBe(140)
    expect(a.allocationUsd).toBe(100)
    expect(r.laneNote.toLowerCase()).toContain('cost-owning')
  })

  it('the drill burn EQUALS the tracker card burn (same §A lane); the NULL-CoU gap is excluded', async () => {
    const card = ccOf((await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp, 'a')!
    const d = (await drillHandler(ev(adminA(), 'month=2026-07', { ccId: ccA }))) as unknown as DrillResp
    expect(d.burnUsd).toBe(140)
    expect(d.burnUsd).toBe(card.burnUsd) // the drill reconciles to the tracker row
    expect(d.headlineUsd).toBe(140)
    // All ccA July usage is claude-code; the NULL-CoU copilot gap never leaks in.
    expect(d.vendor.claudeUsd).toBe(140)
    expect(d.vendor.copilotUsd).toBe(0)
    // The drill also frames the burn against the CC's current-effective allocation.
    expect(d.allocationUsd).toBe(100)
  })

  it('a spender whose CURRENT placement MOVED still appears in the burn drill (the bug fix)', async () => {
    const d = (await drillHandler(ev(adminA(), 'month=2026-07&axis=teammate', { ccId: ccA }))) as unknown as DrillResp
    // Phil is now placed in region B, but his July usage homed to ccA at emit — §A groups
    // by emit-time cost_owning_unit_id, so he is ccA's LARGEST driver, not dropped.
    const phil = d.rows.find((r) => r.label === 'phil@b.test')
    expect(phil).toBeDefined()
    expect(phil!.usd).toBe(90)
    expect(d.rows[0]!.label).toBe('phil@b.test') // ranked first (burn desc)
  })
})

describe('the per-CC §B chargeUsd is the bill lane, kept SEPARATE from the §A burn', () => {
  it('ccA carries a chargeUsd (Anthropic bill homed by teammate) distinct from its burn', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp
    const a = ccOf(r, 'a')!
    // Burn (§A usage axis) = 140; chargeback (§B bill, alice homed to ccA) = 40 — DIFFERENT
    // lanes, DIFFERENT numbers, never summed.
    expect(a.burnUsd).toBe(140)
    expect(a.chargeUsd).toBe(40)
    // A CC with burn but no bill homed to it carries chargeUsd 0 ('cur' — carol has no bill).
    expect(ccOf(r, 'cur')!.chargeUsd).toBe(0)
  })
})

describe('the two on-track mechanics are DISTINCT (budget DATE ≠ run-rate $)', () => {
  it('a current-month card carries a run-rate dollar AND a budget-exhaustion date', async () => {
    const r = (await cardsHandler(ev(adminA(), `month=${currentMonth}`))) as unknown as CardsResp
    const cur = ccOf(r, 'cur')!
    // Mechanic 2 — run-rate: a DOLLAR (number).
    expect(cur.forecast).not.toBeNull()
    expect(typeof cur.forecast!.projectedUsd).toBe('number')
    // Mechanic 1 — budget exhaustion: a DATE string (burn 100 > allocation 50 → already exhausted).
    expect(cur.exhaustionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Distinct shapes, distinct mechanics — never one number.
    expect(String(cur.forecast!.projectedUsd)).not.toBe(cur.exhaustionDate)
  })
})

describe('GET /reports/cost-centres/[ccId] — burn drivers sum-back = headline (every axis)', () => {
  const axes = ['teammate', 'model'] as const
  for (const axis of axes) {
    it(`axis=${axis}: Σ rows = burn headline`, async () => {
      const d = (await drillHandler(ev(adminA(), `month=2026-07&axis=${axis}`, { ccId: ccA }))) as unknown as DrillResp
      const sum = d.rows.reduce((a, r) => a + r.usd, 0)
      expect(sum).toBeCloseTo(d.headlineUsd, 6)
      expect(d.headlineUsd).toBe(140) // the CC burn — the SAME lane as the tracker
      expect(d.denominatorLabel).toBe('cost-centre burn')
      const shareSum = d.rows.reduce((a, r) => a + r.sharePct, 0)
      expect(shareSum).toBeCloseTo(1, 6)
    })
  }

  it('teammate axis: every §A row is `indicative` (a usage $, never a per-user charge)', async () => {
    const d = (await drillHandler(ev(adminA(), 'month=2026-07&axis=teammate', { ccId: ccA }))) as unknown as DrillResp
    expect(d.rows.every((r) => r.spendClass === 'indicative')).toBe(true)
    const aliceRow = d.rows.find((r) => r.label === 'alice@a.test')!
    expect(aliceRow.usd).toBe(50) // 30 sonnet + 20 opus
  })

  it('model axis: the model buckets (sonnet + opus) sum back to the burn', async () => {
    const d = (await drillHandler(ev(adminA(), 'month=2026-07&axis=model', { ccId: ccA }))) as unknown as DrillResp
    const opus = d.rows.find((r) => r.label === 'claude-opus-4-6')!
    const sonnet = d.rows.find((r) => r.label === 'claude-sonnet-4-6')!
    expect(opus.usd).toBe(110) // alice 20 + phil 90
    expect(sonnet.usd).toBe(30) // alice 30
    expect(opus.usd + sonnet.usd).toBe(140)
  })
})

describe('GET /reports/cost-centres — month-boundary invariance', () => {
  it('Σ per-month (June + July) burn = the unbounded total over the range for ccA', async () => {
    const june = ccOf((await cardsHandler(ev(adminA(), 'month=2026-06'))) as unknown as CardsResp, 'a')!
    const july = ccOf((await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp, 'a')!
    expect(june.burnUsd).toBe(15) // alice June sonnet 15 (phil has no June usage)
    expect(july.burnUsd).toBe(140) // alice 30+20 + phil 90
    const [{ total }] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM v_complete_usage
      WHERE cost_owning_unit_id = ${ccA}::uuid
        AND ts_event >= '2026-06-01T00:00:00Z'::timestamptz
        AND ts_event <  '2026-08-01T00:00:00Z'::timestamptz`
    expect(june.burnUsd + july.burnUsd).toBe(Number(total))
    expect(Number(total)).toBe(155)
  })
})

describe('GET /reports/cost-centres/[ccId] — range/quarter mode reconciles to the tracker', () => {
  // A multi-month custom window (June + July) — the tracker card AND the burn drill must
  // window the SAME range, so the drill headline == the card burn (the review invariant:
  // a range/quarter drill previously collapsed to ONE month and no longer reconciled).
  const RANGE = 'from=2026-06-01&to=2026-07-31'

  it('the drill burn EQUALS the range-windowed tracker card burn (June 15 + July 140 = 155)', async () => {
    const card = ccOf((await cardsHandler(ev(adminA(), RANGE))) as unknown as CardsResp, 'a')!
    const d = (await drillHandler(ev(adminA(), RANGE, { ccId: ccA }))) as unknown as DrillResp
    // June alice 15 + July (alice 50 + phil 90) = 155 — the WHOLE range, not one month.
    expect(card.burnUsd).toBe(155)
    expect(d.burnUsd).toBe(155)
    expect(d.burnUsd).toBe(card.burnUsd) // the drill reconciles to the tracker row in range mode
    expect(d.headlineUsd).toBe(155)
  })

  it('the placement-moved spender is still present in the range drill + drivers foot to the range burn', async () => {
    const d = (await drillHandler(ev(adminA(), `${RANGE}&axis=teammate`, { ccId: ccA }))) as unknown as DrillResp
    const phil = d.rows.find((r) => r.label === 'phil@b.test')
    expect(phil).toBeDefined()
    expect(phil!.usd).toBe(90) // §A homes by emit-time cost_owning_unit_id — never dropped
    expect(d.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(155, 6) // Σ drivers = range burn
  })
})

describe('GET /reports/export?scope=cost-centre — byte-identical to the screen figures', () => {
  it('the CC-grid CSV rows carry the SAME burn/allocation/mechanics as the JSON', async () => {
    const json = (await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp
    const csv = (await exportHandler(ev(adminA(), 'scope=cost-centre&report=cards&month=2026-07'))) as unknown as string
    const lines = csv.trim().split('\n')
    expect(lines[0]).toMatch(/^# tokenscope cost-centres/)
    expect(lines[1]).toBe('cost_centre,region,burn_usd,charge_usd,allocation_usd,utilisation_pct,exhaustion_date,projected_month_end_usd')
    const byBurn = new Map<string, string[]>()
    for (const line of lines.slice(2)) {
      const cols = line.split(',')
      byBurn.set(cols[2]!, cols) // key on burn_usd (unique per seeded CC)
    }
    const a = json.cards.find((c) => c.code === 'a')!
    const row = byBurn.get(a.burnUsd.toFixed(2))!
    expect(row).toBeDefined()
    expect(row[2]).toBe('140.00') // burn_usd (§A)
    expect(row[3]).toBe('40.00') // charge_usd (§B, always present) — alice's July bill homed to ccA
    expect(row[4]).toBe('100.00') // allocation_usd
    expect(row[5]).toBe('140.0') // utilisation_pct
  })

  it('the burn-drivers CSV rows carry the SAME spend + share as the JSON endpoint', async () => {
    const json = (await drillHandler(ev(adminA(), 'month=2026-07&axis=teammate', { ccId: ccA }))) as unknown as DrillResp
    const csv = (await exportHandler(ev(adminA(), `scope=cost-centre&report=drivers&cc=${ccA}&axis=teammate&month=2026-07`))) as unknown as string
    const lines = csv.trim().split('\n')
    expect(lines[0]).toMatch(/^# tokenscope cost-centre drivers/)
    expect(lines[1]).toBe('driver,spend_usd,share_pct,spend_class')
    const csvByLabel = new Map<string, { usd: number; share: number; klass: string }>()
    for (const line of lines.slice(2)) {
      const [label, usd, share, klass] = line.split(',')
      csvByLabel.set(label!, { usd: Number(usd), share: Number(share), klass: klass! })
    }
    for (const r of json.rows) {
      const c = csvByLabel.get(r.label)!
      expect(c).toBeDefined()
      expect(c.usd).toBe(Number(r.usd.toFixed(2)))
      expect(c.share).toBe(Number((r.sharePct * 100).toFixed(1)))
      expect(c.klass).toBe(r.spendClass)
    }
    // The placement-moved top spender is byte-present in the CSV (§A usage, indicative).
    expect(csv).toContain('phil@b.test,90.00,64.3,indicative')
  })

  it('the export inherits the drill anti-IDOR gate (foreign-region CC → 403)', async () => {
    await expect(
      exportHandler(ev(adminA(), `scope=cost-centre&report=drivers&cc=${ccB}&axis=teammate&month=2026-07`)),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('in RANGE mode the drivers CSV windows the SAME range as the drill (byte-identical)', async () => {
    const RANGE = 'from=2026-06-01&to=2026-07-31'
    const json = (await drillHandler(ev(adminA(), `${RANGE}&axis=teammate`, { ccId: ccA }))) as unknown as DrillResp
    const csv = (await exportHandler(ev(adminA(), `scope=cost-centre&report=drivers&cc=${ccA}&axis=teammate&${RANGE}`))) as unknown as string
    const lines = csv.trim().split('\n')
    const csvByLabel = new Map<string, { usd: number; share: number }>()
    for (const line of lines.slice(2)) {
      const [label, usd, share] = line.split(',')
      csvByLabel.set(label!, { usd: Number(usd), share: Number(share) })
    }
    for (const r of json.rows) {
      const c = csvByLabel.get(r.label)!
      expect(c).toBeDefined()
      expect(c.usd).toBe(Number(r.usd.toFixed(2)))
      expect(c.share).toBe(Number((r.sharePct * 100).toFixed(1)))
    }
    // Phil's full-range spend (90) is present — NOT the July-only single-month figure.
    expect(csv).toContain('phil@b.test,90.00,')
    // The screen headline the CSV foots to is the range burn (155), not one month (140).
    expect(json.headlineUsd).toBe(155)
  })
})
