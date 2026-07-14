// @vitest-environment node
/*
 * aggregate-rollup materializer (brief §6.1) — the consumption-dashboard
 * read path. Gates (night sprint N1):
 *   - parity: aggregate sums re-add EXACTLY to ledger sums per scope
 *   - idempotency: re-run rewrites identical cells (no drift, no dupes)
 *   - empty-table self-bootstrap reports mode='backfill'
 *   - re-tag correctness: moving a conversation to a project after the
 *     day was materialised updates BOTH project-scope and removes nothing
 *     from teammate scope
 *   - advisory split: tier-2 cost lands in advisory_cost_usd
 *   - RLS bridge (mig 0046): teammate sees own cells; project members see
 *     project cells; non-members see none
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { runAggregateRollup } from '../../../server/workers/aggregate-rollup'
import { withRlsContext } from '../../../server/db/rls'

let t: TestDb
// Non-owner role so RLS actually applies (owners bypass policies). Role names
// are test-local (NOT tokenscope_app) so this file never collides with
// rls.test.ts on a shared cluster; dropped in afterAll.
let scopedClient: ReturnType<typeof postgres>
let scopedDb: PostgresJsDatabase<typeof schema>
let devId: string
let otherId: string
let regionId: string
let orgUnitId: string
let projectId: string
const INSTANCE = randomUUID()
const CONV_TAGGED = 'conv-agg-tagged'
const CONV_RETAG = 'conv-agg-retag'

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db.insert(schema.region).values({ code: 'apac-ar', displayName: 'APAC' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'apac.agg', code: 'agg', displayName: 'Agg', unitType: 'bu' })
    .returning()
  orgUnitId = bu!.id
  const [dev] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-agg-dev', email: 'agg.dev@example.com', regionId, orgUnitId })
    .returning()
  devId = dev!.id
  const [other] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-agg-other', email: 'agg.other@example.com', regionId, orgUnitId })
    .returning()
  otherId = other!.id
  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: 'AGG-P1',
      codeHash: 'h-agg-p1',
      displayName: 'Aggregate P1',
      type: 'billable',
      regionId,
      costOwningUnitId: orgUnitId,
    })
    .returning()
  projectId = proj!.id
  await t.db.insert(schema.projectAssignment).values({
    projectId,
    teammateId: devId,
    effective: sql`'[2026-01-01, 2099-01-01)'::tstzrange`,
  })
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: INSTANCE,
    principalOid: 'oid-agg-dev',
    teammateId: devId,
    projectCodeHash: 'h-agg-p1',
    rawProjectCode: 'AGG-P1',
    tool: 'claude-code',
    sessionTokenHash: 'tok-agg-' + INSTANCE,
    tsStart: new Date(),
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
  })

  // Ledger fixture, recent days (inside the incremental ts_recorded window):
  //   - tagged conversation on AGG-P1: two models × two token types, one
  //     tier-2 row for the advisory split
  //   - untagged conversation (no project) for the re-tag scenario
  const now = Date.now()
  // "today-ish": now - 2h, but clamped to the start of the current UTC day so a
  // run in the first two UTC hours doesn't push this back into YESTERDAY. That
  // bug left no current-day aggregate cell, so the partial-backfill test's
  // "today's cells survive the `< today` delete" assertion saw 0 rows and failed
  // (only between 00:00–02:00 UTC). Outside that window this is exactly now - 2h.
  const todayStartUtc = new Date(now)
  todayStartUtc.setUTCHours(0, 0, 0, 0)
  const day0 = new Date(Math.max(todayStartUtc.getTime(), now - 2 * 3_600_000)) // today (UTC)
  const day1 = new Date(now - 26 * 3_600_000) // yesterday-ish
  const rows: Array<{
    conv: string
    proj: string | null
    model: string
    tokenType: string
    tokens: bigint
    cost: string
    tier: string
    basis: string
    ts: Date
    run: string
  }> = [
    { conv: CONV_TAGGED, proj: projectId, model: 'claude-fable-5', tokenType: 'input', tokens: 100_000n, cost: '0.300000', tier: 'tier-1', basis: 'estimated', ts: day0, run: 'r1' },
    { conv: CONV_TAGGED, proj: projectId, model: 'claude-fable-5', tokenType: 'output', tokens: 20_000n, cost: '0.300000', tier: 'tier-1', basis: 'estimated', ts: day0, run: 'r1' },
    { conv: CONV_TAGGED, proj: projectId, model: 'claude-haiku-4-5', tokenType: 'input', tokens: 10_000n, cost: '0.010000', tier: 'tier-2', basis: 'telemetry-only', ts: day0, run: 'r2' },
    { conv: CONV_TAGGED, proj: projectId, model: 'claude-fable-5', tokenType: 'input', tokens: 50_000n, cost: '0.150000', tier: 'tier-1', basis: 'estimated', ts: day1, run: 'r3' },
    { conv: CONV_RETAG, proj: null, model: 'claude-sonnet-4-6', tokenType: 'input', tokens: 40_000n, cost: '0.120000', tier: 'tier-1', basis: 'estimated', ts: day1, run: 'r4' },
    { conv: CONV_RETAG, proj: null, model: 'claude-sonnet-4-6', tokenType: 'output', tokens: 5_000n, cost: '0.075000', tier: 'tier-1', basis: 'estimated', ts: day1, run: 'r4' },
  ]
  await t.client.unsafe(`
    CREATE ROLE agg_rls_app NOLOGIN;
    GRANT USAGE ON SCHEMA public TO agg_rls_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agg_rls_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO agg_rls_app;
    CREATE USER agg_rls_login WITH LOGIN PASSWORD 'app';
    GRANT agg_rls_app TO agg_rls_login;
  `)
  const scopedUrl = new URL(t.url)
  scopedUrl.username = 'agg_rls_login'
  scopedUrl.password = 'app'
  scopedClient = postgres(scopedUrl.toString(), { max: 2, idle_timeout: 5 })
  scopedDb = drizzle(scopedClient, { schema })

  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)
  for (const r of rows) {
    await t.db.insert(schema.attributionRecord).values({
      instanceId: INSTANCE,
      claudeSessionId: r.conv,
      teammateId: devId,
      projectId: r.proj,
      regionId,
      orgUnitId,
      costOwningUnitId: r.proj ? orgUnitId : null,
      tool: 'claude-code',
      model: r.model,
      tokenType: r.tokenType,
      tokens: r.tokens,
      costUsd: r.cost,
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: r.tier,
      costBasis: r.basis,
      tsEvent: r.ts,
      sourceRunId: r.run,
    })
  }
}, 60_000)

afterAll(async () => {
  await scopedClient?.end({ timeout: 5 })
  await t.client.unsafe(
    `DROP OWNED BY agg_rls_app CASCADE;
     DROP USER IF EXISTS agg_rls_login;
     DROP ROLE IF EXISTS agg_rls_app;`,
  ).catch(() => undefined)
  await stopTestDb(t)
}, 30_000)

describe('runAggregateRollup', () => {
  it('first run on an empty table self-bootstraps as backfill and writes both scopes', async () => {
    const result = await runAggregateRollup(t.db)
    expect(result.mode).toBe('backfill')
    expect(result.daysRecomputed).toBeGreaterThanOrEqual(2)
    expect(result.teammateCells).toBeGreaterThan(0)
    expect(result.projectCells).toBeGreaterThan(0)
  })

  it('parity: aggregate sums re-add exactly to ledger sums (both scopes)', async () => {
    const [ledgerT] = await t.client<{ tokens: string; cost: string; advisory: string }[]>`
      SELECT SUM(tokens)::text AS tokens, SUM(cost_usd)::text AS cost,
             COALESCE(SUM(cost_usd) FILTER (WHERE fidelity_tier = 'tier-2'), 0)::text AS advisory
      FROM attribution_record WHERE teammate_id = ${devId}::uuid
    `
    const [aggT] = await t.client<{ tokens: string; cost: string; advisory: string }[]>`
      SELECT SUM(total_tokens)::text AS tokens, SUM(total_cost_usd)::text AS cost,
             SUM(advisory_cost_usd)::text AS advisory
      FROM attribution_aggregate WHERE scope_type = 'teammate' AND scope_id = ${devId}::uuid
    `
    expect(Number(aggT!.tokens)).toBe(Number(ledgerT!.tokens))
    expect(Number(aggT!.cost)).toBeCloseTo(Number(ledgerT!.cost), 6)
    expect(Number(aggT!.advisory)).toBeCloseTo(Number(ledgerT!.advisory), 6)

    const [ledgerP] = await t.client<{ cost: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS cost
      FROM attribution_record WHERE project_id = ${projectId}::uuid
    `
    const [aggP] = await t.client<{ cost: string }[]>`
      SELECT COALESCE(SUM(total_cost_usd), 0)::text AS cost
      FROM attribution_aggregate WHERE scope_type = 'project' AND scope_id = ${projectId}::uuid
    `
    expect(Number(aggP!.cost)).toBeCloseTo(Number(ledgerP!.cost), 6)
  })

  it('idempotency: re-run leaves identical cells (no dupes, no drift)', async () => {
    // Mode is gated on worker_run (not row count): record the completed
    // backfill the dispatcher would have persisted, so this run goes
    // incremental — exactly the production transition.
    await t.client`
      INSERT INTO worker_run (worker_name, status, result, started_at)
      VALUES ('aggregate-rollup', 'success', '{"backfillComplete":true}'::jsonb, now())
    `
    const before = await t.client<{ n: string; cost: string }[]>`
      SELECT COUNT(*)::text AS n, SUM(total_cost_usd)::text AS cost FROM attribution_aggregate
    `
    const result = await runAggregateRollup(t.db)
    expect(result.mode).toBe('incremental')
    const after = await t.client<{ n: string; cost: string }[]>`
      SELECT COUNT(*)::text AS n, SUM(total_cost_usd)::text AS cost FROM attribution_aggregate
    `
    expect(after[0]!.n).toBe(before[0]!.n)
    expect(Number(after[0]!.cost)).toBeCloseTo(Number(before[0]!.cost), 6)
  })

  it('re-tag: assigning an old conversation to a project re-keys its days into project scope', async () => {
    // Simulate the assign endpoint: ledger UPDATE (incl. the ts_recorded bump
    // tagSessionTx does, which is the incremental recompute signal) +
    // session_assignment write.
    await t.client`
      UPDATE attribution_record SET project_id = ${projectId}::uuid,
             cost_owning_unit_id = ${orgUnitId}::uuid, ts_recorded = now()
      WHERE claude_session_id = ${CONV_RETAG}
    `
    await t.db.insert(schema.sessionAssignment).values({
      claudeSessionId: CONV_RETAG,
      teammateId: devId,
      projectId,
      source: 'manual',
    })

    await runAggregateRollup(t.db)

    const [aggP] = await t.client<{ cost: string }[]>`
      SELECT COALESCE(SUM(total_cost_usd), 0)::text AS cost
      FROM attribution_aggregate WHERE scope_type = 'project' AND scope_id = ${projectId}::uuid
    `
    const [ledgerP] = await t.client<{ cost: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS cost
      FROM attribution_record WHERE project_id = ${projectId}::uuid
    `
    // Project scope now includes the re-tagged conversation's spend.
    expect(Number(aggP!.cost)).toBeCloseTo(Number(ledgerP!.cost), 6)
    expect(Number(aggP!.cost)).toBeGreaterThan(0.7) // 0.76 fixture total

    // Teammate scope unchanged by the re-tag (teammate axis is stable).
    const [aggT] = await t.client<{ cost: string }[]>`
      SELECT SUM(total_cost_usd)::text AS cost
      FROM attribution_aggregate WHERE scope_type = 'teammate' AND scope_id = ${devId}::uuid
    `
    expect(Number(aggT!.cost)).toBeCloseTo(0.955, 3)
  })

  it('RLS bridge: teammate-self and project-member policies admit; strangers denied', async () => {
    const asUser = (teammateId: string) =>
      withRlsContext(
        scopedDb as never,
        {
          userRegionId: regionId,
          userOrgPath: 'apac.agg',
          userRole: 'developer',
          userTeammateId: teammateId,
        },
        async (tx) => {
          const own = await tx.execute<{ n: string }>(sql`
            SELECT COUNT(*)::text AS n FROM attribution_aggregate
            WHERE scope_type = 'teammate' AND scope_id = ${devId}::uuid
          `)
          const proj = await tx.execute<{ n: string }>(sql`
            SELECT COUNT(*)::text AS n FROM attribution_aggregate
            WHERE scope_type = 'project' AND scope_id = ${projectId}::uuid
          `)
          return { own: Number([...own][0]!.n), proj: Number([...proj][0]!.n) }
        },
      )

    const dev = await asUser(devId)
    expect(dev.own).toBeGreaterThan(0) // self cells visible
    expect(dev.proj).toBeGreaterThan(0) // member sees project cells

    const stranger = await asUser(otherId)
    expect(stranger.own).toBe(0) // dev's teammate cells invisible to other
    expect(stranger.proj).toBe(0) // non-member sees no project cells
  })

  it('partial-backfill recovery: a non-empty table with NO completion marker re-backfills (no permanent gap)', async () => {
    // Reproduce the crash: wipe the completion marker and delete a swathe of
    // already-materialised days, leaving the table non-empty but incomplete.
    // The OLD row-count gate would flip to incremental (2d ts_recorded) and
    // strand these old days forever; the worker_run gate must re-backfill.
    await t.client`DELETE FROM worker_run WHERE worker_name = 'aggregate-rollup'`
    await t.client`
      DELETE FROM attribution_aggregate
      WHERE period_start < date_trunc('day', now() AT TIME ZONE 'UTC')
    `
    const remaining = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM attribution_aggregate
    `
    // table is non-empty (today's cells survive) but missing yesterday's
    expect(Number(remaining[0]!.n)).toBeGreaterThan(0)

    const result = await runAggregateRollup(t.db)
    expect(result.mode).toBe('backfill') // re-entered backfill, not incremental
    expect(result.backfillComplete).toBe(true)

    // Full horizon restored: aggregate teammate total == ledger again.
    const [ledgerT] = await t.client<{ cost: string }[]>`
      SELECT SUM(cost_usd)::text AS cost FROM attribution_record WHERE teammate_id = ${devId}::uuid
    `
    const [aggT] = await t.client<{ cost: string }[]>`
      SELECT SUM(total_cost_usd)::text AS cost
      FROM attribution_aggregate WHERE scope_type = 'teammate' AND scope_id = ${devId}::uuid
    `
    expect(Number(aggT!.cost)).toBeCloseTo(Number(ledgerT!.cost), 6)
  })
})
