// @vitest-environment node
/*
 * F5 — the cost-centre owner's page, against a real database.
 *
 * Three claims on this slice are SQL claims, and a component fixture can only
 * assert that a renderer draws whatever it is handed. These prove the figures:
 *
 *   D30 · the "Not on a project" row. Money homed to this centre with no
 *         project claim on it cannot arrive through a `p`-aliased clamp — a
 *         NULL `project_id` has no project row to clamp — so the axis grew a
 *         second, disjoint arm. Proved by seeding such money and finding it.
 *
 *   D25 · both operands. The axis row's own total is the PROJECT's, across
 *         every centre whose people worked on it; the second operand is the
 *         part THIS centre carries. The fixture makes them DIFFERENT numbers
 *         (a second cost centre spends on the same project), because a fixture
 *         where they coincide cannot tell a correct implementation from one
 *         that reports the row total twice.
 *
 *   F5  · the model-tier measure. The banding is `model_catalog`'s, matched by
 *         SUBSTRING with a `sort_order` tie-break — so a model matching TWO
 *         patterns must resolve to ONE, and a model the catalogue does not know
 *         must land in `unclassified` rather than the cheapest band. Both are
 *         asserted against the SEEDED catalogue, not a hand-built one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup } from '../helpers/usage-rollup'
import {
  fetchCostCentreBurnDrill,
  fetchCostCentreHeroes,
  fetchCostCentreProjectShare,
  fetchCostCentreTeammateTierMix,
  fetchVisibleCostCentres,
  NO_PROJECT_ROW_KEY,
  NO_PROJECT_ROW_LABEL,
} from '../../../server/reporting/cost-centres'
// Asserted through the CONSTANT: these check WHICH DENOMINATOR the payload
// names, not the noun it is currently spelled with.
import { BU_LABEL_LOWER } from '../../../shared/reports/vocabulary'

let t: TestDb
let regionId = ''
/** The centre under test. */
let ccId = ''
/** A SECOND centre, whose people also spend on OUR project — the D25 wedge. */
let otherCcId = ''
let ownProjectId = ''

const WINDOW = { startIso: '2026-07-01T00:00:00.000Z', endIso: '2026-08-01T00:00:00.000Z' }

/*
 * The money, laid out so every figure under test is a different number and no
 * two can be confused by coincidence:
 *
 *   Ours       — our people, our project            $100  (homed here)
 *   Theirs     — the OTHER centre's people, our project $ 40  (homed there)
 *   No project — our people, homed here, NO project  $ 25   (arm 1, see below)
 *   Ingest-only — a provider-usage day, homed here   $ 15   (arm 3)
 *
 * So: the project row's own total is $140, this centre's share of it is $100,
 * the "Not on a project" row is $40, and the hero headline is $180.
 *
 * ── WHY THE "NO PROJECT" MONEY IS TWO ROWS OF DIFFERENT PROVENANCE (r6-A1) ───
 * The $25 is an `attribution_record` row with a cost-owning unit AND no project.
 * That shape is SCHEMA-LEGAL but no writer produces it — both §A writers set the
 * CoU from the project and leave it NULL when there is none
 * (server/usage/complete-spend.ts, `untaggedUsd`: "schema-legal and unreachable
 * today"). A fixture built only from it proves the clamp's second arm compiles,
 * not that it ever fires in production.
 *
 * The $15 is the shape that DOES occur: v_complete_usage's ingest-only arm 3
 * selects `vtd.cost_owning_unit_id` alongside `NULL::uuid AS project_id`
 * (0101/0125), so provider-reported usage IS homed at a cost centre with no
 * project on it. It is untaggable, which is precisely why it can never reach the
 * hero through arm 1. Both stay: the first pins the schema, the second pins the
 * production path.
 */
const OURS = 100
const THEIRS = 40
const NO_PROJECT = 25
/** Arm 3 — the ingest-only, untaggable half of "not on a project". */
const INGEST_ONLY = 15
const NO_PROJECT_TOTAL = NO_PROJECT + INGEST_ONLY
/**
 * A PROVISIONAL identity binding, homed here, on our project (r6-H1). Bigger
 * than the gap between the project's own total and this centre's share, so an
 * operand that fails to drop it does not merely drift — it reports a share
 * LARGER than the row it is a part of.
 */
const PROVISIONAL = 55

/**
 * The models, chosen against migration 0046's SEEDED catalogue:
 *   `claude-opus-5`  → matches the `claude-opus` pattern      → frontier
 *   `claude-haiku-…` → matches the `claude-haiku` pattern     → lightweight
 *   `totally-unknown-model-x` → matches NOTHING               → unclassified
 */
const M_FRONTIER = 'claude-opus-5'
const M_CHEAP = 'claude-haiku-4-5'
const M_UNKNOWN = 'totally-unknown-model-x'

let ourTeammateId = ''

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('f5', 'Region F5')`
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='f5'`

  for (const [path, code, name] of [
    ['own', 'f5own', 'Own Centre'],
    ['oth', 'f5oth', 'Other Centre'],
  ] as const) {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId}::uuid, ${path}::ltree, ${code}, ${name}, 'bu', true)`
  }
  ;[{ id: ccId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='f5own'`
  ;[{ id: otherCcId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='f5oth'`

  const mk = async (name: string, ouId: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES (${'oid-' + name}, ${name + '@f5.test'}, ${name}, ${regionId}::uuid, ${ouId}::uuid, true)`
    const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${name + '@f5.test'}`
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${tm!.id}::uuid, 'claude-code', ${regionId}::uuid, ${ouId}::uuid, ${'h-' + name}, ${'P-' + name})`
    const [inst] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${tm!.id}::uuid LIMIT 1`
    return { teammateId: tm!.id, instanceId: inst!.id }
  }
  const ours = await mk('ada', ccId)
  const theirs = await mk('grace', otherCcId)
  ourTeammateId = ours.teammateId

  // ONE project, led by OUR centre — the clamp `p.cost_owning_unit_id = ccId`.
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('F5-P1', 'hash-F5-P1', 'Atlas', 'billable', ${regionId}::uuid, ${ccId}::uuid)`
  ;[{ id: ownProjectId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='F5-P1'`

  const emit = async (
    who: { teammateId: string; instanceId: string },
    homeCcId: string,
    projectId: string | null,
    model: string,
    usd: number,
    seq: number,
  ) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
         token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${who.instanceId}::uuid, ${who.teammateId}::uuid, ${regionId}::uuid, ${homeCcId}::uuid,
              ${homeCcId}::uuid, ${projectId}::uuid, 'claude-code', ${model},
              'input', 100, ${usd}, 'tier-1', 'estimated', '2026-07-02T00:00:00Z'::timestamptz, ${'conv-' + seq})`
  }

  // Our spend on our project, split across three models so the tier mix has
  // something to band — including one the catalogue has never heard of.
  await emit(ours, ccId, ownProjectId, M_FRONTIER, 60, 1)
  await emit(ours, ccId, ownProjectId, M_CHEAP, 10, 2)
  await emit(ours, ccId, ownProjectId, M_UNKNOWN, 30, 3)
  // Their spend on OUR project: the project's own total includes it; this
  // centre's share must not.
  await emit(theirs, otherCcId, ownProjectId, M_FRONTIER, THEIRS, 4)
  // Homed here, NO project — the "Not on a project" row, arm 1 (schema-legal).
  await emit(ours, ccId, null, M_FRONTIER, NO_PROJECT, 5)
  // …and the same row's arm-3 half: a provider-reported usage day, homed at this
  // centre by the dimension snapshot, with no project and no way to acquire one.
  // This is the half a production ledger actually carries.
  // An UNCONFIRMED identity binding, homed here, on our project. Every project
  // figure in the product drops these (the `excludeProvisional` seam), so both
  // operands on the Atlas row must be blind to it — or the part outgrows the
  // whole.
  const shadow = await mk('mallory', ccId)
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
       token_type, tokens, cost_usd, fidelity_tier, cost_basis, identity_state, ts_event, claude_session_id)
    VALUES (${shadow.instanceId}::uuid, ${shadow.teammateId}::uuid, ${regionId}::uuid, ${ccId}::uuid,
            ${ccId}::uuid, ${ownProjectId}::uuid, 'claude-code', ${M_FRONTIER},
            'input', 100, ${PROVISIONAL}, 'tier-1', 'estimated', 'provisional',
            '2026-07-02T00:00:00Z'::timestamptz, 'conv-provisional')`

  await t.client`INSERT INTO actual_spend
      (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
       region_id, org_unit_id, cost_owning_unit_id, dimension_source)
    VALUES (${ourTeammateId}::uuid, '2026-07-02'::date, 'claude-ai', 500, 500, ${INGEST_ONLY},
            'anthropic-analytics-api', ${regionId}::uuid, ${ccId}::uuid, ${ccId}::uuid,
            'ingest-snapshot')`

  // The Business-Unit page's engine wrappers (cost-centres.ts) take their §A
  // reads from usage_rollup_daily (usage-rollup-lane.md R5/R8): materialise
  // it from the seeds above.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

const heroes = async () => {
  const burn = await fetchCostCentreBurnDrill(t.db, ccId, WINDOW)
  return fetchCostCentreHeroes(t.db, ccId, WINDOW, burn.burnUsd)
}

describe('D30 — the money on NO project is a row, not a silent omission', () => {
  it('the Projects hero carries a "Not on a project" row with the right money', async () => {
    const { budgets } = await heroes()
    const row = budgets.rows.find((r) => r.key === NO_PROJECT_ROW_KEY)
    expect(row, 'a `p`-only clamp cannot produce this row — the second arm must exist').toBeDefined()
    expect(row!.label).toBe(NO_PROJECT_ROW_LABEL)
    expect(row!.usd).toBeCloseTo(NO_PROJECT_TOTAL, 6)
  })

  /*
   * r6-A1 — THE ARM MUST FIRE ON A SHAPE A WRITER PRODUCES, not merely on one
   * the schema permits. The $25 above is `attribution_record` with a CoU and no
   * project: legal, and written by nobody. If that were the only fixture, the
   * clamp could be dead in production and this file would still be green — which
   * is the state it shipped in.
   */
  it('the row carries the INGEST-ONLY arm, which is the half production writes', async () => {
    const { budgets } = await heroes()
    const row = budgets.rows.find((r) => r.key === NO_PROJECT_ROW_KEY)!
    expect(row.usd - NO_PROJECT).toBeCloseTo(INGEST_ONLY, 6)

    // And the fixture is not asserting its own guess: the arm-3 money really is
    // homed at this centre with a NULL project on the lane the axis reads.
    const [{ usd }] = await t.client<{ usd: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS usd FROM v_complete_usage
      WHERE cost_owning_unit_id = ${ccId}::uuid AND project_id IS NULL
        AND usage_provenance = 'provider-usage'
        AND ts_event >= ${WINDOW.startIso}::timestamptz AND ts_event < ${WINDOW.endIso}::timestamptz`
    expect(Number(usd)).toBeCloseTo(INGEST_ONLY, 6)
  })

  it('the row has NO budget concept at all — "—", never "no budget set"', () => {
    // `budgetUsd` ABSENT (not null) is what BudgetStateCell renders as
    // not-applicable. `null` would claim a decision nobody has made about a row
    // that could never hold one.
    return heroes().then(({ budgets }) => {
      const row = budgets.rows.find((r) => r.key === NO_PROJECT_ROW_KEY)!
      expect('budgetUsd' in row).toBe(false)
    })
  })

  it('the two arms are DISJOINT — nothing is counted in both', async () => {
    const { budgets } = await heroes()
    expect(budgets.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(budgets.headlineUsd, 6)
    expect(budgets.headlineUsd).toBeCloseTo(OURS + THEIRS + NO_PROJECT_TOTAL, 6)
    expect(budgets.rows.reduce((a, r) => a + r.sharePct, 0)).toBeCloseTo(1, 6)
  })

  it('the denominator NAMES the second arm, or the rows read as failing to add up', async () => {
    const { budgets } = await heroes()
    expect(budgets.denominatorLabel).toContain('burn on none')
  })
})

describe('D25 — the project row carries BOTH operands, and they differ', () => {
  it("the row's own total is the PROJECT's, across every centre that worked on it", async () => {
    const { budgets } = await heroes()
    const atlas = budgets.rows.find((r) => r.label === 'Atlas')!
    expect(atlas.usd).toBeCloseTo(OURS + THEIRS, 6)
  })

  it("the second operand is THIS centre's share, and it is a smaller, different number", async () => {
    const { budgets } = await heroes()
    const atlas = budgets.rows.find((r) => r.label === 'Atlas')!
    expect(atlas.scopeShareUsd).toBeCloseTo(OURS, 6)
    expect(atlas.scopeShareLabel).toBe(`this ${BU_LABEL_LOWER}`)
    // The load-bearing inequality: an implementation that echoed the row total
    // would pass every "the field is present" assertion and none of these.
    expect(atlas.scopeShareUsd).toBeLessThan(atlas.usd)
    expect(atlas.usd - atlas.scopeShareUsd!).toBeCloseTo(THEIRS, 6)
  })

  /*
   * r6-H1 — A PART MAY NOT EXCEED ITS WHOLE. The row's `usd` comes from the
   * project-axis seam with `excludeProvisional: true`; the share operand used to
   * read the lane WITHOUT that filter, so an unconfirmed identity binding was
   * counted in the part and not in the total. The row then rendered a share
   * LARGER than the project figure it sits beside.
   */
  it('the share never exceeds the row — both operands drop provisional identities', async () => {
    const { budgets } = await heroes()
    const atlas = budgets.rows.find((r) => r.label === 'Atlas')!
    expect(atlas.scopeShareUsd).toBeLessThanOrEqual(atlas.usd)
    // Concretely: the provisional dollars are absent from BOTH, not just one.
    expect(atlas.scopeShareUsd).toBeCloseTo(OURS, 6)

    // The fixture is not asserting its own guess — the provisional money really
    // is on this (centre, project) pair and really is bigger than the gap it
    // would have opened.
    const [{ usd }] = await t.client<{ usd: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS usd FROM v_complete_usage
      WHERE cost_owning_unit_id = ${ccId}::uuid AND project_id = ${ownProjectId}::uuid
        AND identity_state = 'provisional'
        AND ts_event >= ${WINDOW.startIso}::timestamptz AND ts_event < ${WINDOW.endIso}::timestamptz`
    expect(Number(usd)).toBeCloseTo(PROVISIONAL, 6)
  })

  it('the share primitive agrees with the row, on its own', async () => {
    const share = await fetchCostCentreProjectShare(t.db, ccId, WINDOW)
    expect(share.get(ownProjectId)).toBeCloseTo(OURS, 6)
    // And the OTHER centre sees its own $40 of the same project — the operand
    // is a property of the (centre, project) pair, not of the project.
    const theirShare = await fetchCostCentreProjectShare(t.db, otherCcId, WINDOW)
    expect(theirShare.get(ownProjectId)).toBeCloseTo(THEIRS, 6)
  })

  it('the "Not on a project" row carries NO second operand — the two are one number there', async () => {
    const { budgets } = await heroes()
    const row = budgets.rows.find((r) => r.key === NO_PROJECT_ROW_KEY)!
    expect(row.scopeShareUsd).toBeUndefined()
  })
})

describe('F5 — the model-tier measure, against the SEEDED catalogue', () => {
  it('bands a person by `model_catalog.tier`, with an unknown model in `unclassified`', async () => {
    const mix = await fetchCostCentreTeammateTierMix(t.db, ccId, WINDOW)
    const bands = mix.get(ourTeammateId)
    expect(bands, 'the drill measure must produce a mix from primitives that exist').toBeDefined()
    const byBand = new Map(bands!.map((b) => [b.band, b.usd]))
    // 60 on the project + 25 with no project, both frontier.
    expect(byBand.get('frontier')).toBeCloseTo(60 + NO_PROJECT, 6)
    expect(byBand.get('lightweight')).toBeCloseTo(10, 6)
    // THE DISCIPLINE: an unmatched model is its OWN band, never folded into the
    // cheapest one — folding it would understate frontier exposure by exactly
    // the spend nobody has classified yet.
    expect(byBand.get('unclassified')).toBeCloseTo(30, 6)
    expect(byBand.get('lightweight')).not.toBeCloseTo(10 + 30, 6)
  })

  it('the catalogue really does classify these models — the fixture is not asserting its own guess', async () => {
    /*
     * Pinned against the seeded rows themselves, so "unclassified" here means
     * "the catalogue has no pattern for it" rather than "the catalogue is
     * empty", which would make the previous assertion pass for the wrong reason.
     */
    const [{ n }] = [
      ...(await t.db.execute<{ n: string }>(
        sql`SELECT COUNT(*)::text AS n FROM model_catalog
            WHERE is_active = true AND ${sql.raw(`'${M_FRONTIER}'`)} LIKE '%' || model_pattern || '%'`,
      )),
    ]
    expect(Number(n)).toBeGreaterThan(0)
    const [{ n: unknown_n }] = [
      ...(await t.db.execute<{ n: string }>(
        sql`SELECT COUNT(*)::text AS n FROM model_catalog
            WHERE is_active = true AND ${sql.raw(`'${M_UNKNOWN}'`)} LIKE '%' || model_pattern || '%'`,
      )),
    ]
    expect(Number(unknown_n)).toBe(0)
  })

  it('the mix rides the PEOPLE hero rows, and only where there is banded spend', async () => {
    const { people } = await heroes()
    const ada = people.rows.find((r) => r.label === 'ada')!
    expect(ada.tierBreakdown).toBeDefined()
    // Hottest-to-coolest, never the order the scan returned.
    expect(ada.tierBreakdown!.map((b) => b.band)).toEqual(['frontier', 'lightweight', 'unclassified'])
    expect(ada.tierBreakdown!.map((b) => b.label)).toEqual(['Frontier', 'Economy', 'Unclassified'])
  })
})

describe('D23 — the visibility resolver reports WHY a centre is visible', () => {
  it('carries an `owned` flag per centre, so the scope block can land on the reader’s own', async () => {
    const ccs = await fetchVisibleCostCentres(t.db, { unbounded: true })
    expect(ccs.length).toBeGreaterThanOrEqual(2)
    // No `cou_owner` rows in this fixture and no teammate GUC set, so nothing is
    // owned — the flag must be FALSE, never absent and never undefined.
    for (const c of ccs) expect(c.owned).toBe(false)
  })
})
