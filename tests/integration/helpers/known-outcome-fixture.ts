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

/**
 * June 2026 half-open UTC window `[2026-06-01, 2026-07-01)` — the SECOND unhomed
 * estate `seedUnhomedCausePlantings` plants (worklist truncation, the dollar-vs-text
 * sort, a two-region secondary count, and a RETIRED cost-owning ancestor). Kept
 * out of May so every May figure stays exactly as hand-derived.
 */
export const KO_JUN_WINDOW = {
  startIso: '2026-06-01T00:00:00.000Z',
  endIso: '2026-07-01T00:00:00.000Z',
}

/**
 * March 2026 half-open UTC window `[2026-03-01, 2026-04-01)` — the THIRD estate,
 * planted by {@link seedCostCentreProjectSumBack} for the cost-centre→project
 * node pair. Kept out of May (and June) so every figure the other suites
 * hand-derive stays exactly as it was.
 *
 * Deliberately BEFORE `KO_NOW` (2026-05-15), not after. Several month-to-date
 * reads — `getMyUsage`'s contributor lane among them — bound the month from
 * BELOW only (`ts_event >= monthStart`, no upper bound), so an estate planted
 * in a LATER month leaks into "this month" on those surfaces and silently
 * changes figures this suite pins. A past month is also the truthful shape for
 * a reporting fixture: spend happened, and we are reconciling it afterwards.
 */
export const KO_MAR_WINDOW = {
  startIso: '2026-03-01T00:00:00.000Z',
  endIso: '2026-04-01T00:00:00.000Z',
}

/** Ids minted by {@link seedCostCentreProjectSumBack} (March estate only). */
export interface CostCentreSumBackIds {
  projAtlas: string
}

/**
 * The activity label on the March arm-1 (OTel) row for proj-deliveryx.
 * Exported so the assertions name the same string the seed writes.
 */
export const KO_MAR_ARM1_ACTIVITY = 'feature-dev'

/**
 * The activity label on the March arm-2 (RECONCILED) row for proj-deliveryx.
 * Deliberately a label that appears on NO attribution_record row in the whole
 * fixture: it can only reach a project's activity mix through
 * `unaccounted_usage.activity` on the §A lane (mig 0113), so an implementation
 * that reads the ledger for the mix, or a view that stops projecting the
 * column, cannot produce it.
 */
export const KO_MAR_ARM2_ACTIVITY = 'reconciled-catchup'

/** The March arm-2 UNTAGGED amount — bob's unclaimed reconciled spend. */
export const KO_MAR_MEMBER_UNTAGGED_USD = 12

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

/**
 * Plant the MARCH estate for the COST-CENTRE → PROJECT sum-back (consistency
 * contract §6.3 — the node pair the known-outcome suite did not yet pin). Must
 * be called AFTER `seedKnownOutcomeCompany` on the same TestDb.
 *
 * Kept entirely in March so every May figure the rest of that suite hand-derives
 * is untouched (see KO_MAR_WINDOW for why BEFORE May, not after). Independent of the ab-decomposition / unhomed plantings.
 *
 * WHY IT IS SHAPED LIKE THIS. The sum-back is only worth asserting if every
 * term can move independently, so each of the six rows below is a DIFFERENT
 * amount and each exercises exactly one way the two axes can disagree. The two
 * axes are genuinely different questions — a project total keys on `project_id`,
 * a cost-centre burn keys on `cost_owning_unit_id` — so the identity is
 *
 *   burn(CC) = Σ completeProjectSpend(CC's projects)
 *            + ingestOnly + untagged + foreignProject − offCentre
 *
 * FIXTURE ARITHMETIC (March 2026), cost centre **apac.delivery**:
 *
 *   $120  bob → proj-deliveryx, homed apac.delivery   arm 1. Ordinary case.
 *   $80   alice → proj-atlas,   homed apac.delivery   arm 1. A SECOND project
 *                                                     under the same CC, at a
 *                                                     different figure, so
 *                                                     "Σ over projects" cannot
 *                                                     pass while summing one.
 *   $45   bob → proj-deliveryx, arm 2 (unaccounted)   → offCentre. Arm 2 carries
 *                                                     a project tag but a NULL
 *                                                     cost_owning_unit_id BY
 *                                                     CONSTRUCTION, so this is
 *                                                     in the PROJECT total and
 *                                                     absent from the CC burn.
 *                                                     It is also the money the
 *                                                     old OTel-only lane never
 *                                                     had at all.
 *   $33   bob, claude-cowork,   homed apac.delivery   arm 3 → ingestOnly. In the
 *                                                     CC burn; can NEVER be in
 *                                                     any project figure
 *                                                     (project_id NULL by
 *                                                     construction, mig 0101).
 *   $27   carol → proj-scholarship, homed apac.delivery
 *                                                     → foreignProject. The
 *                                                     shape a project RE-HOMING
 *                                                     leaves behind: §A homes by
 *                                                     EMIT-time CoU, so old rows
 *                                                     keep the old cost centre
 *                                                     while the project now
 *                                                     leads elsewhere.
 *   $12   bob, arm 2, NO project, NULL CoU            → memberUntagged. The
 *                                                     ORDINARY shape of
 *                                                     unclaimed reconciled
 *                                                     spend: in the §A estate,
 *                                                     in no project total, in
 *                                                     no CC burn and in none of
 *                                                     the four terms. Homed only
 *                                                     by WHO spent it, so it is
 *                                                     reported outside the
 *                                                     identity and leaves every
 *                                                     figure below unchanged.
 *
 *   $18   bob, no project,      homed apac.delivery   → untagged. Schema-legal
 *                                                     (both columns are
 *                                                     independently nullable);
 *                                                     NO writer produces it
 *                                                     today, because both the
 *                                                     ingest and tag paths set
 *                                                     CoU only alongside a
 *                                                     project. Planted anyway,
 *                                                     because `untagged` and
 *                                                     `ingestOnly` differ ONLY
 *                                                     by a usage_provenance
 *                                                     clause — without a row in
 *                                                     this shape, a term that
 *                                                     swallowed the other reads
 *                                                     the same total and the
 *                                                     mutation survives.
 *
 *   burn(apac.delivery) = 120 + 80 + 33 + 27 + 18 = 278   (the $45 is NOT in it)
 *   Σ projects          = (120 + 45) + 80         = 245
 *   245 + 33 + 18 + 27 − 45                       = 278 ✓
 *   memberUntagged      = 12                              (outside BOTH sides)
 *
 * The $12 appears in neither total on purpose. It is the proof that the term
 * added to catch it did not quietly move money into or out of the identity: if
 * `memberUntagged` overlapped `untagged`, or if the arm-2 row started homing to
 * a cost centre, one of the two lines above would change.
 *
 * And the MIRROR case, cost centre **apac.cto**, so `offCentre` is exercised
 * from both directions rather than once:
 *
 *   $64   alice → proj-scholarship, homed apac.cto   arm 1.
 *   burn(apac.cto) = 64;  Σ projects = 27 + 64 = 91;  offCentre = 27
 *   91 + 0 + 0 + 0 − 27 = 64 ✓
 *
 * Three project figures, all different and all non-zero: deliveryx 165,
 * atlas 80, scholarship 91.
 *
 * ACTIVITY (mig 0113). deliveryx's two arms carry DIFFERENT activity labels —
 * {@link KO_MAR_ARM1_ACTIVITY} on the $120 OTel row, {@link KO_MAR_ARM2_ACTIVITY}
 * on the $45 reconciled one. The arm-2 label exists nowhere in
 * `attribution_record`, so a mix that reads the ledger, or a view that stops
 * carrying `uu.activity`, reports $45 as UNTAGGED instead and both the named
 * slice and the mix's sum-back to the headline break.
 */
export async function seedCostCentreProjectSumBack(
  t: TestDb,
  ids: KnownOutcomeIds,
): Promise<CostCentreSumBackIds> {
  const c = t.client
  const { alice, bob, carol, regionApac, uApacCto, uApacDelivery, projDeliveryx, projScholarship } =
    ids

  const inst = async (teammateId: string) => {
    const [r] = await c<{ id: string }[]>`
      SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`
    return r!.id
  }
  const aliceInst = await inst(alice)
  const bobInst = await inst(bob)
  const carolInst = await inst(carol)

  // A SECOND project led by apac.delivery, so the CC has more than one project
  // row to sum. No allocation: the sum-back is about burn, and an
  // always-effective allocation would move an unrelated May assertion.
  await c`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-ATLAS', 'hash-PROJ-ATLAS', 'Atlas', 'billable', ${regionApac}::uuid, ${uApacDelivery}::uuid)`
  const [{ id: projAtlas }] = await c<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='PROJ-ATLAS'`

  /** arm 1 — an OTel ledger row with an EXPLICIT (project, CoU) pair. */
  const ar = async (
    instId: string,
    tm: string,
    cou: string | null,
    projectId: string | null,
    cost: number,
    day: string,
    conv: string,
    activity: string | null = null,
  ) => {
    await c`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id, activity)
      VALUES (${instId}::uuid, ${tm}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid,
              ${cou}::uuid, ${projectId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input',
              ${cost * 2000}, ${cost}, 'tier-1', 'estimated', ${day}::timestamptz, ${conv}, ${activity})`
  }

  // KO_MAR_ARM1_ACTIVITY: the arm-1 half of the activity mix. Distinct from the
  // arm-2 label below so a mix that lost one arm cannot pass by showing the other.
  await ar(bobInst, bob, uApacDelivery, projDeliveryx, 120, '2026-03-03T09:00:00Z', 'ko-mar-deliveryx-bob', KO_MAR_ARM1_ACTIVITY)
  await ar(aliceInst, alice, uApacDelivery, projAtlas, 80, '2026-03-04T09:00:00Z', 'ko-mar-atlas-alice')
  // foreignProject: homed at apac.delivery, tagged to a project apac.cto leads.
  await ar(carolInst, carol, uApacDelivery, projScholarship, 27, '2026-03-07T09:00:00Z', 'ko-mar-foreign-carol')
  // untagged: homed here, no project claim (see the header for why it is planted).
  await ar(bobInst, bob, uApacDelivery, null, 18, '2026-03-08T09:00:00Z', 'ko-mar-untagged-bob')
  // The mirror CC's own burn.
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${aliceInst}::uuid, ${alice}::uuid, ${regionApac}::uuid, ${uApacCto}::uuid,
            ${uApacCto}::uuid, ${projScholarship}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input',
            128000, 64, 'tier-1', 'estimated', '2026-03-09T09:00:00Z'::timestamptz, 'ko-mar-scholarship-alice')`

  // arm 2 — TAGGED reconciled usage, carrying its OWN activity tag (mig 0113).
  // The view projects a NULL cost_owning_unit_id for this arm no matter what is
  // stored, which is exactly the asymmetry `offCentre` names.
  //
  // KO_MAR_ARM2_ACTIVITY appears on NO OTel row anywhere in the fixture, so a
  // project activity mix that reads only arm 1 (or a view that drops
  // `uu.activity`) cannot produce this label at all — it reports the $45 under
  // the NULL bucket instead, and both the slice and the mix's sum-back move.
  await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, project_id, activity, source)
    VALUES (${bob}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, '2026-03-05'::date,
            'claude-code', 45, 90000, ${projDeliveryx}::uuid, ${KO_MAR_ARM2_ACTIVITY}, 'api-reconciled')`

  /*
   * arm 2, UNTAGGED ($12) — the money that used to fall out of every identity.
   *
   * No project claim, and arm 2 carries no cost_owning_unit_id by construction,
   * so this row is in the §A estate and in NONE of: the project totals, the CC
   * burn, or any of the four residual terms. Every writer behaves this way
   * (attribution_record's CoU is only ever set alongside a project), so this is
   * the ORDINARY shape of unclaimed reconciled spend, not a corner case.
   *
   * It is caught by `memberUntaggedUsd`, on the only dimension it has: bob's
   * home cost centre. Deliberately a DIFFERENT amount from every other term so a
   * term that swallowed it is visible, and deliberately left OUT of the burn
   * identity so the identity's arithmetic is unchanged — which is the assertion
   * that proves the new term did not silently move an old one.
   */
  await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, project_id, source)
    VALUES (${bob}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, '2026-03-10'::date,
            'claude-code', 12, 24000, NULL, 'api-reconciled')`

  // arm 3 — ingest-only. Reaches §A through v_teammate_usage_daily, carrying its
  // OWN homing snapshot (mig 0101 part 1/3), which is why it lands on the CC.
  await c`INSERT INTO actual_spend
      (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt,
       region_id, org_unit_id, cost_owning_unit_id, dimension_source)
    VALUES (${bob}::uuid, '2026-03-06'::date, 'claude-cowork', 33000, 33000, 33,
            'anthropic-analytics-api', false,
            ${regionApac}::uuid, ${uApacDelivery}::uuid, ${uApacDelivery}::uuid, 'ingest-snapshot')`

  return { projAtlas }
}

/**
 * Plant ADDITIONAL data for the §A/§B decomposition test. Must be called AFTER
 * seedKnownOutcomeCompany on the same TestDb. Each planting feeds one named term
 * with a DISTINCT value so a swapped/mislabelled term fails the test.
 *
 * Existing tests that call only seedKnownOutcomeCompany are unaffected.
 *
 * This call moves the May §A and §B totals. The figures are deliberately NOT
 * restated here: tests/integration/usage/ab-decomposition.test.ts carries the
 * full worked arithmetic and the per-term derivation, and it is canonical.
 * An earlier version of this comment did restate them, claimed in the same
 * breath that it did not, and was stale within two rounds — which is the whole
 * argument for keeping one copy.
 */
export async function seedAbDecompositionPlantings(t: TestDb, ids: KnownOutcomeIds): Promise<void> {
  const c = t.client
  const { alice, bob, carol, regionApac, uApacCto, uApacDelivery, projScholarship, projDeliveryx } = ids

  // Fetch instance IDs for attribution_record FK
  const [{ id: aliceInst }] = await c<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${alice}::uuid LIMIT 1`
  const [{ id: bobInst }] = await c<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${bob}::uuid LIMIT 1`

  // ── nonCodeSurfaces ($200 total) ─────────────────────────────────
  // alice $120 claude-ai + bob $80 claude-cowork in actual_spend. Reach §B
  // (chargeable, non-github-firewall, teammate INNER JOIN succeeds, homing succeeds).
  // Absent from BOTH §A arms (no OTel, excluded from v_teammate_usage_daily).
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${alice}::uuid, '2026-05-05'::date, 'claude-ai', 120000, 120000, 120, 'anthropic-analytics-api', false)`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${bob}::uuid, '2026-05-06'::date, 'claude-cowork', 80000, 80000, 80, 'anthropic-analytics-api', false)`

  // ── quarantine ($75) ───────────────────────────────────────────────
  // New attribution_record ($75) with a quarantined conversation. The NOT EXISTS
  // in v_complete_usage excludes it from §A. No actual_spend counterpart (forged).
  const quarantineConvId = 'quarantined-conv-alice'
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${aliceInst}::uuid, ${alice}::uuid, ${regionApac}::uuid, ${uApacCto}::uuid, ${uApacCto}::uuid, ${projScholarship}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 150000, 75, 'tier-1', 'estimated', '2026-05-09T10:00:00Z'::timestamptz, ${quarantineConvId})`
  await c`INSERT INTO session_quarantine
      (conversation_id, instance_id, teammate_id, region_id, org_unit_id, session_ts_start, session_ts_end, instance_ts_start, cost_usd, tokens, reason)
    VALUES (${quarantineConvId}, ${aliceInst}::uuid, ${alice}::uuid, ${regionApac}::uuid, ${uApacCto}::uuid, '2026-05-09T10:00:00Z'::timestamptz, '2026-05-09T11:00:00Z'::timestamptz, '2026-05-01T00:00:00Z'::timestamptz, 75, 150000, 'api-uncorroborated')`

  // ── floor (bob 05-12: OTel $60 > API $45 → floor absorbs $15) ─────
  // floor_total = $15 (bob 05-12 only). The quarantined rows are NOT in it: the
  // floor nets against corroborated OTel, exactly as the reconciliation does.
  const bobConv0512 = `conv-${bob}-2026-05-12T00:00:00Z`
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${bobInst}::uuid, ${bob}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, ${uApacDelivery}::uuid, ${projDeliveryx}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 120000, 60, 'tier-1', 'estimated', '2026-05-12T00:00:00Z'::timestamptz, ${bobConv0512})`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${bob}::uuid, '2026-05-12'::date, 'claude-code', 45000, 45000, 45, 'anthropic-analytics-api', false)`

  // ── licenceLanes vs copilotUsageGap: make the Copilot §B lanes SEPARABLE ───────────────────────
  // The base fixture bills license_net $40 with overage_net $0 and unclassified
  // $0, which makes `copilot-license` and the usage lanes indistinguishable: a
  // licenceLanes query that wrongly swallowed the usage lanes would still return
  // $40 and the test would pass. (Verified: that exact mutation SURVIVED before
  // this planting.) Give each lane its own value so the two terms can only be
  // recovered by querying the right lanes.
  //
  //   copilot-license      $40  → licenceLanes (pure sum)
  //   copilot-usage         $8   → copilotUsageGap, measured against the §A per-user gross
  //   copilot-unclassified  $3   → EXCLUDED from §B entirely (never chargeable;
  //                               see server/reporting/finance.ts). Planted
  //                               non-zero precisely so that a §B query which
  //                               wrongly includes it moves the delta and fails.
  await c`UPDATE copilot_pool_bill
    SET overage_net_usd = 8, unclassified_net_usd = 3
    WHERE month = '2026-05-01'::date`

  // ── copilotAgentUsage: the coding-agent lane, billed but §A-INVISIBLE ────────────────
  // `copilot_coding_agent` reaches v_teammate_usage_daily (migration 0086) but is
  // absent from v_complete_usage by design, so §A cannot see it while the pooled
  // §B invoice already bills it. Planted so the term is falsifiable: without a
  // row here it is $0 and a query returning a constant zero would pass.
  //
  // A `copilot_interactive` row is planted alongside it at a DIFFERENT value, so
  // a term that forgot to filter on the coding-agent lane picks up both and the
  // arithmetic breaks. Neither row touches §A or §B: reconciliation_record feeds
  // neither v_complete_usage (which is attribution ∪ unaccounted) nor the §B
  // chargeback (which sources Copilot from copilot_pool_bill only), so these
  // move the named term and nothing else.
  const rr = async (tm: string, usd: number, day: string, category: string) =>
    c`INSERT INTO reconciliation_record
        (teammate_id, provider, enterprise_ref, period_date, category, scope, actual_usd, otel_attributed_usd, delta_usd, spend_class, disposition, status)
      VALUES (${tm}::uuid, 'github', 'ent-ab-decomp', ${day}::date, ${category}, 'teammate', ${usd}, 0, ${usd}, 'indicative', 'ingest_only', 'proposed')`
  await rr(carol, 12, '2026-05-18', 'copilot_coding_agent')
  await rr(carol, 7, '2026-05-18', 'copilot_interactive')

  // ── quarantine negative cases: the quarantine term's two filters ───────────────
  // The quarantine term must count ONLY open, api-uncorroborated quarantines.
  // Without these plantings both filters are unverified: mutations that dropped
  // `resolved_at IS NULL` and `reason = 'api-uncorroborated'` BOTH survived.
  //
  // Each case is deliberately COST-NEUTRAL on the delta: the attribution_record
  // is matched by an equal same-day actual_spend, so §A and §B each rise by the
  // same amount (delta unchanged) and the floor term sees GREATEST(0, 0) = 0.
  // The only thing that moves if a filter is dropped is the quarantine term,
  // which then breaks the residual.
  //
  //   (a) RESOLVED quarantine, right reason  → must NOT count ($50)
  //   (b) OPEN quarantine, wrong reason      → must NOT count ($30)
  const resolvedConv = 'resolved-conv-bob'
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${bobInst}::uuid, ${bob}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, ${uApacDelivery}::uuid, ${projDeliveryx}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100000, 50, 'tier-1', 'estimated', '2026-05-14T00:00:00Z'::timestamptz, ${resolvedConv})`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${bob}::uuid, '2026-05-14'::date, 'claude-code', 50000, 50000, 50, 'anthropic-analytics-api', false)`
  await c`INSERT INTO session_quarantine
      (conversation_id, instance_id, teammate_id, region_id, org_unit_id, session_ts_start, session_ts_end, instance_ts_start, cost_usd, tokens, reason, resolved_at)
    VALUES (${resolvedConv}, ${bobInst}::uuid, ${bob}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, '2026-05-14T00:00:00Z'::timestamptz, '2026-05-14T01:00:00Z'::timestamptz, '2026-05-01T00:00:00Z'::timestamptz, 50, 100000, 'api-uncorroborated', '2026-05-15T00:00:00Z'::timestamptz)`

  const otherReasonConv = 'otherreason-conv-bob'
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${bobInst}::uuid, ${bob}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, ${uApacDelivery}::uuid, ${projDeliveryx}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 60000, 30, 'tier-1', 'estimated', '2026-05-16T00:00:00Z'::timestamptz, ${otherReasonConv})`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${bob}::uuid, '2026-05-16'::date, 'claude-code', 30000, 30000, 30, 'anthropic-analytics-api', false)`
  await c`INSERT INTO session_quarantine
      (conversation_id, instance_id, teammate_id, region_id, org_unit_id, session_ts_start, session_ts_end, instance_ts_start, cost_usd, tokens, reason)
    VALUES (${otherReasonConv}, ${bobInst}::uuid, ${bob}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, '2026-05-16T00:00:00Z'::timestamptz, '2026-05-16T01:00:00Z'::timestamptz, '2026-05-01T00:00:00Z'::timestamptz, 30, 60000, 'no-covering-heartbeat')`

  // ── unhomed-§B diagnostic: plant genuinely UNHOMED §B money ────────────────────
  // Every base-fixture org unit is cost-owning, so nothing is ever unhomed and
  // `diagnostics.unhomedChargeUsd` reads $0 — indistinguishable from a broken
  // query. Plant a teammate under a NON-cost-owning root so the FILTER has
  // something to catch.
  //
  // Cost-neutral again: $17 of actual_spend (→ §B) matched by $17 of
  // unaccounted_usage (→ §A arm 2), so the delta is unchanged. What moves is the
  // diagnostic, which must now report $17 of money that would VANISH from a
  // per-cost-centre slice of §B while still being inside the §B global total.
  await c`INSERT INTO region (code, display_name) VALUES ('orphanregion', 'Orphan Region')`
  const [{ id: regionOrphan }] = await c<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='orphanregion'`
  await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionOrphan}::uuid, 'orphan'::ltree, 'orphan', 'Orphan BU (no cost-owning ancestor)', 'bu', false)`
  const [{ id: uOrphan }] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='orphan'`
  await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-erin@ko.test', 'erin@ko.test', 'erin@ko.test', ${regionOrphan}::uuid, ${uOrphan}::uuid, true)`
  const [{ id: erin }] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='erin@ko.test'`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${erin}::uuid, '2026-05-20'::date, 'claude-code', 17000, 17000, 17, 'anthropic-analytics-api', false)`
  await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${erin}::uuid, ${regionOrphan}::uuid, ${uOrphan}::uuid, '2026-05-20'::date, 'claude-code', 17, 34000, 'api-reconciled')`

  /*
   * ── A quarantined session WITH same-day API truth ($28) ───────────────────
   * The other quarantine planting (alice 05-09) is a pure forgery: no
   * actual_spend at all. That shape cannot exercise the interaction between
   * quarantine and the two terms that compare OTel against the API, because
   * with no API row there is nothing to compare against.
   *
   * This one has all three parts for one (teammate, day): $28 of quarantined
   * OTel, $28 of actual_spend, and the $28 unaccounted_usage row reconciliation
   * writes once it nets against CORROBORATED OTel (which excludes the
   * quarantined row, so the whole $28 is unaccounted).
   *
   * Cost-neutral: §A gains $28 through arm 2, §B gains $28. What it pins is that
   * both `floor` and `unreconciledApiLag` exclude quarantined rows. If either
   * one counts them, its OTel total for this day becomes $28 instead of $0, its
   * comparison against the $28 of API truth changes, and the residual breaks.
   */
  const aliceQuarantinedConv = 'quarantined-with-api-alice'
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${aliceInst}::uuid, ${alice}::uuid, ${regionApac}::uuid, ${uApacCto}::uuid, ${uApacCto}::uuid, ${projScholarship}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 56000, 28, 'tier-1', 'estimated', '2026-05-24T10:00:00Z'::timestamptz, ${aliceQuarantinedConv})`
  await c`INSERT INTO session_quarantine
      (conversation_id, instance_id, teammate_id, region_id, org_unit_id, session_ts_start, session_ts_end, instance_ts_start, cost_usd, tokens, reason)
    VALUES (${aliceQuarantinedConv}, ${aliceInst}::uuid, ${alice}::uuid, ${regionApac}::uuid, ${uApacCto}::uuid, '2026-05-24T10:00:00Z'::timestamptz, '2026-05-24T11:00:00Z'::timestamptz, '2026-05-01T00:00:00Z'::timestamptz, 28, 56000, 'api-uncorroborated')`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${alice}::uuid, '2026-05-24'::date, 'claude-code', 28000, 28000, 28, 'anthropic-analytics-api', false)`
  await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${alice}::uuid, ${regionApac}::uuid, ${uApacCto}::uuid, '2026-05-24'::date, 'claude-code', 28, 56000, 'api-reconciled')`

  /*
   * ── JUNE: a REAL §A > §B case (the healthy/negative-delta direction) ───────
   * The signed-delta test used to run against an empty June, where §A, §B, the
   * delta and every term were all $0. That assertion could not fail: deleting
   * all negative-delta handling would still have passed it. Zero is not a
   * direction.
   *
   * $40 of claude-code OTel with NO actual_spend counterpart, in a month with no
   * other activity. §A = 40 (arm 1), §B = 0, so the delta is -40 and the floor
   * term must carry all of it: the reconciliation floors max(0, API - OTel) at
   * zero, so §A keeps money §B never bills. If the floor sign is ever flipped,
   * or the term stops being computed, the residual goes to -80 or -40 and this
   * test fails, which is what the May window cannot check (there the floor is
   * one term among eight and a sign error partially hides in the total).
   */
  const bobConvJune = `conv-${bob}-2026-06-10T00:00:00Z`
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${bobInst}::uuid, ${bob}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, ${uApacDelivery}::uuid, ${projDeliveryx}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 80000, 40, 'tier-1', 'estimated', '2026-06-10T00:00:00Z'::timestamptz, ${bobConvJune})`

  /*
   * A UTC DAY-BOUNDARY pair, planted in the same quiet June month.
   *
   * $9 of OTel at 22:00Z on 06-15 with a matching $9 actual_spend row dated
   * 06-15. The two must land on the SAME day bin for the floor to net them to
   * zero, and `actual_spend.date` is a bare `date` with no timezone, so the OTel
   * side has to be binned in UTC to agree with it. A bare `ts_event::date` casts
   * in the SESSION TimeZone: on a server at UTC+14 this row bins to 06-16 and the
   * pair stops netting.
   *
   * This defect was introduced and fixed TWICE (once in `floor`, once in
   * `unreconciledApiLag`) with nothing in the suite able to catch a third
   * occurrence, because every other fixture timestamp is at 00:00Z where no
   * plausible timezone shifts the date. 22:00Z is the point.
   */
  const bobConvTz = `conv-${bob}-2026-06-15T22:00:00Z`
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${bobInst}::uuid, ${bob}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, ${uApacDelivery}::uuid, ${projDeliveryx}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 18000, 9, 'tier-1', 'estimated', '2026-06-15T22:00:00Z'::timestamptz, ${bobConvTz})`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${bob}::uuid, '2026-06-15'::date, 'claude-code', 9000, 9000, 9, 'anthropic-analytics-api', false)`

  /*
   * MONTH-BOUNDARY PAIR, on the LAST day of the June window.
   *
   * The 22:00Z row above guards DAY binning. It cannot guard the MONTH-boundary
   * casts (`${startIso}::date`), because every other June row sits mid-month
   * where a one-day slip in the window bound changes nothing. This corroborated
   * pair sits on 06-30, the last day the half-open window admits, so a bound
   * that slips one day earlier drops it and the day-grain terms move.
   *
   * Deliberately cost-neutral to the delta: OTel 7 and API 7 on the same day
   * means §A rises 7 through arm 1, §B rises 7 through actual_spend, and the
   * delta is unchanged. It moves `floor` if and only if a window bound is wrong,
   * which is exactly the signal wanted and nothing else.
   */
  const bobConvJun30 = `conv-${bob}-2026-06-30T12:00:00Z`
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${bobInst}::uuid, ${bob}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, ${uApacDelivery}::uuid, ${projDeliveryx}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 14000, 7, 'tier-1', 'estimated', '2026-06-30T12:00:00Z'::timestamptz, ${bobConvJun30})`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${bob}::uuid, '2026-06-30'::date, 'claude-code', 7000, 7000, 7, 'anthropic-analytics-api', false)`

  /*
   * unreconciledApiStale (-$11), planted SPECIFICALLY so it cannot be
   * netted against the lag term below.
   *
   * carol 05-26 has a materialised unaccounted_usage row with NO actual_spend and
   * NO OTel behind it, so the expected gap for that (teammate, day) is $0 while
   * $11 is materialised: §A carries more than the API now reports. Late telemetry
   * arriving after a day was reconciled looks exactly like this.
   *
   * The two directions now co-exist in the same window: +$23 of lag on carol
   * 05-22 and -$11 of stale here. An implementation that subtracts two
   * estate-wide aggregates reports a single +$12 and BOTH assertions fail, which
   * is the point. Before the split, one signed number could report $0 with real
   * failure in both directions underneath it.
   */
  await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${carol}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, '2026-05-26'::date, 'claude-code', 11, 22000, 'api-reconciled')`

  // ── unreconciledApiLag ($23) ─────────────────────────────────────
  // API truth with NO OTel row and NO unaccounted_usage row: the reconciliation
  // worker has not caught up, so §B bills it while §A has nothing. Unlike the
  // other plantings this one is deliberately NOT cost-neutral — it moves the
  // delta by exactly its own value, which is the point.
  //
  // Planted because the fixture originally had no such case: every synthesised
  // API row had a matching OTel or unaccounted row, so this term was structurally
  // zero and a hardcoded 0 would have passed. Real dev data had $700 of it.
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${carol}::uuid, '2026-05-22'::date, 'claude-code', 23000, 23000, 23, 'anthropic-analytics-api', false)`

  // ── copilotUsageGap: a Copilot device that emits OTel directly ──────────────────────
  // §A's copilot money can arrive through EITHER arm: arm 2 (unaccounted_usage,
  // the materialised per-user gap) or arm 1 (attribution_record, when a Copilot
  // device emits OTel itself). With only arm-2 rows planted, a copilotUsageGap
  // that read unaccounted_usage instead of v_complete_usage was indistinguishable
  // from the correct one. That bug was real and cost $1.47 of residual against
  // dev data — small enough to read as rounding.
  //
  // Not cost-neutral: §A rises by $6 with no §B counterpart, so the delta falls
  // by $6 and copilotUsageGap falls with it (11 − 21 = −$10).
  await c`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${aliceInst}::uuid, ${alice}::uuid, ${regionApac}::uuid, ${uApacCto}::uuid, ${uApacCto}::uuid, ${projScholarship}::uuid, 'copilot-cli', 'gpt-5', 'input', 12000, 6, 'tier-1', 'estimated', '2026-05-18T00:00:00Z'::timestamptz, 'copilot-otel-conv-alice')`

  // ── chargebackExemptUsage ($31) ──────────────────────────────────
  // A chargeback-exempt claude-code day, planted in the STEADY STATE the
  // reconciliation worker actually produces: the actual_spend row AND its
  // unaccounted_usage materialisation.
  //
  // v_teammate_usage_daily carries no exempt filter, so the worker materialises
  // exempt spend into unaccounted_usage and it reaches §A through arm 2. Every
  // §B lane filters `NOT chargeback_exempt`, so §B never sees it. That is a
  // one-directional leak into §A with no §B counterpart, and before this term
  // existed it landed in the residual.
  //
  // NOT cost-neutral: §A rises by $31 with nothing on the §B side, so the delta
  // falls by $31 and the term carries it.
  //
  // Latent in production today only because chargeback_exempt is written solely
  // by the Copilot/GitHub path. Workstream B §4.1 makes it the recorded
  // governance verdict for ALL providers, at which point claude-code rows carry
  // it too — i.e. the gate would have broken exactly when the thing it guards
  // shipped.
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${carol}::uuid, '2026-05-24'::date, 'claude-code', 31000, 31000, 31, 'anthropic-analytics-api', true)`
  await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${carol}::uuid, ${regionApac}::uuid, ${uApacDelivery}::uuid, '2026-05-24'::date, 'claude-code', 31, 62000, 'api-reconciled')`

  // Two exempt rows on tools that reach NEITHER side, planted purely to make the
  // term's tool predicate falsifiable. Without them the predicate is unverifiable:
  // widening it to sweep in every exempt row changes no assertion, because these
  // were the only shapes that would have moved.
  //
  //   claude-ai ($19) — non-Code surfaces are absent from §A (excluded from
  //     v_teammate_usage_daily) and their §B lane already filters exempt, so this
  //     dollar is in neither total and the term must not claim it.
  //   copilot-cli ($13) — §A comes from reconciliation_record and §B from
  //     copilot_pool_bill; an actual_spend row for this tool feeds neither.
  //
  // Both are therefore cost-neutral AND term-neutral. If chargebackExemptUsage
  // ever reads -50 or -63 instead of -31, the predicate has stopped mirroring
  // v_teammate_usage_daily's first arm and is inventing a gap.
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${alice}::uuid, '2026-05-24'::date, 'claude-ai', 19000, 19000, 19, 'anthropic-analytics-api', true)`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${bob}::uuid, '2026-05-24'::date, 'copilot-cli', 13000, 13000, 13, 'github-billing-api', true)`

  // ── populationDifference & homingLoss: population ($0, FK-enforced) + homing ($0, LEFT JOIN) ─────
}

/**
 * Plant one row of EACH unhomed cause, for the cause-split probe
 * (server/usage/unhomed-causes.ts). Must be called AFTER
 * `seedAbDecompositionPlantings` on the same TestDb.
 *
 * DELIBERATELY NOT folded into `seedAbDecompositionPlantings`: it moves the May
 * §B total and the unhomed diagnostic, both of which that suite asserts at exact
 * planted values. Each test FILE gets its own container, so the split suite
 * calls all three seeders and the decomposition suite is untouched.
 *
 * THE HOLDING NODES ARE MINTED BY THE REAL PLACEMENT WRITERS, never by a
 * hand-written INSERT carrying the sentinel literals. That is the whole point:
 * the "no region" case is NOT a NULL column — placement writes a REAL region row
 * (`__unassigned__`) and REAL per-region holding units (`__UNPLACED__`), so a
 * classifier written as `region_id IS NULL` would read $0.00 forever. Seeding
 * through `unplacedOrgUnitId()` / `unplacedOrgUnitIdForRegion()` means the test
 * proves the classifier catches what the PRODUCT actually mints, and a change to
 * either writer's sentinel breaks this test instead of silently zeroing a bucket.
 *
 * FIXTURE ARITHMETIC (May 2026) — the four causes, each a distinct amount so a
 * swapped or double-counted bucket cannot pass:
 *   no-region               $46  frank, on the SYSTEM-WIDE holding region's node.
 *                                $41 claude-code + $5 claude-ai — TWO tool rows
 *                                for ONE person, so a count that counts view rows
 *                                instead of people reads 2 and fails.
 *   region-no-unit          $34  grace, on APAC's own __UNPLACED__ holding node.
 *   no-cost-owning-ancestor $26  erin $17 (seeded above) + heidi $9, BOTH on the
 *                                orphan BU — 1 unit, 2 people, so the unit count
 *                                and the head count are independently falsifiable.
 *   pooled-copilot         $37  $29 licence on an UNHOMED provider org + $8 of
 *                                pooled overage that a persisted ALLOCATION moves
 *                                to the explicit unallocated bucket. That same
 *                                unhomed bill row ALSO carries $6 of org-homed
 *                                overage which the allocation suppresses, so
 *                                migration 0107's two mutually-exclusive arms are
 *                                both exercised: drop the probe's `NOT EXISTS`
 *                                mirror and the suppressed $6 is counted
 *                                alongside the allocation, so the bucket
 *                                over-reads and the residual breaks.
 *   TOTAL                  $143
 *
 * JUNE 2026 (`KO_JUN_WINDOW`) is a SECOND, deliberately separate estate for the
 * properties May's one-row-per-cause shape cannot express. Kept out of May so
 * every May figure above stays hand-derivable and unchanged:
 *   no-region              $2575  25 people at $91..$115. MORE THAN THE CAP (20),
 *                                 so truncation is real: 20 shown, 25 exist, and
 *                                 the shown money ($2110 = Σ$96..$115) is
 *                                 strictly less than the bucket. The range spans
 *                                 two and three digits ON PURPOSE — sorted as
 *                                 TEXT, '99.000000' beats '115.000000', so a
 *                                 dollar sort and a string sort disagree inside
 *                                 the visible page.
 *   region-no-unit           $50  5 people, TWO regions: $12/$11/$10 on APAC's
 *                                 holding node and $9/$8 on EMEA's. People (5)
 *                                 and regions (2) differ, so the secondary count
 *                                 cannot pass while counting the wrong column.
 *                                 As text, '9' and '8' sort above '12'/'11'/'10'
 *                                 — the same trap under the cap, where
 *                                 truncation cannot mask it.
 *   no-cost-owning-ancestor $235  THREE units, because the unit worklist's own
 *                                 dollar sort needs more than one row:
 *                                   $124 nina, on a unit that is not cost-owning
 *                                        but whose CHILD is — the only shape
 *                                        where the ancestry operator's DIRECTION
 *                                        is falsifiable (`<@` vs `@>`).
 *                                   $98  oscar, on a second plain orphan BU.
 *                                   $13  ivan, in a REAL unit whose only
 *                                        cost-owning ancestor is RETIRED. The one
 *                                        shape that makes the classifier's
 *                                        `retired_at IS NULL` mirror falsifiable
 *                                        from data: drop it and ivan matches no
 *                                        bucket at all, so the residual fires.
 *                                        Un-retire the ancestor and he leaves the
 *                                        unhomed set entirely.
 *                                 124/98/13 order three DIFFERENT ways — numeric
 *                                 DESC, as text, numeric ASC — so no two mutants
 *                                 of that sort produce the same page.
 *   pooled-copilot           $0  no pooled bill in June, and — planted so the
 *                                 pooled arm's own filter is falsifiable — a
 *                                 HOMED $21 overage allocation that must stay out
 *                                 of it.
 *   TOTAL                  $2860
 *   plus MONEY THAT MUST NOT BE UNHOMED: $16 of bob's normally-homed June spend,
 *   pia's $77 on a holding node that hangs UNDER a cost-owning unit (homed, so no
 *   bucket may claim it), and the $21 homed allocation above.
 *
 * Also permanent, for the placement counters:
 *   - a REVOKED cou_owner on a live cost-owning unit, and an ACTIVE cou_owner on
 *     the RETIRED cost-owning unit above. Both must be invisible to the "active
 *     owners" counter, which reads 0 — a 0 that is now a measurement rather than
 *     an empty table.
 *
 * Plus, for the month history's three states:
 *   - a chargeback-EXEMPT January row, so the estate has data from 2026-01 while
 *     January itself bills nothing: 2026-01/02/04 read "no chargeable spend" and
 *     2025-12 reads "not measured". Without it every earlier month is
 *     "not measured" and the two states are indistinguishable.
 *   - MARCH 2026: frank's $60 unhomed against bob's −$60 homed CREDIT, so the
 *     month nets to exactly $0.00 chargeable while $60 of unhomed money sits
 *     inside it. A "no chargeable spend, so nothing to home" trend row would hide
 *     the very money the panel exists to show. It is also the ONLY money in the
 *     history that is not in an anchor month, so it pins the trend's window.
 *   - a CLOSED 2026-04 finance period, so the history proves both readings —
 *     closed where a row says so, open (never an em-dash) where none exists.
 */
export async function seedUnhomedCausePlantings(t: TestDb, ids: KnownOutcomeIds): Promise<void> {
  const c = t.client
  const { alice, bob, carol, dave, regionApac, regionEmea } = ids

  // The REAL writers — see the header. Imported lazily so the other seeders stay
  // dependency-free for suites that do not need placement.
  const { makePlacementStore } = await import('../../../server/reconciliation/placement-store')
  const { unplacedOrgUnitIdForRegion } = await import('../../../server/auth/placement-home')
  const store = makePlacementStore(t.db)

  // ── no-region ($46): the system-wide holding region + its holding node ──────
  const globalUnplaced = await store.unplacedOrgUnitId()
  await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-frank@ko.test', 'frank@ko.test', 'Frank Unplaced',
            (SELECT region_id FROM org_unit WHERE id = ${globalUnplaced}::uuid),
            ${globalUnplaced}::uuid, true)`
  const [{ id: frank }] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='frank@ko.test'`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${frank}::uuid, '2026-05-21'::date, 'claude-code', 41000, 41000, 41, 'anthropic-analytics-api', false)`
  // SECOND tool, SAME person, SAME month — a row count reads 2 here; a head count reads 1.
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${frank}::uuid, '2026-05-21'::date, 'claude-ai', 5000, 5000, 5, 'anthropic-analytics-api', false)`

  // ── region-no-unit ($34): APAC's OWN holding node — region known, unit not ──
  const apacUnplaced = await unplacedOrgUnitIdForRegion(t.db, regionApac)
  await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-grace@ko.test', 'grace@ko.test', 'Grace Unplaced', ${regionApac}::uuid, ${apacUnplaced}::uuid, true)`
  const [{ id: grace }] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='grace@ko.test'`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${grace}::uuid, '2026-05-21'::date, 'claude-code', 34000, 34000, 34, 'anthropic-analytics-api', false)`

  // ── no-cost-owning-ancestor (+$9 → $26): a SECOND person on erin's orphan BU ─
  const [{ id: uOrphan }] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='orphan'`
  const [{ id: regionOrphan }] = await c<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='orphanregion'`
  await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-heidi@ko.test', 'heidi@ko.test', 'Heidi Orphan', ${regionOrphan}::uuid, ${uOrphan}::uuid, true)`
  const [{ id: heidi }] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='heidi@ko.test'`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${heidi}::uuid, '2026-05-21'::date, 'claude-code', 9000, 9000, 9, 'anthropic-analytics-api', false)`

  // ── pooled-copilot ($37) ───────────────────────────────────────────────────
  // $29 of licence on an org with NO cost-owning unit (the org is not homed)…
  const [{ id: entId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM provider_enterprise WHERE external_id='ko-ent'`
  await c`INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id, cost_owning_unit_id)
    VALUES ('github', 'ko-org-unhomed', 'KO Org (unhomed)', ${entId}::uuid, NULL)`
  const [{ id: unhomedOrgId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM provider_org WHERE external_org_id='ko-org-unhomed'`
  // The $6 of org-homed overage on this row is NOT in the $37: the allocation
  // below suppresses it (mig 0107's two arms are mutually exclusive). It exists
  // ONLY so that suppression is falsifiable — with `overage_net_usd = 0` here,
  // dropping the probe's `NOT EXISTS` mirror changes no number and the mutation
  // survives, which is exactly what happened the first time this was measured.
  await c`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-05-01'::date, ${entId}::uuid, ${unhomedOrgId}::uuid, NULL, 1, 29, 6, 0, 0)`
  // …and $8 of pooled overage that a PERSISTED ALLOCATION puts in the explicit
  // unallocated bucket (mig 0107). Its (enterprise, month) now has an allocation,
  // so the view's org-homed overage fallback is suppressed for EVERY bill row of
  // that pair — the probe must suppress it too or it counts the same $8 twice.
  await c`INSERT INTO copilot_overage_allocation (provider_enterprise_id, month, cost_owning_unit_id, policy, weight, allocated_usd, overage_net_usd)
    VALUES (${entId}::uuid, '2026-05-01'::date, NULL, 'consumption-share', 0, 8, 8)`

  /*
   * ── JUNE: no-region ($2575) — MORE PEOPLE THAN THE WORKLIST CAP ────────────
   * $91..$115, 25 of them. Two properties in one planting:
   *   TRUNCATION is real — 20 shown of 25, and Σ(shown) = $2110 < $2575, so
   *     "the shown money IS the bucket" cannot be asserted vacuously.
   *   THE SORT IS A DOLLAR SORT — the range crosses the 99/100 boundary, so as
   *     numeric(14,6) TEXT ('99.000000' > '115.000000') a string sort puts $99
   *     at the top of the page and drops $115 out of the visible 20 entirely.
   */
  await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    SELECT 'oid-jun-nr-' || g, 'jun-nr-' || g || '@ko.test', 'June Unplaced ' || g,
           (SELECT region_id FROM org_unit WHERE id = ${globalUnplaced}::uuid),
           ${globalUnplaced}::uuid, true
    FROM generate_series(1, 25) g`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    SELECT t.id, '2026-06-11'::date, 'claude-code', 1000, 1000, 90 + g, 'anthropic-analytics-api', false
    FROM generate_series(1, 25) g
    JOIN teammate t ON t.email = 'jun-nr-' || g || '@ko.test'`

  /*
   * ── JUNE: region-no-unit ($50) — TWO regions, FIVE people ─────────────────
   * People and regions differ (5 vs 2), so the secondary count cannot pass while
   * counting the wrong column. Under the cap, so the same text-vs-dollar sort
   * trap ('9' and '8' above '12'/'11'/'10') is visible without truncation.
   */
  const emeaUnplaced = await unplacedOrgUnitIdForRegion(t.db, regionEmea)
  const junHolding: [string, string, number][] = [
    ['jun-apac-a', apacUnplaced, 12],
    ['jun-apac-b', apacUnplaced, 11],
    ['jun-apac-c', apacUnplaced, 10],
    ['jun-emea-a', emeaUnplaced, 9],
    ['jun-emea-b', emeaUnplaced, 8],
  ]
  for (const [slug, unitId, usd] of junHolding) {
    await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES (${`oid-${slug}@ko.test`}, ${`${slug}@ko.test`}, ${`June Holding ${slug}`},
              (SELECT region_id FROM org_unit WHERE id = ${unitId}::uuid), ${unitId}::uuid, true)`
    await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
      SELECT id, '2026-06-11'::date, 'claude-code', 1000, 1000, ${usd}, 'anthropic-analytics-api', false
      FROM teammate WHERE email = ${`${slug}@ko.test`}`
  }

  /*
   * ── JUNE: no-cost-owning-ancestor ($13) — a RETIRED cost-owning ancestor ───
   * The one shape that makes the classifier's `retired_at IS NULL` falsifiable
   * from data. `v_finance_bill_chargeback`'s LATERAL requires an ancestor that
   * is cost-owning AND not retired, so ivan is unhomed; the probe's mirror of
   * that rule must agree, or ivan matches no bucket and the residual fires.
   */
  await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit, retired_at)
    VALUES (${regionOrphan}::uuid, 'retired'::ltree, 'retired-root', 'Retired Cost Centre', 'bu', true, now())`
  const [{ id: uRetiredRoot }] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='retired-root'`
  await c`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionOrphan}::uuid, ${uRetiredRoot}::uuid, 'retired.child'::ltree, 'retired-child',
            'Team under a retired cost centre', 'bu', false)`
  const [{ id: uRetiredChild }] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='retired-child'`
  await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-ivan@ko.test', 'ivan@ko.test', 'Ivan Retired-Ancestor', ${regionOrphan}::uuid, ${uRetiredChild}::uuid, true)`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    SELECT id, '2026-06-11'::date, 'claude-code', 1000, 1000, 13, 'anthropic-analytics-api', false
    FROM teammate WHERE email = 'ivan@ko.test'`

  /*
   * ── JUNE: no-cost-owning-ancestor, row 2 ($124) — ANCESTRY DIRECTION ───────
   * A unit that is NOT cost-owning but whose CHILD is. `ou.path <@ anc.path`
   * asks "is the home node a DESCENDANT of a cost-owning unit"; `@>` asks the
   * opposite, and on every other planting the two agree (a root has no
   * descendants, a leaf has no cost-owning ancestor), so the direction was
   * unfalsifiable. Here they disagree: nina IS unhomed (nothing above her is
   * cost-owning) and the flipped operator finds the cost-owning CHILD, so her
   * $124 matches no bucket and the residual fires.
   */
  await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionOrphan}::uuid, 'inverted'::ltree, 'inverted-parent',
            'Team ABOVE its own cost centre', 'bu', false)`
  const [{ id: uInvertedParent }] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='inverted-parent'`
  await c`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionOrphan}::uuid, ${uInvertedParent}::uuid, 'inverted.child'::ltree, 'inverted-child',
            'Cost centre BELOW the team', 'bu', true)`
  await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-nina@ko.test', 'nina@ko.test', 'Nina Above-Her-Cost-Centre',
            ${regionOrphan}::uuid, ${uInvertedParent}::uuid, true)`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    SELECT id, '2026-06-11'::date, 'claude-code', 1000, 1000, 124, 'anthropic-analytics-api', false
    FROM teammate WHERE email = 'nina@ko.test'`

  /*
   * ── JUNE: no-cost-owning-ancestor, row 3 ($98) — THE ORG-UNIT DOLLAR SORT ──
   * The unit worklist had ONE row in both months, so its `ORDER BY ua.usd DESC`
   * was unverifiable — the exact defect the teammate lists were pinned against
   * was invisible here. $124 / $98 / $13 order differently three ways: numeric
   * DESC [124, 98, 13], as TEXT [98, 13, 124], numeric ASC [13, 98, 124]. No two
   * of those coincide, so the text-bound and the reversed mutants both die.
   */
  await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionOrphan}::uuid, 'orphanb'::ltree, 'orphan-b', 'Second Orphan BU', 'bu', false)`
  const [{ id: uOrphanB }] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='orphan-b'`
  await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-oscar@ko.test', 'oscar@ko.test', 'Oscar Orphan-B',
            ${regionOrphan}::uuid, ${uOrphanB}::uuid, true)`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    SELECT id, '2026-06-11'::date, 'claude-code', 1000, 1000, 98, 'anthropic-analytics-api', false
    FROM teammate WHERE email = 'oscar@ko.test'`

  /*
   * ── JUNE: HOMED money on a HOLDING node ($77) — the unhomed-only filter ────
   * A second holding node, under APAC's COST-OWNING root, so pia is parked on a
   * holding node AND her money homes to `apac`. She is therefore NOT unhomed and
   * must never appear in a bucket. Drop `b.cost_owning_unit_id IS NULL` from the
   * teammate arm and `region-no-unit` claims her $77 — money that already
   * reached a cost centre — while the authoritative total does not, so the
   * residual fires. (Every OTHER homed teammate falls out of the CASE as NULL,
   * which is why that mutation survived: nothing homed sat on a holding node.)
   *
   * The node carries its OWN code rather than the sentinel — it has to, since
   * APAC already owns a `__UNPLACED__` node. That is why the mutation lands in
   * `region-no-unit` at all: the classifier keys on `unit_type`, never on the
   * code, exactly so a second holding node is still recognised as one.
   */
  await c`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionApac}::uuid, (SELECT id FROM org_unit WHERE code='apac'),
            'apac.holding_team'::ltree, 'apac-holding-team',
            'APAC Unplaced (under a cost centre)', 'holding', false)`
  await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-pia@ko.test', 'pia@ko.test', 'Pia Homed-But-Unplaced', ${regionApac}::uuid,
            (SELECT id FROM org_unit WHERE code='apac-holding-team'), true)`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    SELECT id, '2026-06-11'::date, 'claude-code', 1000, 1000, 77, 'anthropic-analytics-api', false
    FROM teammate WHERE email = 'pia@ko.test'`

  /*
   * ── JUNE: a HOMED overage allocation ($21) — the pooled arm's own filter ───
   * The May allocation is the UNALLOCATED bucket (NULL cost-owning unit); the
   * arm's `coa.cost_owning_unit_id IS NULL` was therefore true for every row it
   * could see, so dropping it changed nothing. This row is the other kind: paid
   * pooled overage that DID reach a cost-owning unit. It is chargeable and
   * homed, so the pooled bucket must stay $0.00 in June — drop the filter and it
   * reads $21 against a total that never counted it, and the residual fires.
   */
  await c`INSERT INTO copilot_overage_allocation (provider_enterprise_id, month, cost_owning_unit_id, policy, weight, allocated_usd, overage_net_usd)
    VALUES (${entId}::uuid, '2026-06-01'::date, (SELECT id FROM org_unit WHERE code='apac-delivery'),
            'consumption-share', 1, 21, 21)`

  /*
   * ── MARCH: a CREDIT-NETTED month that still holds unhomed money ────────────
   * Chargeable spend is a SIGNED sum. Frank's $60 is unhomed; bob's −$60 credit
   * is homed, so March nets to exactly $0.00 chargeable with $60 unhomed inside
   * it. Gated on chargeable alone, the trend rendered "No chargeable spend in
   * this month" directly beneath a headline showing that money.
   *
   * It is also the only money in the history that is NOT in the anchor month, so
   * it pins the trend's window: recompute the series over the probe's own window
   * instead of the six-month one and this row goes empty.
   */
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${frank}::uuid, '2026-03-10'::date, 'claude-code', 1000, 1000, 60, 'anthropic-analytics-api', false)`
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${bob}::uuid, '2026-03-10'::date, 'claude-code', 1000, 1000, -60, 'anthropic-analytics-api', false)`

  /*
   * ── Owners that must NOT count as active ──────────────────────────────────
   * A REVOKED owner on a live cost-owning unit, and a LIVE owner on the retired
   * cost-owning unit above. Both are invisible to the counters, which read 0
   * active owners — a 0 that is now a measurement over rows that exist, not the
   * reading of an empty table. Drop either filter and the counter reads 1.
   */
  await c`INSERT INTO cou_owner (org_unit_id, teammate_id, revoked_at)
    VALUES ((SELECT id FROM org_unit WHERE code='apac-cto'), ${bob}::uuid, now())`
  await c`INSERT INTO cou_owner (org_unit_id, teammate_id)
    VALUES (${uRetiredRoot}::uuid, ${carol}::uuid)`

  // ── history states: data from January, but January bills nothing ────────────
  // Chargeback-exempt, so it is in the estate (the "first month we measured")
  // while every §B lane filters it out — which is what makes 2026-01..04 read
  // "no chargeable spend" and 2025-12 read "not measured".
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${dave}::uuid, '2026-01-15'::date, 'claude-code', 12000, 12000, 12, 'anthropic-analytics-api', true)`

  // ── a CLOSED month, so both period readings are exercised ───────────────────
  await c`INSERT INTO finance_period (period_month, state, closed_at, closed_by)
    VALUES ('2026-04-01'::date, 'closed', now(), ${alice}::uuid)`
}
