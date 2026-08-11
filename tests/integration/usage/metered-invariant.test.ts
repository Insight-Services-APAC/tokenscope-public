// @vitest-environment node
/*
 * §A(metered) ≥ §B(metered) — the corrected-form invariant
 * (docs/design/usage-completeness-and-provider-governance.md §1.1 R1-H1, §3.3
 * "Invariant test"). Within a METERED lane, §A (v_complete_usage — provider
 * usage truth, now complete post-migration-0101) can never be less than §B
 * (v_finance_chargeback_month — a filtered subset of that same consumption).
 *
 * THE GLOBAL FORM IS FALSE, AND MUST NOT BE ASSERTED. §B carries a FIXED
 * `copilot-license` seat charge with no §A usage counterpart at all — an idle
 * licensed seat legitimately yields §A = 0, §B > 0. This suite asserts the
 * corrected, licence-excluded form across several scopes and windows, and
 * separately DEMONSTRATES (not merely claims) that the unqualified global form
 * fails on exactly this fixture — so the wrong assertion can never quietly
 * creep back in as "simpler".
 *
 * `copilot-unclassified` is excluded from the metered §B operand too, for the
 * same reason `computeAbDecomposition`'s sectionB does: it is a visible but
 * NEVER-chargeable bill line (an unmapped SKU), not real consumption money —
 * see server/reporting/finance.ts and server/usage/ab-decomposition.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

let t: TestDb
let regionApac: string
let regionEmea: string
let apacCc: string
let emeaCc: string
let alice: string
let bob: string

const WINDOW_MAY = { start: '2026-05-01', end: '2026-06-01' }
const WINDOW_MAY_FIRST_HALF = { start: '2026-05-01', end: '2026-05-16' }

/** Metered §A: the WHOLE of v_complete_usage — there is no "licence" concept in
 *  §A, so nothing needs excluding on this side. */
async function meteredSectionA(scope: { regionId?: string; costOwningUnitId?: string }, window: { start: string; end: string }): Promise<number> {
  const rows = await t.client<{ total: string }[]>`
    SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM v_complete_usage
    WHERE ts_event >= ${window.start}::date AND ts_event < ${window.end}::date
      ${scope.regionId ? t.client`AND region_id = ${scope.regionId}::uuid` : t.client``}
      ${scope.costOwningUnitId ? t.client`AND cost_owning_unit_id = ${scope.costOwningUnitId}::uuid` : t.client``}
  `
  return Number(rows[0]!.total)
}

/** Metered §B: v_finance_chargeback_month EXCLUDING the fixed licence lane and
 *  the never-chargeable unclassified lane (mirrors computeAbDecomposition's
 *  sectionB — server/usage/ab-decomposition.ts). */
async function meteredSectionB(scope: { regionId?: string; costOwningUnitId?: string }, window: { start: string; end: string }): Promise<number> {
  const rows = await t.client<{ total: string }[]>`
    SELECT COALESCE(SUM(charge_usd), 0)::text AS total FROM v_finance_chargeback_month
    WHERE period_month >= ${window.start}::date AND period_month < ${window.end}::date
      AND tool NOT IN ('copilot-license', 'copilot-unclassified')
      ${scope.regionId ? t.client`AND region_id = ${scope.regionId}::uuid` : t.client``}
      ${scope.costOwningUnitId ? t.client`AND cost_owning_unit_id = ${scope.costOwningUnitId}::uuid` : t.client``}
  `
  return Number(rows[0]!.total)
}

/** GLOBAL (unqualified) §B — every lane, including the fixed licence charge.
 *  Used ONLY to demonstrate why the global invariant must not be asserted. */
async function globalSectionB(window: { start: string; end: string }): Promise<number> {
  const rows = await t.client<{ total: string }[]>`
    SELECT COALESCE(SUM(charge_usd), 0)::text AS total FROM v_finance_chargeback_month
    WHERE period_month >= ${window.start}::date AND period_month < ${window.end}::date
      AND tool <> 'copilot-unclassified'
  `
  return Number(rows[0]!.total)
}

beforeAll(async () => {
  t = await startTestDb()
  const c = t.client

  const mkRegion = async (code: string, name: string) => {
    await c`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = ${code}`
    return r!.id
  }
  regionApac = await mkRegion('mi-apac', 'Metered Invariant APAC')
  regionEmea = await mkRegion('mi-emea', 'Metered Invariant EMEA')

  const mkUnit = async (region: string, path: string, code: string) => {
    await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', true)`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = ${code}`
    return r!.id
  }
  apacCc = await mkUnit(regionApac, 'mi.apac', 'mi-apac-cc')
  emeaCc = await mkUnit(regionEmea, 'mi.emea', 'mi-emea-cc')

  const mkTeammate = async (region: string, unit: string, email: string) => {
    await c`INSERT INTO teammate (entra_oid, email, region_id, org_unit_id) VALUES ('oid-' || ${email}, ${email}, ${region}::uuid, ${unit}::uuid)`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email = ${email}`
    return r!.id
  }
  alice = await mkTeammate(regionApac, apacCc, 'alice@metered-invariant.test')
  bob = await mkTeammate(regionEmea, emeaCc, 'bob@metered-invariant.test')

  // ── bob: OTel and bill agree exactly ($50) — the boundary case A == B ──────
  await c`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'oid-bob', ${bob}::uuid, 'claude-code', ${regionEmea}::uuid, ${emeaCc}::uuid, 'h', 'P')`
  const [{ id: bobInst }] = await c<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id = ${bob}::uuid`
  await c`INSERT INTO attribution_record (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${bobInst}::uuid, ${bob}::uuid, ${regionEmea}::uuid, ${emeaCc}::uuid, ${emeaCc}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100000, 50, 'tier-1', 'estimated', '2026-05-06T00:00:00Z'::timestamptz, 'conv-bob-mi')`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
    VALUES (${bob}::uuid, '2026-05-06'::date, 'claude-code', 50000, 50000, 50, 'anthropic-analytics-api')`

  // ── alice: OTel ($150) AHEAD of the bill ($100) on 05-08 — the genuine A > B
  // case (the reconciliation worker has not yet caught up that day; see
  // server/usage/ab-decomposition.ts's `floor` term for the identical shape) ──
  await c`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'oid-alice', ${alice}::uuid, 'claude-code', ${regionApac}::uuid, ${apacCc}::uuid, 'h', 'P')`
  const [{ id: aliceInst }] = await c<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id = ${alice}::uuid`
  await c`INSERT INTO attribution_record (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${aliceInst}::uuid, ${alice}::uuid, ${regionApac}::uuid, ${apacCc}::uuid, ${apacCc}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 300000, 150, 'tier-1', 'estimated', '2026-05-08T00:00:00Z'::timestamptz, 'conv-alice-mi')`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
    VALUES (${alice}::uuid, '2026-05-08'::date, 'claude-code', 200000, 200000, 100, 'anthropic-analytics-api')`

  // ── LICENSED IDLE SEAT: a Copilot enterprise with a real seat-licence charge
  // and ZERO usage anywhere (no reconciliation_record row at all). §A = 0,
  // §B(global) = $500 — this is the case the design says makes the GLOBAL
  // invariant false, homed to APAC's cost-owning unit so its effect on a
  // region/cost-centre scope is directly checkable too. ──
  await c`INSERT INTO provider_enterprise (provider, external_id, display_name) VALUES ('github', 'mi-ent', 'MI Enterprise')`
  const [{ id: entId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM provider_enterprise WHERE external_id = 'mi-ent'`
  await c`INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id, cost_owning_unit_id)
    VALUES ('github', 'mi-org', 'MI Org', ${entId}::uuid, ${apacCc}::uuid)`
  await c`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-05-01'::date, ${entId}::uuid, ${apacCc}::uuid, 5, 500, 0, 350, 0)`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('§A(metered) ≥ §B(metered) — the corrected R1-H1 invariant', () => {
  it('the GLOBAL (licence-included) form is FALSE on this fixture — demonstrating why it must never be asserted', async () => {
    const a = await meteredSectionA({}, WINDOW_MAY)
    const bGlobal = await globalSectionB(WINDOW_MAY)
    // §A = 50 (bob) + 150 (alice OTel) = 200. §B(global) = 50 + 100 + 500(licence) = 650.
    expect(a).toBe(200)
    expect(bGlobal).toBe(650)
    expect(a).toBeLessThan(bGlobal) // the idle-seat licence charge alone breaks the global form
  })

  it('holds whole-company, metered (licence excluded)', async () => {
    const a = await meteredSectionA({}, WINDOW_MAY)
    const b = await meteredSectionB({}, WINDOW_MAY)
    // §B(metered) = 50 (bob) + 100 (alice's current bill) = 150; no overage, no unclassified.
    expect(b).toBe(150)
    expect(a).toBeGreaterThanOrEqual(b)
    expect(a).toBe(200) // strictly greater here — alice's OTel-ahead-of-bill day
  })

  it('holds per REGION scope, metered', async () => {
    const aApac = await meteredSectionA({ regionId: regionApac }, WINDOW_MAY)
    const bApac = await meteredSectionB({ regionId: regionApac }, WINDOW_MAY)
    expect(aApac).toBeGreaterThanOrEqual(bApac)
    expect(aApac).toBe(150) // alice only
    expect(bApac).toBe(100)

    const aEmea = await meteredSectionA({ regionId: regionEmea }, WINDOW_MAY)
    const bEmea = await meteredSectionB({ regionId: regionEmea }, WINDOW_MAY)
    expect(aEmea).toBeGreaterThanOrEqual(bEmea)
    expect(aEmea).toBe(50) // bob only — the boundary A === B case
    expect(bEmea).toBe(50)
  })

  it('holds per COST-OWNING-UNIT scope, metered', async () => {
    const aApacCc = await meteredSectionA({ costOwningUnitId: apacCc }, WINDOW_MAY)
    const bApacCc = await meteredSectionB({ costOwningUnitId: apacCc }, WINDOW_MAY)
    expect(aApacCc).toBeGreaterThanOrEqual(bApacCc)

    const aEmeaCc = await meteredSectionA({ costOwningUnitId: emeaCc }, WINDOW_MAY)
    const bEmeaCc = await meteredSectionB({ costOwningUnitId: emeaCc }, WINDOW_MAY)
    expect(aEmeaCc).toBeGreaterThanOrEqual(bEmeaCc)
  })

  it('holds over a NON-month-aligned partial window', async () => {
    // Alice's 05-08 OTel/bill pair and bob's 05-06 pair both fall inside
    // [05-01, 05-16); the invariant must not depend on the window happening to
    // be a whole month.
    const a = await meteredSectionA({}, WINDOW_MAY_FIRST_HALF)
    const b = await meteredSectionB({}, WINDOW_MAY_FIRST_HALF)
    expect(a).toBeGreaterThanOrEqual(b)
    expect(a).toBe(200)
    expect(b).toBe(150)
  })

  it('the licence charge itself never appears on the §A side, at any scope (there is nothing to net it against)', async () => {
    // Sanity check on the fixture's own premise: v_complete_usage has no
    // licence-lane concept at all, so scoping to APAC's cost-owning unit (which
    // hosts the licensed-idle-seat org) must not silently pull the $500 into §A.
    const aApacCc = await meteredSectionA({ costOwningUnitId: apacCc }, WINDOW_MAY)
    expect(aApacCc).toBe(150) // alice's usage only — never the licence charge
  })
})
