// @vitest-environment node
/*
 * Migrations 0114/0115 — v_org_unit_cost_owner, and v_finance_bill_chargeback
 * reading it.
 *
 * The same "nearest live cost-owning ancestor" resolution was copied into five
 * places as a correlated LATERAL that fired once per USAGE ROW to answer a
 * question about a 132-row table. 0114 makes it one view; 0115 moves the §B
 * billing view onto it.
 *
 * The §B move is the one with blast radius: v_finance_bill_chargeback feeds
 * every chargeback figure in the product, so a homing change here silently
 * moves money between cost centres. These tests therefore assert EQUIVALENCE
 * against the pre-0114 LATERAL, evaluated in-place, rather than asserting the
 * new view agrees with itself.
 *
 * The tree is adversarial by construction: a reflexively cost-owning unit, a
 * NESTED cost-owning unit (the nearer one must win), a RETIRED cost-owning unit
 * (descendants must fall up to the next live ancestor, not strand), and a
 * branch with no cost-owning ancestor at all (whose spend must stay visible as
 * unallocated rather than leave the bill).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

let t: TestDb
let regionId = ''
let otherRegionId = ''
const unit: Record<string, string> = {}
const mate: Record<string, string> = {}

/*
 * The resolution EXACTLY as it read at all five sites before 0114. Every
 * equivalence assertion below compares against this, so if the view's rule ever
 * drifts from the shipped one the test fails rather than re-blessing it.
 */
const LEGACY_LATERAL = `
  SELECT home.id AS org_unit_id, cc.id AS cost_owning_unit_id, cc.region_id
  FROM org_unit home
  LEFT JOIN LATERAL (
    SELECT anc.id, anc.region_id
    FROM org_unit h2 JOIN org_unit anc ON h2.path <@ anc.path
    WHERE h2.id = home.id AND anc.is_cost_owning_unit = TRUE AND anc.retired_at IS NULL
    ORDER BY nlevel(anc.path) DESC LIMIT 1
  ) cc ON TRUE`

beforeAll(async () => {
  t = await startTestDb()

  await t.client`INSERT INTO region (code, display_name) VALUES ('co', 'Cost-Owner Region')`
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='co'`

  const mkUnit = async (path: string, code: string, owning: boolean, retired: boolean, region = regionId) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit, retired_at)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${'U ' + code}, 'practice', ${owning},
              ${retired ? '2026-01-01T00:00:00Z' : null})`
    const [row] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code=${code}`
    unit[code] = row!.id
  }

  /*
   * A SECOND region, holding the nested cost-owning unit. This is the only way
   * to observe "whose region does the bill carry": a trigger
   * (teammate_region_consistency) rewrites teammate.region_id to match their
   * org_unit on insert, so a teammate can never disagree with their own unit.
   * The ANCESTOR can, and 0085 deliberately selected the ancestor's region.
   */
  await t.client`INSERT INTO region (code, display_name) VALUES ('co2', 'Other Region')`
  ;[{ id: otherRegionId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='co2'`

  await mkUnit('co', 'co-root', false, false)
  await mkUnit('co.cto', 'co-cto', true, false) // cost-owning
  await mkUnit('co.cto.eng', 'co-eng', false, false) // → co-cto
  // Nested cost-owning unit, deliberately in the OTHER region.
  await mkUnit('co.cto.eng.data', 'co-data', true, false, otherRegionId)
  await mkUnit('co.cto.eng.data.ml', 'co-ml', false, false) // → co-data (NEAREST wins)
  await mkUnit('co.cto.ops', 'co-ops', true, true) // RETIRED cost-owning
  await mkUnit('co.cto.ops.sre', 'co-sre', false, false) // → co-cto (skips retired)
  await mkUnit('co.orphan', 'co-orphan', false, false) // → NULL (no owner)

  /*
   * A SAME-DEPTH tie. Nothing constrains org_unit.path to be globally unique
   * (the only uniqueness is (region_id, code)), so two live cost-owning units
   * can sit at equal nlevel above one home. Without a total ORDER BY, both
   * DISTINCT ON and the LIMIT 1 it replaced pick an arbitrary winner that can
   * differ between plans — for a view that decides which cost centre is BILLED,
   * that is a number changing under a plan change. `anc.id` is the tiebreak.
   */
  await mkUnit('co.tie', 'co-tie-a', true, false)
  await mkUnit('co.tie', 'co-tie-b', true, false)
  await mkUnit('co.tie.leaf', 'co-tie-leaf', false, false)

  const mkMate = async (code: string, unitCode: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
      VALUES (${'oid-' + code}, ${code + '@x.test'}, ${code}, ${regionId}::uuid, ${unit[unitCode]}::uuid)`
    const [row] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${code + '@x.test'}`
    mate[code] = row!.id
  }
  await mkMate('m-ml', 'co-ml') // homes to co-data
  await mkMate('m-sre', 'co-sre') // homes to co-cto (retired skipped)
  await mkMate('m-orphan', 'co-orphan') // homes to NULL — unallocated

  // Chargeable §B spend for each, at distinct amounts so a mis-home is a wrong
  // NUMBER rather than merely a wrong shape.
  const spend = async (code: string, usd: number) => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, cost_usd, input_tokens, output_tokens, chargeback_exempt)
      VALUES (${mate[code]}::uuid, DATE '2026-06-15', 'claude-code', ${usd}, 100, 50, false)`
  }
  await spend('m-ml', 11.11)
  await spend('m-sre', 22.22)
  await spend('m-orphan', 33.33)
})

afterAll(async () => {
  await stopTestDb(t)
})

describe('v_org_unit_cost_owner — the resolution', () => {
  it('resolves each unit to its nearest LIVE cost-owning ancestor', async () => {
    const rows = await t.client<{ code: string; owner: string | null }[]>`
      SELECT h.code AS code, c.cost_owning_unit_code AS owner
      FROM org_unit h JOIN v_org_unit_cost_owner c ON c.org_unit_id = h.id
      WHERE h.code LIKE 'co-%' ORDER BY h.code`
    const map = Object.fromEntries(rows.map((r) => [r.code, r.owner]))
    expect(map['co-cto']).toBe('co-cto') // reflexive: a cost-owning unit owns itself
    expect(map['co-eng']).toBe('co-cto')
    expect(map['co-data']).toBe('co-data')
    expect(map['co-ml']).toBe('co-data') // NEAREST, not the co-cto grandparent
    expect(map['co-sre']).toBe('co-cto') // retired co-ops is skipped
    expect(map['co-ops']).toBe('co-cto') // a retired unit does not own itself
    expect(map['co-orphan']).toBeNull() // no owner — the row still exists
    expect(map['co-root']).toBeNull()
  })

  it('breaks a same-depth tie deterministically, by the lowest ancestor id', async () => {
    const [row] = await t.client<{ owner: string | null }[]>`
      SELECT c.cost_owning_unit_id::text AS owner
      FROM org_unit h JOIN v_org_unit_cost_owner c ON c.org_unit_id = h.id
      WHERE h.code = 'co-tie-leaf'`
    const [expected] = await t.client<{ id: string }[]>`
      SELECT MIN(id::text) AS id FROM org_unit WHERE code IN ('co-tie-a', 'co-tie-b')`
    expect(row!.owner).toBe(expected!.id)
  })

  it('carries the tiebreak in the view definition itself', async () => {
    /*
     * Determinism cannot be established by running the query and comparing
     * results: an ARBITRARY choice is free to be a stable one, so a repetition
     * test passes with the tiebreak removed and proves nothing. (Confirmed —
     * deleting `anc.id` from the ORDER BY left the behavioural assertions
     * green.) What is decidable is whether the total order is actually there,
     * so this asserts on the installed definition.
     */
    const [row] = await t.client<{ def: string }[]>`
      SELECT pg_get_viewdef('v_org_unit_cost_owner'::regclass, true) AS def`
    const orderBy = row!.def.slice(row!.def.toUpperCase().lastIndexOf('ORDER BY'))
    // Postgres re-renders the expression with its own parens:
    // `ORDER BY home.id, (nlevel(anc.path)) DESC, anc.id`.
    expect(orderBy).toMatch(/nlevel\(anc\.path\)\)? DESC/)
    // A third key after the depth sort — without it DISTINCT ON picks freely
    // among equal-depth owners, and which cost centre gets BILLED can change
    // with the plan.
    expect(orderBy).toMatch(/DESC,\s*anc\.id/)
  })

  it('pins the §B view to the shared map, so the LATERAL cannot creep back', async () => {
    /*
     * Every other assertion here is SEMANTIC, and the new view is semantically
     * equivalent by design — so restoring the correlated LATERAL in
     * v_finance_bill_chargeback would leave them all green while reinstating
     * the per-row scan the migration exists to remove.
     */
    const [row] = await t.client<{ def: string }[]>`
      SELECT pg_get_viewdef('v_finance_bill_chargeback'::regclass, true) AS def`
    expect(row!.def).toContain('v_org_unit_cost_owner')
    expect(row!.def.toUpperCase()).not.toContain('LATERAL')
  })

  it('emits exactly one row per org_unit, so a join can never fan out spend', async () => {
    const [row] = await t.client<{ units: string; mapped: string; distinct: string }[]>`
      SELECT (SELECT count(*) FROM org_unit)::text AS units,
             (SELECT count(*) FROM v_org_unit_cost_owner)::text AS mapped,
             (SELECT count(DISTINCT org_unit_id) FROM v_org_unit_cost_owner)::text AS distinct`
    expect(row!.mapped).toBe(row!.units)
    expect(row!.distinct).toBe(row!.units)
  })

  it('is byte-identical to the correlated LATERAL wherever that had defined behaviour', async () => {
    /*
     * Equivalence is asserted over the units with an UNAMBIGUOUS answer, which
     * is the whole domain the old form defined. On a same-depth tie the old
     * `ORDER BY nlevel DESC LIMIT 1` had no tiebreak and returned an arbitrary
     * winner that could change between plans; the new view breaks the tie on
     * anc.id. The two may therefore differ there, deliberately — that is the
     * defect being fixed, not a regression, and pretending otherwise would mean
     * asserting equivalence to nondeterminism.
     */
    const [diff] = await t.client<{ only_old: string; only_new: string }[]>`
      WITH ambiguous AS (
        SELECT home.id
        FROM org_unit home
        JOIN org_unit anc
          ON home.path <@ anc.path AND anc.is_cost_owning_unit AND anc.retired_at IS NULL
        GROUP BY home.id
        HAVING count(*) FILTER (
          WHERE nlevel(anc.path) = (
            SELECT max(nlevel(a2.path)) FROM org_unit a2
            WHERE home.path <@ a2.path AND a2.is_cost_owning_unit AND a2.retired_at IS NULL)
        ) > 1
      ),
      legacy AS (${t.client.unsafe(LEGACY_LATERAL)}),
      current AS (SELECT org_unit_id, cost_owning_unit_id, cost_owning_unit_region_id AS region_id
                    FROM v_org_unit_cost_owner)
      SELECT (SELECT count(*) FROM (
                SELECT * FROM legacy WHERE org_unit_id NOT IN (SELECT id FROM ambiguous)
                EXCEPT SELECT * FROM current) a)::text AS only_old,
             (SELECT count(*) FROM (
                SELECT * FROM current WHERE org_unit_id NOT IN (SELECT id FROM ambiguous)
                EXCEPT SELECT * FROM legacy) b)::text AS only_new`
    expect(diff!.only_old).toBe('0')
    expect(diff!.only_new).toBe('0')
  })

  it('the equivalence check is not vacuous — the tree really does contain ties', async () => {
    // Guards the test above: if the ambiguous-unit CTE ever matched everything,
    // the EXCEPT comparison would be over an empty set and prove nothing.
    const [row] = await t.client<{ ties: string; total: string }[]>`
      SELECT (SELECT count(*)::text FROM org_unit WHERE code IN ('co-tie-a','co-tie-b')) AS ties,
             (SELECT count(*)::text FROM org_unit) AS total`
    expect(Number(row!.ties)).toBe(2)
    expect(Number(row!.total)).toBeGreaterThan(5)
  })
})

describe('v_finance_bill_chargeback — §B homing is unchanged', () => {
  it('bills each teammate to the same cost centre the LATERAL chose', async () => {
    const rows = await t.client<{ owner: string | null; bill: string }[]>`
      SELECT o.code AS owner, SUM(b.bill_usd)::text AS bill
      FROM v_finance_bill_chargeback b
      LEFT JOIN org_unit o ON o.id = b.cost_owning_unit_id
      WHERE b.teammate_id IN (${mate['m-ml']}::uuid, ${mate['m-sre']}::uuid, ${mate['m-orphan']}::uuid)
      GROUP BY o.code ORDER BY o.code NULLS LAST`
    const map = Object.fromEntries(rows.map((r) => [r.owner ?? '__unallocated', Number(r.bill)]))
    expect(map['co-data']).toBeCloseTo(11.11, 2) // nested owner wins
    expect(map['co-cto']).toBeCloseTo(22.22, 2) // retired owner skipped
    expect(map['__unallocated']).toBeCloseTo(33.33, 2) // NOT dropped from the bill
  })

  it('conserves the total: Σ chargeback == Σ chargeable actual_spend', async () => {
    /*
     * The invariant that catches a homing change. An INNER join to the cost-owner
     * map, or any predicate that discards a NULL owner, silently removes the
     * orphan's $33.33 from the bill while every per-centre figure still looks
     * plausible.
     */
    const [row] = await t.client<{ billed: string; source: string }[]>`
      SELECT (SELECT COALESCE(SUM(bill_usd), 0) FROM v_finance_bill_chargeback
               WHERE teammate_id IN (${mate['m-ml']}::uuid, ${mate['m-sre']}::uuid, ${mate['m-orphan']}::uuid))::text AS billed,
             (SELECT COALESCE(SUM(cost_usd), 0) FROM actual_spend
               WHERE teammate_id IN (${mate['m-ml']}::uuid, ${mate['m-sre']}::uuid, ${mate['m-orphan']}::uuid)
                 AND NOT chargeback_exempt)::text AS source`
    expect(Number(row!.billed)).toBeCloseTo(Number(row!.source), 2)
    expect(Number(row!.billed)).toBeCloseTo(66.66, 2)
  })

  it('still carries the COST-OWNING unit region, not the teammate own region', async () => {
    /*
     * m-ml sits in co-ml (region co) but its nearest cost-owning ancestor
     * co-data is in region co2, and the trigger pins the teammate's own region
     * to co. So "the teammate's region" and "the cost centre's region" give
     * different answers here, and 0085 chose the latter deliberately: a §B bill
     * is charged to the cost centre's region, not to wherever the person is filed.
     */
    const [mine] = await t.client<{ r: string }[]>`
      SELECT region_id::text AS r FROM teammate WHERE id = ${mate['m-ml']}::uuid`
    expect(otherRegionId).not.toBe(regionId)
    expect(mine!.r).toBe(regionId) // the teammate's own region
    const rows = await t.client<{ region_id: string | null }[]>`
      SELECT b.region_id::text AS region_id FROM v_finance_bill_chargeback b
      WHERE b.teammate_id = ${mate['m-ml']}::uuid`
    expect(rows[0]!.region_id).toBe(otherRegionId) // the COST CENTRE's region
    expect(rows[0]!.region_id).not.toBe(mine!.r)
  })

  it('keeps the §A Copilot lanes out of the §B view', async () => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, cost_usd, input_tokens, output_tokens, chargeback_exempt)
      VALUES (${mate['m-ml']}::uuid, DATE '2026-06-16', 'copilot-cli', 99, 1, 1, false)`
    const rows = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM v_finance_bill_chargeback
      WHERE tool IN ('copilot', 'copilot-agent', 'copilot-license', 'copilot-usage', 'copilot-unclassified', 'copilot-cli')`
    expect(rows[0]!.n).toBe('0')
  })
})
