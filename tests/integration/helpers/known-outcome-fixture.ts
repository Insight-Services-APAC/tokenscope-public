/*
 * KNOWN-OUTCOME reporting fixture — a fully-specified synthetic company where
 * EVERY expected report value is hand-derivable from the seed. Built to PROVE the
 * /reporting numbers reconcile (owner lost trust after two hand-waved answers), so
 * the seed is deliberately small, explicit, and commented with the arithmetic each
 * row feeds.
 *
 * Truth anchored on the canonical model (docs/design/provider-billing-attribution-
 * model.md §A vs §B) + the live view definitions:
 *   - v_complete_usage        (mig 0082) — §A usage = attribution ∪ unaccounted gap
 *   - v_finance_bill_chargeback / v_finance_chargeback_month (mig 0081) — §B charge
 *   - v_finance_copilot_pool_chargeback (mig 0081) — Copilot pooled net
 *   - getMyUsage (server/utils/me-queries.ts) — the personal "My usage" total
 *
 * THE COMPANY (all usage in May 2026; fixed clock now = 2026-05-15T12:00Z):
 *
 *   Regions:  APAC, EMEA
 *   Units [all cost-owning]:
 *     apac            "APAC (default)"
 *     apac.cto        "CTO APAC"
 *     apac.delivery   "APAC Delivery"
 *     emea            "EMEA (default)"
 *     emea.delivery   "EMEA Delivery"
 *   Teammates (emit-home org_unit):
 *     alice → apac.cto        bob   → apac.delivery
 *     carol → emea.delivery   dave  → apac (unplaced/default)
 *   Projects (cost_owning_unit, allocation):
 *     proj-scholarship → apac.cto      $500
 *     proj-deliveryx   → apac.delivery $1000
 *     proj-emea        → emea.delivery $1000
 *
 * ANTHROPIC (claude-code) — the bill truth (actual_spend), with matching OTel
 * attribution_record tagged to the named project (so attribution.cost_owning_unit_id
 * = the PROJECT's unit — the §A cost-centre-burn axis):
 *   alice $350  →  $100 proj-scholarship (apac.cto) + $250 proj-deliveryx (apac.delivery)
 *   bob   $300  →  proj-deliveryx (apac.delivery)
 *   carol $200  →  proj-emea (emea.delivery)
 *   dave  $50   →  NO attribution (un-enrolled) → surfaces as the §A unaccounted gap
 *                  (NULL cost_owning_unit); the $50 bill still charges §B to apac.
 *
 * COPILOT — §A per-user gross usage (materialised into unaccounted_usage the way the
 * reconcile worker writes it; NULL cost_owning_unit, region = teammate's region):
 *   alice 500 credits = $5     bob 1000 credits = $10
 *   §B pooled bill (copilot_pool_bill): license_net $40, overage_net $0, homed to
 *   apac.delivery, month = May.
 *
 * Token amounts are cost×2000 (split evenly input/output on the bill) so token
 * assertions are derivable: billed (claude) tokens = 900×2000 = 1,800,000.
 */
import type { TestDb } from './db'

/** The fixed injected clock the personal/current-month reads use. */
export const KO_NOW = new Date('2026-05-15T12:00:00.000Z')

/** May 2026 half-open UTC window `[2026-05-01, 2026-06-01)`. */
export const KO_MAY_WINDOW = {
  startIso: '2026-05-01T00:00:00.000Z',
  endIso: '2026-06-01T00:00:00.000Z',
}

/**
 * A NON-month-aligned PARTIAL window `[2026-05-06, 2026-05-08)` — covers bob's 05-06
 * Anthropic bill (300) + carol's 05-07 bill (200) ONLY; alice (05-05) and dave (05-08)
 * fall OUTSIDE the half-open bounds. Proves the §B Anthropic chargeback lane windows by
 * DAY, not by month: the chargeable is 500, NOT the whole-month 900 — and NOT the pre-fix
 * $0 (the month view keyed `period_month = 2026-05-01`, which is ∉ [05-06, 05-08), so the
 * month-grained headline dropped to $0 while the day-grained tiles still showed real bars).
 */
export const KO_MAY_PARTIAL_WINDOW = {
  startIso: '2026-05-06T00:00:00.000Z',
  endIso: '2026-05-08T00:00:00.000Z',
}

export interface KnownOutcomeIds {
  regionApac: string
  regionEmea: string
  uApac: string
  uApacCto: string
  uApacDelivery: string
  uEmea: string
  uEmeaDelivery: string
  alice: string
  bob: string
  carol: string
  dave: string
  projScholarship: string
  projDeliveryx: string
  projEmea: string
}

/**
 * Seed the known-outcome company into a fresh testcontainers DB. Returns the ids the
 * assertions key on. Idempotent per-DB (called once in beforeAll).
 */
export async function seedKnownOutcomeCompany(t: TestDb): Promise<KnownOutcomeIds> {
  const c = t.client

  // ── Regions ────────────────────────────────────────────────────────────────
  const mkRegion = async (code: string, name: string) => {
    await c`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
    return r!.id
  }
  const regionApac = await mkRegion('apac', 'APAC')
  const regionEmea = await mkRegion('emea', 'EMEA')

  // ── Org units (ALL cost-owning, matching the scenario's [CO] markers) ────────
  const mkUnit = async (region: string, path: string, code: string, name: string) => {
    await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${name}, 'bu', true)`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  const uApac = await mkUnit(regionApac, 'apac', 'apac', 'APAC (default)')
  const uApacCto = await mkUnit(regionApac, 'apac.cto', 'apac-cto', 'CTO APAC')
  const uApacDelivery = await mkUnit(regionApac, 'apac.delivery', 'apac-delivery', 'APAC Delivery')
  const uEmea = await mkUnit(regionEmea, 'emea', 'emea', 'EMEA (default)')
  const uEmeaDelivery = await mkUnit(regionEmea, 'emea.delivery', 'emea-delivery', 'EMEA Delivery')

  // ── Teammates (emit-home org_unit) ───────────────────────────────────────────
  const mkTeammate = async (region: string, orgUnitId: string, email: string) => {
    await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${orgUnitId}::uuid, true)`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  const alice = await mkTeammate(regionApac, uApacCto, 'alice@ko.test')
  const bob = await mkTeammate(regionApac, uApacDelivery, 'bob@ko.test')
  const carol = await mkTeammate(regionEmea, uEmeaDelivery, 'carol@ko.test')
  const dave = await mkTeammate(regionApac, uApac, 'dave@ko.test')

  // ── Instances (attribution FK) — dave has none (un-enrolled, no OTel) ─────────
  const mkInstance = async (teammateId: string, region: string, orgUnitId: string) => {
    await c`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${region}::uuid, ${orgUnitId}::uuid, 'h', 'P')`
    const [r] = await c<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`
    return r!.id
  }
  const aliceInst = await mkInstance(alice, regionApac, uApacCto)
  const bobInst = await mkInstance(bob, regionApac, uApacDelivery)
  const carolInst = await mkInstance(carol, regionEmea, uEmeaDelivery)

  // ── Projects (cost_owning_unit) ──────────────────────────────────────────────
  const mkProject = async (code: string, name: string, region: string, cou: string) => {
    await c`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES (${code}, 'hash-'||${code}, ${name}, 'billable', ${region}::uuid, ${cou}::uuid)`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code=${code}`
    return r!.id
  }
  const projScholarship = await mkProject('PROJ-SCHOLARSHIP', 'Scholarship', regionApac, uApacCto)
  const projDeliveryx = await mkProject('PROJ-DELIVERYX', 'Delivery X', regionApac, uApacDelivery)
  const projEmea = await mkProject('PROJ-EMEA', 'EMEA Project', regionEmea, uEmeaDelivery)

  // ── Allocations (baseline, shared pool — teammate_id NULL) ────────────────────
  await c`INSERT INTO audit_event (event_type, actor_system, payload) VALUES ('seed', 'test', '{}'::jsonb)`
  const [{ id: auditId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM audit_event ORDER BY ts_recorded DESC LIMIT 1`
  const mkAlloc = async (projectId: string, budget: number) => {
    await c`INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
      VALUES ('project', ${projectId}::uuid, ${budget}, tstzrange('2020-01-01', NULL, '[)'), 'baseline', ${auditId}::uuid)`
  }
  await mkAlloc(projScholarship, 500)
  await mkAlloc(projDeliveryx, 1000)
  await mkAlloc(projEmea, 1000)

  // ── §A OTel attribution (tagged to a project → cost_owning_unit = PROJECT unit) ─
  // tokens = cost × 2000; model uniform so the §A model-driver sum-back is derivable.
  const ar = async (
    inst: string,
    tm: string,
    region: string,
    cou: string,
    projectId: string,
    cost: number,
    tokens: number,
    day: string,
  ) => {
    await c`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${cou}::uuid, ${cou}::uuid, ${projectId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', ${tokens}, ${cost}, 'tier-1', 'estimated', ${day}::timestamptz, ${'conv-' + tm + '-' + day})`
  }
  // alice: $100 → apac.cto (scholarship) + $250 → apac.delivery (deliveryx). Both 05-05.
  await ar(aliceInst, alice, regionApac, uApacCto, projScholarship, 100, 200_000, '2026-05-05T00:00:00Z')
  await ar(aliceInst, alice, regionApac, uApacDelivery, projDeliveryx, 250, 500_000, '2026-05-05T01:00:00Z')
  // bob: $300 → apac.delivery (deliveryx). 05-06.
  await ar(bobInst, bob, regionApac, uApacDelivery, projDeliveryx, 300, 600_000, '2026-05-06T00:00:00Z')
  // carol: $200 → emea.delivery (proj-emea). 05-07.
  await ar(carolInst, carol, regionEmea, uEmeaDelivery, projEmea, 200, 400_000, '2026-05-07T00:00:00Z')

  // ── §B Anthropic bill (actual_spend) — the per-teammate bill truth ───────────
  // input=output=cost×1000 (total cost×2000). Same date as each teammate's OTel so
  // the v_finance_project_overlay (teammate,date,tool)-join lines up.
  const asp = async (tm: string, cost: number, tok: number, day: string) => {
    await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
      VALUES (${tm}::uuid, ${day}::date, 'claude-code', ${tok}, ${tok}, ${cost}, 'anthropic-analytics-api', false)`
  }
  await asp(alice, 350, 350_000, '2026-05-05')
  await asp(bob, 300, 300_000, '2026-05-06')
  await asp(carol, 200, 200_000, '2026-05-07')
  await asp(dave, 50, 50_000, '2026-05-08') // dave: bill present, NO OTel → §A gap below

  // ── §A unaccounted usage (the API − OTel gap; NULL cost_owning_unit) ──────────
  const uu = async (
    tm: string,
    region: string,
    orgUnitId: string,
    tool: string,
    cost: number,
    tokens: number,
    day: string,
  ) => {
    await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
      VALUES (${tm}::uuid, ${region}::uuid, ${orgUnitId}::uuid, ${day}::date, ${tool}, ${cost}, ${tokens}, 'api-reconciled')`
  }
  // dave's un-enrolled claude spend surfaces as the §A gap ($50, region APAC).
  await uu(dave, regionApac, uApac, 'claude-code', 50, 100_000, '2026-05-08')
  // Copilot §A per-user gross (materialised gap; region = teammate's region).
  await uu(alice, regionApac, uApacCto, 'copilot-cli', 5, 10_000, '2026-05-10')
  await uu(bob, regionApac, uApacDelivery, 'copilot-cli', 10, 20_000, '2026-05-11')

  // ── §B Copilot pooled bill (copilot_pool_bill) — homed to apac.delivery ───────
  await c`INSERT INTO provider_enterprise (provider, external_id, display_name)
    VALUES ('github', 'ko-ent', 'KO Enterprise')`
  const [{ id: entId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM provider_enterprise WHERE external_id='ko-ent'`
  await c`INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id, cost_owning_unit_id)
    VALUES ('github', 'ko-org', 'KO Org', ${entId}::uuid, ${uApacDelivery}::uuid)`
  const [{ id: orgId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM provider_org WHERE external_org_id='ko-org'`
  // May: license_net $40, overage_net $0 → pooled net chargeback $40. license present
  // + usage_gross>0 → SETTLED (not unsettled).
  await c`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-05-01'::date, ${entId}::uuid, ${orgId}::uuid, ${uApacDelivery}::uuid, 2, 40, 0, 100, 15)`

  return {
    regionApac,
    regionEmea,
    uApac,
    uApacCto,
    uApacDelivery,
    uEmea,
    uEmeaDelivery,
    alice,
    bob,
    carol,
    dave,
    projScholarship,
    projDeliveryx,
    projEmea,
  }
}
