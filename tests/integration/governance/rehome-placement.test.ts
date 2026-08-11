// @vitest-environment node
/*
 * Correcting where a person sits, and moving what they already spent with them.
 *
 * `bulk-place` could re-home hundreds of teammates and touched no spend row, so
 * a corrected person kept reporting under the wrong Business Unit forever and
 * the only remedy was to rebuild the database.
 *
 * The per-table postconditions are asserted individually and on purpose: the
 * plan's own review pointed out that a page-level assertion can be satisfied by
 * arm 1 alone while arm 3 stays wrong, so "the BU page moved" is not evidence
 * that `actual_spend` and `reconciliation_record` moved with it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { rehomePlacement } from '../../../server/governance/rehome-placement'

let t: TestDb
let regionId = ''
let buOld = ''
let buNew = ''
let teammateId = ''
let otherTeammateId = ''
let instanceId = ''
let projectId = ''

const iso = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000))
const RECENT = daysAgo(3)
const OLD = daysAgo(70)

beforeAll(async () => {
  t = await startTestDb()
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('rp', 'RP') RETURNING id::text AS id`
  const unit = async (path: string, code: string) => {
    const [r] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', true) RETURNING id::text AS id`
    return r!.id
  }
  buOld = await unit('old', 'old')
  buNew = await unit('new', 'new')
  const tm = async (oid: string, email: string, unitId: string) => {
    const [r] = await t.client<{ id: string }[]>`
      INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES (${oid}, ${email}, ${oid}, ${regionId}::uuid, ${unitId}::uuid, true) RETURNING id::text AS id`
    return r!.id
  }
  teammateId = await tm('oid-rp-1', 'rp1@x.test', buOld)
  otherTeammateId = await tm('oid-rp-2', 'rp2@x.test', buOld)
  ;[{ id: projectId }] = await t.client<{ id: string }[]>`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('RP1', 'hrp1', 'RP1', 'internal', ${regionId}::uuid, ${buOld}::uuid) RETURNING id::text AS id`
  ;[{ id: instanceId }] = await t.client<{ id: string }[]>`
    INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${regionId}::uuid, ${buOld}::uuid, 'h', 'P')
    RETURNING instance_id::text AS id`
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
})

/** One row in every table the correction has to reach, for one teammate/day. */
async function seedAllArms(tmId: string, day: string, cost = '10.000000') {
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
       token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instanceId}::uuid, ${tmId}::uuid, ${regionId}::uuid, ${buOld}::uuid, ${buOld}::uuid,
            ${projectId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100, ${cost},
            'tier-1', 'estimated', ${day}::timestamptz, ${'s-' + tmId + day})`
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${tmId}::uuid, ${regionId}::uuid, ${buOld}::uuid, ${day}::date, 'claude-ai', ${cost}, 10, 'test')`
  await t.client`INSERT INTO actual_spend
      (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, region_id, org_unit_id, cost_owning_unit_id)
    VALUES (${tmId}::uuid, ${day}::date, 'claude-code', 100, 50, ${cost}, 'anthropic-analytics-api',
            ${regionId}::uuid, ${buOld}::uuid, ${buOld}::uuid)`
  await t.client`INSERT INTO over_emission
      (teammate_id, region_id, org_unit_id, day, tool, otel_usd, api_usd, over_usd)
    VALUES (${tmId}::uuid, ${regionId}::uuid, ${buOld}::uuid, ${day}::date, 'claude-code',
            ${cost}, 0, ${cost})`
  await t.client`INSERT INTO reconciliation_record
      (teammate_id, provider, enterprise_ref, period_date, category,
       actual_usd, otel_attributed_usd, delta_usd, spend_class, disposition,
       region_id, org_unit_id, cost_owning_unit_id)
    VALUES (${tmId}::uuid, 'anthropic', 'ent-rp', ${day}::date, 'usage',
            ${cost}, ${cost}, 0, 'billed', 'matched',
            ${regionId}::uuid, ${buOld}::uuid, ${buOld}::uuid)`
  await t.client`INSERT INTO spend_rollup_daily
      (period_start, project_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id,
       tool, model, token_type, total_tokens, total_cost_usd, indicative_cost_usd, record_count)
    VALUES (${day}::date, ${projectId}::uuid, ${tmId}::uuid, ${regionId}::uuid, ${buOld}::uuid, ${buOld}::uuid,
            'claude-code', 'claude-sonnet-4-6', 'input', 100, ${cost}, 0, 1)`
}

const countOn = async (table: string, unitId: string, tmId = teammateId) => {
  const [r] = await t.client<{ n: string }[]>`
    SELECT count(*)::text AS n FROM ${t.client.unsafe(table)}
     WHERE teammate_id = ${tmId}::uuid AND org_unit_id = ${unitId}::uuid`
  return Number(r!.n)
}

beforeEach(async () => {
  for (const tbl of ['attribution_record', 'unaccounted_usage', 'over_emission', 'actual_spend', 'reconciliation_record', 'spend_rollup_daily']) {
    await t.client.unsafe(`DELETE FROM ${tbl}`)
  }
  delete process.env.LEDGER_ROLLUP_FREEZE_FLOOR_DAYS
})

describe('an admin correction moves the history with the person', () => {
  it('EVERY table follows — asserted per table, not via one page figure', async () => {
    await seedAllArms(teammateId, RECENT)

    const res = await t.db.transaction((tx) =>
      rehomePlacement(tx, { teammateId, toOrgUnitId: buNew, range: { from: 'all' } }),
    )

    expect(res.attributionRows).toBe(1)
    expect(res.unaccountedRows).toBe(1)
    expect(res.overEmissionRows).toBe(1)
    expect(res.actualSpendRows).toBe(1)
    expect(res.reconciliationRows).toBe(1)
    expect(res.rollupRows).toBe(1)

    // ALL SIX. The first version of this test seeded four and asserted four,
    // while its own name and comment claimed every table — so removing the
    // `over_emission` or `reconciliation_record` UPDATE would have left the
    // suite green with those records under the old placement.
    for (const tbl of [
      'attribution_record',
      'unaccounted_usage',
      'over_emission',
      'actual_spend',
      'reconciliation_record',
      'spend_rollup_daily',
    ]) {
      expect(await countOn(tbl, buNew), `${tbl} did not follow`).toBe(1)
      expect(await countOn(tbl, buOld), `${tbl} left a row behind`).toBe(0)
    }
  })

  it('leaves OTHER teammates alone', async () => {
    await seedAllArms(teammateId, RECENT)
    await seedAllArms(otherTeammateId, RECENT, '4.000000')

    await t.db.transaction((tx) =>
      rehomePlacement(tx, { teammateId, toOrgUnitId: buNew, range: { from: 'all' } }),
    )

    expect(await countOn('attribution_record', buOld, otherTeammateId)).toBe(1)
    expect(await countOn('actual_spend', buOld, otherTeammateId)).toBe(1)
  })

  it('honours a date floor', async () => {
    await seedAllArms(teammateId, RECENT)
    await seedAllArms(teammateId, OLD, '5.000000')

    await t.db.transaction((tx) =>
      rehomePlacement(tx, { teammateId, toOrgUnitId: buNew, range: { from: daysAgo(30) } }),
    )

    const rows = await t.client<{ day: string; unit: string }[]>`
      SELECT (ts_event AT TIME ZONE 'UTC')::date::text AS day, org_unit_id::text AS unit
        FROM attribution_record WHERE teammate_id = ${teammateId}::uuid ORDER BY day`
    expect(rows.find((r) => r.day === RECENT)!.unit).toBe(buNew)
    expect(rows.find((r) => r.day === OLD)!.unit).toBe(buOld) // below the floor
  })

  it('does NOT touch attribution_record.cost_owning_unit_id — that is the project axis', async () => {
    /*
     * The column on THAT table is the PROJECT's Business Unit and belongs to
     * Migrate. Writing it on a person move would silently re-home project spend
     * as a side effect of correcting where somebody sits.
     */
    await seedAllArms(teammateId, RECENT)
    await t.db.transaction((tx) =>
      rehomePlacement(tx, { teammateId, toOrgUnitId: buNew, range: { from: 'all' } }),
    )
    const [row] = await t.client<{ cou: string }[]>`
      SELECT cost_owning_unit_id::text AS cou FROM attribution_record WHERE teammate_id = ${teammateId}::uuid`
    expect(row!.cou).toBe(buOld)
  })

  it('DOES move cost_owning_unit_id on actual_spend — there it is the teammate’s', async () => {
    await seedAllArms(teammateId, RECENT)
    await t.db.transaction((tx) =>
      rehomePlacement(tx, { teammateId, toOrgUnitId: buNew, range: { from: 'all' } }),
    )
    const [row] = await t.client<{ cou: string; src: string }[]>`
      SELECT cost_owning_unit_id::text AS cou, dimension_source AS src
        FROM actual_spend WHERE teammate_id = ${teammateId}::uuid`
    expect(row!.cou).toBe(buNew)
    expect(row!.src).toBe('admin-correction') // a human did this, not the directory
  })

  it('MERGES the rollup instead of colliding on its unique grain', async () => {
    /*
     * `org_unit_id` is part of spend_rollup_daily's unique key, so a plain
     * UPDATE raises a unique violation the moment the teammate already has a
     * row for the same grain under the TARGET — which happens after any partial
     * or repeated correction. The amounts must ADD, not overwrite.
     */
    await seedAllArms(teammateId, RECENT, '10.000000')
    await t.client`INSERT INTO spend_rollup_daily
        (period_start, project_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id,
         tool, model, token_type, total_tokens, total_cost_usd, indicative_cost_usd, record_count)
      VALUES (${RECENT}::date, ${projectId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${buNew}::uuid, ${buOld}::uuid,
              'claude-code', 'claude-sonnet-4-6', 'input', 100, 3.000000, 0, 1)`

    await t.db.transaction((tx) =>
      rehomePlacement(tx, { teammateId, toOrgUnitId: buNew, range: { from: 'all' } }),
    )

    const rows = await t.client<{ n: string; total: string }[]>`
      SELECT count(*)::text AS n, round(SUM(total_cost_usd), 2)::text AS total
        FROM spend_rollup_daily WHERE teammate_id = ${teammateId}::uuid`
    expect(rows[0]!.n).toBe('1') // merged, not duplicated
    expect(Number(rows[0]!.total)).toBeCloseTo(13, 2) // 10 + 3, added not overwritten
  })

  it('is idempotent — a second run moves nothing', async () => {
    await seedAllArms(teammateId, RECENT)
    const opts = { teammateId, toOrgUnitId: buNew, range: { from: 'all' as const } }
    await t.db.transaction((tx) => rehomePlacement(tx, opts))
    const second = await t.db.transaction((tx) => rehomePlacement(tx, opts))
    expect(second.attributionRows).toBe(0)
    expect(second.actualSpendRows).toBe(0)
    expect(second.rollupRows).toBe(0)
  })

  it('moves cold rows too — the archive floor says ELIGIBLE, not GONE', async () => {
    /*
     * This used to skip days below `LEDGER_ROLLUP_FREEZE_FLOOR_DAYS` on the
     * reasoning that the raw rows were archived away. But the floor marks when a
     * day becomes eligible for archiving, and archiving can be off or simply not
     * have run — while arm 1 of `v_complete_usage` reads `attribution_record`
     * directly. A skipped row that still exists means the rollup says the new
     * Business Unit and every §A report says the old one, for good.
     */
    process.env.LEDGER_ROLLUP_FREEZE_FLOOR_DAYS = '30'
    await seedAllArms(teammateId, OLD)

    const res = await t.db.transaction((tx) =>
      rehomePlacement(tx, { teammateId, toOrgUnitId: buNew, range: { from: 'all' } }),
    )

    expect(res.attributionRows).toBe(1)
    expect(await countOn('attribution_record', buNew)).toBe(1)
    expect(res.rollupRows).toBe(1)
    expect(await countOn('spend_rollup_daily', buNew)).toBe(1)
  })

  it('MERGES TWO SOURCE BUs onto one target grain without aborting', async () => {
    /*
     * The failure this prevents is not a wrong number, it is a rolled-back
     * transaction: two source rows on the same (day, project, model, …) grain
     * under DIFFERENT historical BUs both map to one target key, and Postgres
     * raises "ON CONFLICT DO UPDATE command cannot affect row a second time",
     * taking the placement change down with it. Any second correction of the
     * same person produces exactly this shape.
     */
    await seedAllArms(teammateId, RECENT, '10.000000')
    const [{ id: buThird }] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId}::uuid, 'third', 'third', 'third', 'bu', true) RETURNING id::text AS id`
    await t.client`INSERT INTO spend_rollup_daily
        (period_start, project_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id,
         tool, model, token_type, total_tokens, total_cost_usd, indicative_cost_usd, record_count)
      VALUES (${RECENT}::date, ${projectId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${buThird}::uuid, ${buOld}::uuid,
              'claude-code', 'claude-sonnet-4-6', 'input', 100, 7.000000, 0, 1)`

    await t.db.transaction((tx) =>
      rehomePlacement(tx, { teammateId, toOrgUnitId: buNew, range: { from: 'all' } }),
    )

    const rows = await t.client<{ n: string; total: string }[]>`
      SELECT count(*)::text AS n, round(SUM(total_cost_usd), 2)::text AS total
        FROM spend_rollup_daily WHERE teammate_id = ${teammateId}::uuid`
    expect(rows[0]!.n).toBe('1')
    expect(Number(rows[0]!.total)).toBeCloseTo(17, 2) // 10 + 7, both sources
  })

  it('stamps the nearest COST-OWNING ancestor, not the team node the person joined', async () => {
    /*
     * `PATCH .../org-unit` allows a plain team node as a target on purpose.
     * `cost_owning_unit_id` means "the unit this money bills to", and a plain
     * team node bills to nothing — writing it there invents a Business Unit no
     * report clamps on and no owner can see.
     */
    const [{ id: team }] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId}::uuid, 'new.squad'::ltree, 'squad', 'Squad', 'team', false)
      RETURNING id::text AS id`
    await seedAllArms(teammateId, RECENT)

    await t.db.transaction((tx) =>
      rehomePlacement(tx, { teammateId, toOrgUnitId: team, range: { from: 'all' } }),
    )

    const [row] = await t.client<{ ou: string; cou: string }[]>`
      SELECT org_unit_id::text AS ou, cost_owning_unit_id::text AS cou
        FROM actual_spend WHERE teammate_id = ${teammateId}::uuid`
    expect(row!.ou).toBe(team) // the person really is on the team node
    expect(row!.cou).toBe(buNew) // ...but the money bills to its cost-owning parent
  })
})
