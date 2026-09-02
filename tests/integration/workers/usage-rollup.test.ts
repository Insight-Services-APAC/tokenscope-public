// @vitest-environment node
/*
 * usage-rollup — the day-grain §A rollup behind the region reports
 * (docs/design/usage-rollup-lane.md R3/R4/R8; mig 0136).
 *
 * The load-bearing assertion is FOOTING: per-day and in total,
 * Σ(usage_rollup_daily) ≡ Σ(v_complete_usage) for cost AND tokens, with
 * record conservation — over an estate that exercises every arm (OTel arm 1
 * incl. a quarantine exclusion, arm-2 children + remainder, arm-3 fan-out +
 * remainder). The worker aggregates THE VIEW, so this is the proof the copy
 * step drops nothing and invents nothing.
 *
 * Also pinned: idempotency (second run changes nothing), the RESUMABLE
 * backfill (a chunk-capped run reports backfillComplete=false and a later
 * run finishes the job — the dispatch-budget contract), the refresh
 * queue (a quarantine flip has NO timestamp a trailing window can see; the
 * queued teammate's history is recomputed and the request row drained), and
 * — since 0138 put identity_state in the grain (usage-rollup-lane.md R5b) —
 * the per-identity_state footing split plus the provisional → confirmed
 * restate through the real confirm-instance flow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  runUsageRollup,
  REFRESH_DAYS,
  NARROW_REFRESH_DAYS,
} from '../../../server/workers/usage-rollup'

let t: TestDb
let regionId = ''
let unitId = ''
let tmA = ''
let tmB = ''
let instB = ''

const footing = async () => {
  const [row] = await t.client<
    { v_n: number; v_usd: string; v_tok: string; r_n: number; r_usd: string; r_tok: string }[]
  >`
    SELECT
      (SELECT COUNT(*)::int FROM v_complete_usage) AS v_n,
      (SELECT COALESCE(SUM(cost_usd), 0)::text FROM v_complete_usage) AS v_usd,
      (SELECT COALESCE(SUM(tokens), 0)::text FROM v_complete_usage) AS v_tok,
      (SELECT COALESCE(SUM(record_count), 0)::int FROM usage_rollup_daily) AS r_n,
      (SELECT COALESCE(SUM(cost_usd), 0)::text FROM usage_rollup_daily) AS r_usd,
      (SELECT COALESCE(SUM(tokens), 0)::text FROM usage_rollup_daily) AS r_tok`
  return row!
}

/**
 * The STRONG identity: per-(day, every grain dim) EXCEPT ALL in both
 * directions between a fresh aggregate of the view and the stored cells. A
 * swapped region/project/model between two cells keeps estate totals equal —
 * only this catches it.
 */
const dimIdentityDiff = async (): Promise<number> => {
  // identity_state through NULLIF('' -> NULL) on the fresh-aggregate side —
  // the exact cellsSelect shape: the grain arbiter buckets NULL and '' into
  // one key, so the rollup's DEFINED content collapses them to one cell.
  const [row] = await t.client<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM (
      (SELECT (u.ts_event AT TIME ZONE 'UTC')::date AS day,
              u.teammate_id, u.region_id, u.org_unit_id, u.cost_owning_unit_id, u.project_id,
              u.tool, u.model, u.usage_provenance, u.model_gap_reason, u.activity,
              NULLIF(u.identity_state, '') AS identity_state,
              COALESCE(SUM(u.cost_usd), 0)::numeric(14, 6) AS cost_usd,
              COALESCE(SUM(u.tokens), 0)::bigint AS tokens,
              COUNT(*)::int AS record_count
       FROM v_complete_usage u
       GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
       EXCEPT ALL
       SELECT day, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
              tool, model, usage_provenance, model_gap_reason, activity, identity_state,
              cost_usd, tokens, record_count
       FROM usage_rollup_daily)
      UNION ALL
      (SELECT day, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
              tool, model, usage_provenance, model_gap_reason, activity, identity_state,
              cost_usd, tokens, record_count
       FROM usage_rollup_daily
       EXCEPT ALL
       SELECT (u.ts_event AT TIME ZONE 'UTC')::date,
              u.teammate_id, u.region_id, u.org_unit_id, u.cost_owning_unit_id, u.project_id,
              u.tool, u.model, u.usage_provenance, u.model_gap_reason, u.activity,
              NULLIF(u.identity_state, ''),
              COALESCE(SUM(u.cost_usd), 0)::numeric(14, 6),
              COALESCE(SUM(u.tokens), 0)::bigint,
              COUNT(*)::int
       FROM v_complete_usage u
       GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)
    ) d`
  return row!.n
}

/**
 * R5b: the per-day footing, SPLIT per identity_state value — EXCEPT ALL in
 * both directions at (day, identity_state) grain. Estate totals cannot catch a
 * worker that collapses states into one cell (Σ is unchanged); only the split
 * does. Set-op row comparison treats NULLs as equal, so the NULL arm-1 state
 * is a real bucket here, not a wildcard.
 */
const identityStateFootingDiff = async (): Promise<number> => {
  // Same NULLIF('' -> NULL) normalisation as cellsSelect on the view side.
  const [row] = await t.client<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM (
      (SELECT (u.ts_event AT TIME ZONE 'UTC')::date AS day,
              NULLIF(u.identity_state, '') AS identity_state,
              COALESCE(SUM(u.cost_usd), 0)::numeric(14, 6) AS cost_usd,
              COALESCE(SUM(u.tokens), 0)::bigint AS tokens,
              COUNT(*)::int AS record_count
       FROM v_complete_usage u GROUP BY 1, 2
       EXCEPT ALL
       SELECT day, identity_state,
              SUM(cost_usd)::numeric(14, 6), SUM(tokens)::bigint, SUM(record_count)::int
       FROM usage_rollup_daily GROUP BY 1, 2)
      UNION ALL
      (SELECT day, identity_state,
              SUM(cost_usd)::numeric(14, 6), SUM(tokens)::bigint, SUM(record_count)::int
       FROM usage_rollup_daily GROUP BY 1, 2
       EXCEPT ALL
       SELECT (u.ts_event AT TIME ZONE 'UTC')::date, NULLIF(u.identity_state, ''),
              COALESCE(SUM(u.cost_usd), 0)::numeric(14, 6),
              COALESCE(SUM(u.tokens), 0)::bigint,
              COUNT(*)::int
       FROM v_complete_usage u GROUP BY 1, 2)
    ) d`
  return row!.n
}

/** Loop the resumable backfill to completion, the way successive ticks would. */
const runToComplete = async (opts?: Parameters<typeof runUsageRollup>[1]) => {
  for (let i = 0; i < 20; i++) {
    const r = await runUsageRollup(t.db, opts)
    if (r.backfillComplete) return r
  }
  throw new Error('backfill did not complete in 20 runs')
}

beforeAll(async () => {
  t = await startTestDb()
  const c = t.client

  await c`INSERT INTO region (code, display_name) VALUES ('url', 'Usage Rollup Region')`
  ;[{ id: regionId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='url'`
  await c`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'url'::ltree, 'url-cc', 'URL CC', 'practice', true)`
  ;[{ id: unitId }] = await c<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='url-cc'`

  const mkTeammate = async (email: string) => {
    await c`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${regionId}::uuid, ${unitId}::uuid)`
    const [r] = await c<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  tmA = await mkTeammate('a@url.test')
  tmB = await mkTeammate('b@url.test')

  // Arm 3 (ingest-only surface day + facts): fan-out + remainder.
  await c`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
      region_id, org_unit_id, cost_owning_unit_id, dimension_source)
    VALUES (${tmA}::uuid, '2026-09-06'::date, 'claude-ai', 1000, 1000, 17, 'anthropic-analytics-api',
      ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid, 'ingest-snapshot')`
  await c`INSERT INTO provider_usage_fact
      (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd,
       region_id, org_unit_id, cost_owning_unit_id)
    VALUES ('anthropic-analytics-api', 'anthropic', ${tmA}::uuid, 'a@url.test',
            '2026-09-06'::date, 'claude-ai', 'claude-haiku-4-6', 'tokens', 10,
            ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid)`

  // Arm 2 (fill day): children + shortfall remainder.
  await c`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${tmA}::uuid, ${regionId}::uuid, ${unitId}::uuid, '2026-09-07'::date, 'claude-code', 9, 18000, 'api-reconciled')`
  const [{ id: fillId }] = await c<{ id: string }[]>`
    SELECT id::text AS id FROM unaccounted_usage WHERE teammate_id=${tmA}::uuid AND day='2026-09-07'::date`
  await c`INSERT INTO unaccounted_usage_model (unaccounted_usage_id, model, cost_usd, tokens)
    VALUES (${fillId}::uuid, 'claude-sonnet-4-6', 6, 12000)`

  // Arm 1 (OTel) for tmB across two days + one conversation to quarantine later.
  instB = randomUUID()
  await c`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, cost_owning_unit_id, project_code_hash, raw_project_code)
    VALUES (${instB}::uuid, 'oid-b@url.test', ${tmB}::uuid, 'claude-code', ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid, 'h', 'P')`
  const arm1 = async (
    day: string,
    hour: number,
    conv: string,
    usd: number,
    tokens: number,
    identity: string | null = null,
  ) => {
    await c`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type,
         tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id, identity_state)
      VALUES (${instB}::uuid, ${tmB}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
              'claude-code', 'claude-sonnet-4-6', 'input', ${tokens}, ${usd}, 'tier-1', 'estimated',
              (${day}::date::timestamp AT TIME ZONE 'UTC') + make_interval(hours => ${hour}), ${conv},
              ${identity})`
  }
  await arm1('2026-09-06', 10, 'conv-url-keep', 40, 80000)
  await arm1('2026-09-06', 11, 'conv-url-keep', 5, 10000) // same conversation, second span — MUST collapse
  await arm1('2026-09-08', 10, 'conv-url-flip', 12, 24000)
  // identity_state is GRAIN since 0138: one (day, teammate, tool, model) key
  // carrying two states must land as TWO cells, and the estate must exercise
  // every live value (NULL above, plus these) so the per-state footing split
  // cannot pass vacuously.
  await arm1('2026-09-05', 9, 'conv-url-prov', 7, 14000, 'provisional')
  await arm1('2026-09-05', 10, 'conv-url-conf', 8, 16000, 'confirmed')
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('usage-rollup', () => {
  it('backfills full history and FOOTS against the view (cost, tokens, records)', async () => {
    const r = await runToComplete()
    expect(r.mode).toBe('backfill')
    const f = await footing()
    expect(f.r_usd).toBe(f.v_usd)
    expect(f.r_tok).toBe(f.v_tok)
    expect(f.r_n).toBe(f.v_n)
    // The strong form: per-(day, dims) identity, both directions.
    expect(await dimIdentityDiff()).toBe(0)
    // Completion is self-recorded (independent of run-health bookkeeping).
    const [kv] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM kv_store
      WHERE mount = 'usage-rollup' AND key = 'backfill-complete'`
    expect(kv!.n).toBe(1)
    // Arm-1 spans collapse: the two conv-url-keep records land in ONE cell.
    const [cell] = await t.client<{ record_count: number; cost_usd: string }[]>`
      SELECT record_count, cost_usd::text FROM usage_rollup_daily
      WHERE teammate_id = ${tmB}::uuid AND day = '2026-09-06'::date AND usage_provenance = 'otel-emitted'`
    expect(cell!.record_count).toBe(2)
    expect(Number(cell!.cost_usd)).toBe(45)
    // Every arm is present.
    const provs = await t.client<{ p: string }[]>`
      SELECT DISTINCT usage_provenance AS p FROM usage_rollup_daily ORDER BY 1`
    expect(provs.map((r2) => r2.p)).toEqual(['api-reconciled', 'otel-emitted', 'provider-usage'])
    // The identity_state fan-out (0138): the 2026-09-05 key is ONE cell per
    // state — a former single cell is now two rows, which is why every rollup
    // reader must re-aggregate rather than assume (day, dims) uniqueness.
    const fan = await t.client<{ identity_state: string | null; cost_usd: string }[]>`
      SELECT identity_state, cost_usd::text FROM usage_rollup_daily
      WHERE teammate_id = ${tmB}::uuid AND day = '2026-09-05'::date
        AND usage_provenance = 'otel-emitted'
      ORDER BY identity_state`
    expect(fan.map((r2) => r2.identity_state)).toEqual(['confirmed', 'provisional'])
    // The per-identity_state footing split (R5b), non-vacuous: all three live
    // values are in the estate — NULL (unstamped arm 1), 'provisional', and
    // 'confirmed' (stamped arm 1 + every arm-2/3 row, which the view projects
    // as the literal 'confirmed', NOT NULL — mig 0135).
    const states = await t.client<{ s: string | null }[]>`
      SELECT DISTINCT identity_state AS s FROM usage_rollup_daily ORDER BY 1`
    expect(states.map((r2) => r2.s)).toEqual(['confirmed', 'provisional', null])
    expect(await identityStateFootingDiff()).toBe(0)
  })

  it('a chunk-capped backfill RESUMES: incomplete first, complete later, identity holds', async () => {
    // Seed 12 MORE distinct arm-1 days (16 total in the estate) so a
    // 1-chunk (10-day) capped run genuinely leaves a remainder. Their
    // ts_recorded is now(), so the source-write signal would cover them —
    // the remainder verdict must come from the MISSING-day probe alone,
    // which is exactly what the assertions below pin.
    for (let d = 1; d <= 12; d++) {
      const day = `2026-08-${String(d).padStart(2, '0')}`
      await t.client`INSERT INTO attribution_record
          (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type,
           tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
        VALUES (${instB}::uuid, ${tmB}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
                'claude-code', 'claude-sonnet-4-6', 'input', 1000, 1, 'tier-1', 'estimated',
                (${day}::date::timestamp AT TIME ZONE 'UTC') + interval '9 hours', ${'conv-url-' + day})`
    }
    await t.client`DELETE FROM usage_rollup_daily`
    await t.client`DELETE FROM worker_run WHERE worker_name = 'usage-rollup'`
    await t.client`DELETE FROM kv_store WHERE mount = 'usage-rollup'`

    // Disable the source-write signal (retagLookbackDays: 0) so the run sees
    // ONLY the capped missing-day set — the resume contract under test.
    const first = await runUsageRollup(t.db, { maxChunksPerRun: 1, retagLookbackDays: 0 })
    expect(first.mode).toBe('backfill')
    expect(first.backfillComplete).toBe(false) // a remainder exists
    const second = await runUsageRollup(t.db, { maxChunksPerRun: 1, retagLookbackDays: 0 })
    expect(second.mode).toBe('backfill') // the incomplete first run did not flip the probe
    expect(second.backfillComplete).toBe(true)
    expect(await dimIdentityDiff()).toBe(0)
  })

  it('idempotent: an incremental run after backfill changes nothing', async () => {
    // The completing backfill run self-recorded the kv marker, so this run
    // is incremental with no further setup.
    const before = await footing()
    const r = await runUsageRollup(t.db)
    expect(r.mode).toBe('incremental')
    const after = await footing()
    expect(after).toEqual(before)
    expect(await dimIdentityDiff()).toBe(0)
  })

  it('the source-write signal ADVANCES: a day recomputed after its write drops out', async () => {
    // An old day far outside the trailing window — only the signal can reach it.
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type,
         tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${instB}::uuid, ${tmB}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
              'claude-code', 'claude-sonnet-4-6', 'input', 500, 2, 'tier-1', 'estimated',
              '2026-06-01T10:00:00Z'::timestamptz, 'conv-url-old')`
    const r = await runUsageRollup(t.db)
    expect(r.mode).toBe('incremental')
    const [cell] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM usage_rollup_daily WHERE day = '2026-06-01'::date`
    expect(cell!.n).toBe(1) // the signal reached the out-of-window day

    // Mark the day as recomputed comfortably AFTER its last source write (the
    // worker's one-minute race margin): it must DROP OUT of the signal — this
    // is what lets capped runs advance through a large restamp instead of
    // re-taking the same oldest slice forever.
    await t.client`UPDATE usage_rollup_daily
      SET refresh_at = now() + interval '2 minutes' WHERE day = '2026-06-01'::date`
    await runUsageRollup(t.db)
    const [after] = await t.client<{ fresh: boolean }[]>`
      SELECT bool_and(refresh_at > now() + interval '1 minute') AS fresh
      FROM usage_rollup_daily WHERE day = '2026-06-01'::date`
    expect(after!.fresh).toBe(true) // untouched — the day left the signal

    // And the counter-proof: stale refresh_at (before the write) keeps the day
    // a candidate, and the run refreshes it.
    await t.client`UPDATE usage_rollup_daily
      SET refresh_at = now() - interval '1 hour' WHERE day = '2026-06-01'::date`
    await runUsageRollup(t.db)
    const [again] = await t.client<{ recomputed: boolean }[]>`
      SELECT bool_and(refresh_at > now() - interval '5 minutes') AS recomputed
      FROM usage_rollup_daily WHERE day = '2026-06-01'::date`
    expect(again!.recomputed).toBe(true)
  })

  it('quarantine flip: queued teammate is recomputed, excluded rows leave, request drains', async () => {
    // The flip — retroactive, no timestamp any trailing window can see.
    await t.client`INSERT INTO session_quarantine
        (conversation_id, instance_id, teammate_id, region_id, org_unit_id,
         session_ts_start, session_ts_end, instance_ts_start, cost_usd, tokens, reason)
      VALUES ('conv-url-flip', ${instB}::uuid, ${tmB}::uuid, ${regionId}::uuid, ${unitId}::uuid,
              '2026-09-08T00:00:00Z'::timestamptz, '2026-09-08T01:00:00Z'::timestamptz,
              '2026-09-01T00:00:00Z'::timestamptz, 12, 24000, 'api-uncorroborated')`
    await t.client`INSERT INTO usage_rollup_refresh (teammate_id) VALUES (${tmB}::uuid)
      ON CONFLICT (teammate_id) DO UPDATE SET requested_at = now()`

    const r = await runUsageRollup(t.db)
    expect(r.refreshedTeammates).toBe(1)

    // The flipped conversation's day is gone from the rollup…
    const [gone] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM usage_rollup_daily
      WHERE teammate_id = ${tmB}::uuid AND day = '2026-09-08'::date`
    expect(gone!.n).toBe(0)
    // …the kept day survives, footing still holds, and the queue is drained.
    const f = await footing()
    expect(f.r_usd).toBe(f.v_usd)
    expect(f.r_n).toBe(f.v_n)
    const [q] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM usage_rollup_refresh`
    expect(q!.n).toBe(0)
  })

  it('a request from a SLOW writer is not consumed by a drain that never did its work', async () => {
    /*
     * The durability the read gate depends on, and the way it was broken.
     *
     * The drain deleted every request at-or-before the stamp it read, and
     * enqueues stamped now() -- which PostgreSQL evaluates at TRANSACTION
     * START. A writer whose transaction opened before the queue was captured
     * therefore stamped its request with an instant from before the capture,
     * and the upsert overwrote unconditionally, so the stamp could move
     * BACKWARD. The drain then deleted a request whose work it had never done,
     * and the rollup stayed wrong until the next daily wide sweep.
     *
     * Reproduced with a real long transaction rather than a simulated one,
     * because the whole defect lives in the difference between transaction
     * time and statement time.
     *
     * Two cases below. The first is the wall-clock one: transaction-start
     * now() stamps an instant from before the capture. The second is the one
     * that survives switching to statement_timestamp() -- a statement that
     * BEGAN before the capture leaves GREATEST() returning the captured value
     * unchanged, so the stamp has to advance strictly, not merely be current.
     */
    let captured = ''
    await t.client.begin(async (tx) => {
      // The slow writer's transaction opens HERE: its now() is pinned to this
      // instant for everything it does below.
      await tx`SELECT 1`

      // Meanwhile, on another connection, a request lands and a run captures it.
      await t.client`INSERT INTO usage_rollup_refresh (teammate_id, requested_at)
        VALUES (${tmB}::uuid, statement_timestamp())`
      const [row] = await t.client<{ at: string }[]>`
        SELECT requested_at::text AS at FROM usage_rollup_refresh
         WHERE teammate_id = ${tmB}::uuid`
      captured = row!.at

      // The slow writer now enqueues its own invalidation — the production
      // idiom, whose stamp must land AFTER the capture despite this
      // transaction having started before it.
      await tx`INSERT INTO usage_rollup_refresh (teammate_id, requested_at)
        VALUES (${tmB}::uuid, statement_timestamp())
        ON CONFLICT (teammate_id) DO UPDATE
          SET requested_at = GREATEST(
                usage_rollup_refresh.requested_at + interval '1 microsecond',
                statement_timestamp())`
    })

    const [stored] = await t.client<{ at: string }[]>`
      SELECT requested_at::text AS at FROM usage_rollup_refresh WHERE teammate_id = ${tmB}::uuid`
    expect(
      stored!.at > captured,
      'the slow writer stamped its request at or before the capture — the drain will eat it',
    ).toBe(true)

    // The drain, deleting exactly what the run captured.
    await t.client`DELETE FROM usage_rollup_refresh
       WHERE teammate_id = ${tmB}::uuid AND requested_at = ${captured}::timestamptz`
    const [left] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM usage_rollup_refresh WHERE teammate_id = ${tmB}::uuid`
    expect(left!.n, 'the slow writer\'s invalidation was consumed by a drain that never did its work').toBe(1)

    await t.client`DELETE FROM usage_rollup_refresh WHERE teammate_id = ${tmB}::uuid`
  })
})

/*
 * O5 (performance-observability-baseline.md): steady state narrows to
 * NARROW_REFRESH_DAYS, with ONE wide (REFRESH_DAYS) pass per UTC day gated on
 * the worker-owned 'wide-through' kv marker. dr-H5 pins the two crash-safety
 * halves: the marker is written only after every wide chunk committed, and an
 * EMPTY table forces backfill regardless of any completion marker.
 *
 * These tests run in file order and inherit the footed estate + the
 * 'backfill-complete' marker from the suite above. The gate is driven through
 * opts (wideHourUtc / forceWide), never by mocking Date — the worker reads its
 * own SQL clock.
 */
describe('usage-rollup — narrow steady state + the daily wide pass (O5)', () => {
  const wideThroughCount = async (): Promise<number> => {
    const [row] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM kv_store
      WHERE mount = 'usage-rollup' AND key = 'wide-through'`
    return row!.n
  }

  it('narrow: an incremental run with the gate closed recomputes only the 3-day window', async () => {
    // wideHourUtc: 24 is unreachable (EXTRACT(HOUR ...) tops at 23), so the
    // gate stays closed no matter when this runs. Signals isolated via
    // retagLookbackDays: 0 (the established pattern in this file).
    const r = await runUsageRollup(t.db, { wideHourUtc: 24, retagLookbackDays: 0 })
    expect(r.mode).toBe('incremental')
    expect(r.wide).toBe(false)
    expect(r.daysRecomputed).toBe(NARROW_REFRESH_DAYS + 1) // today + 2 prior, nothing else
  })

  it('wide pass: marker absent + hour reached → 41-day window, marker stamped; second run narrow', async () => {
    await t.client`DELETE FROM kv_store WHERE mount = 'usage-rollup' AND key = 'wide-through'`
    const wideRun = await runUsageRollup(t.db, { wideHourUtc: 0, retagLookbackDays: 0 })
    expect(wideRun.mode).toBe('incremental')
    expect(wideRun.wide).toBe(true)
    expect(wideRun.daysRecomputed).toBe(REFRESH_DAYS + 1) // the full wide window

    // The marker records the SQL clock's UTC day the wide pass covered.
    const [kv] = await t.client<{ current: boolean }[]>`
      SELECT (value = ((now() AT TIME ZONE 'UTC')::date)::text) AS current
      FROM kv_store WHERE mount = 'usage-rollup' AND key = 'wide-through'`
    expect(kv).toBeTruthy()
    expect(kv!.current).toBe(true)

    // Same UTC day, gate open again — the marker is current, so NOT wide.
    const second = await runUsageRollup(t.db, { wideHourUtc: 0, retagLookbackDays: 0 })
    expect(second.wide).toBe(false)
    expect(second.daysRecomputed).toBe(NARROW_REFRESH_DAYS + 1)

    // The wide recompute is an identity over already-footed days.
    expect(await dimIdentityDiff()).toBe(0)
  })

  it('mid-wide crash: a throwing chunk leaves the marker UNWRITTEN; the re-run writes it (dr-H5)', async () => {
    // A data day inside the wide window but OUTSIDE the narrow one, so only a
    // wide pass re-INSERTs it — the poisoned insert below is what "a chunk
    // crashed mid-wide" looks like from the marker's point of view.
    // ONE anchor day for insert and trigger alike — two now() reads straddling
    // UTC midnight would poison a different day than the one inserted.
    const [{ anchor: crashAnchor }] = await t.client<{ anchor: string }[]>`
      SELECT ((now() AT TIME ZONE 'UTC')::date - 5)::text AS anchor`
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type,
         tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${instB}::uuid, ${tmB}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
              'claude-code', 'claude-sonnet-4-6', 'input', 700, 3, 'tier-1', 'estimated',
              (${crashAnchor}::date::timestamp AT TIME ZONE 'UTC') + interval '9 hours',
              'conv-url-wide-crash')`
    await t.client.unsafe(`CREATE FUNCTION url_poison() RETURNS trigger AS $$
      BEGIN
        IF NEW.day = '${crashAnchor}'::date THEN
          RAISE EXCEPTION 'poisoned chunk (test)';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`)
    await t.client`CREATE TRIGGER url_poison_trg BEFORE INSERT ON usage_rollup_daily
      FOR EACH ROW EXECUTE FUNCTION url_poison()`
    await t.client`DELETE FROM kv_store WHERE mount = 'usage-rollup' AND key = 'wide-through'`
    try {
      // Drizzle wraps the PG error ('Failed query: …'); the raw RAISE is the cause.
      const crashed = await runUsageRollup(t.db, { forceWide: true, retagLookbackDays: 0 }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(crashed).toBeTruthy()
      expect(String((crashed as { cause?: unknown }).cause ?? crashed)).toContain('poisoned chunk')
      // The crashed wide run must NOT have sealed the day: absent marker means
      // the next gated run re-runs wide.
      expect(await wideThroughCount()).toBe(0)
    } finally {
      await t.client`DROP TRIGGER url_poison_trg ON usage_rollup_daily`
      await t.client`DROP FUNCTION url_poison()`
    }

    // Healed: the re-run completes every wide chunk and only NOW writes it.
    const retry = await runUsageRollup(t.db, { forceWide: true, retagLookbackDays: 0 })
    expect(retry.wide).toBe(true)
    expect(await wideThroughCount()).toBe(1)
    expect(await dimIdentityDiff()).toBe(0)
  })

  it('empty-table probe: TRUNCATE forces backfill despite BOTH markers, clears them, rebuilds (dr-H5)', async () => {
    // Both markers present and claiming completion…
    const [pre] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM kv_store
      WHERE mount = 'usage-rollup' AND key IN ('backfill-complete', 'wide-through')`
    expect(pre!.n).toBe(2)
    // …yet the table is empty (the truncate/restore scenario, and the
    // documented reset runbook).
    await t.client`TRUNCATE usage_rollup_daily`

    // Capped so this run cannot COMPLETE the backfill (which would re-record
    // 'backfill-complete'): the probe's verdict + cleanup observable alone.
    const first = await runUsageRollup(t.db, { maxChunksPerRun: 1, retagLookbackDays: 0 })
    expect(first.mode).toBe('backfill')
    expect(first.backfillComplete).toBe(false)
    expect(first.wide).toBe(false) // the wide gate never applies to backfill
    const [cleared] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM kv_store
      WHERE mount = 'usage-rollup' AND key IN ('backfill-complete', 'wide-through')`
    expect(cleared!.n).toBe(0)

    // Resumed to completion, the table rebuilds and foots against the view.
    const done = await runToComplete({ maxChunksPerRun: 1, retagLookbackDays: 0 })
    expect(done.mode).toBe('backfill')
    expect(await dimIdentityDiff()).toBe(0)
    const f = await footing()
    expect(f.r_usd).toBe(f.v_usd)
    expect(f.r_tok).toBe(f.v_tok)
    expect(f.r_n).toBe(f.v_n)
  })
})

/*
 * R5b transition requirement (usage-rollup-lane.md R5b.1, design-check HIGH):
 * a provisional → confirmed identity flip on history OLDER than every trailing
 * window must re-present the affected days, or the provisional cell survives
 * beside the confirmed one indefinitely. The wiring under test is
 * confirm-instance.ts step 2b: the SAME UPDATE that flips
 * attribution_record.identity_state bumps ts_recorded = now(), which the
 * worker's source-write signal keys on (dr-H4) — no refresh-queue row is
 * involved. Exercised through the REAL confirm flow, never a hand-rolled
 * UPDATE, so dropping the ts_recorded bump from the merge fails HERE.
 */
describe('usage-rollup — identity-state restate (R5b)', () => {
  it('confirming an old-day enrolment: the provisional cell leaves; exactly one cell remains, the confirmed one', async () => {
    const { confirmProvisionalInstance } = await import('../../../server/auth/confirm-instance')

    // The pre-confirm state the enroll path produces: a provisional SHADOW
    // teammate owning one provisional instance claiming tmA's email, with
    // attributed history 60 days back — outside REFRESH_DAYS (40), so only
    // the source-write signal can reach the day.
    const shadowOid = `provisional:${randomUUID()}`
    // ONE anchor day for every insert and assertion — repeated now() reads
    // straddling UTC midnight would query a different day than was inserted.
    const [{ anchor }] = await t.client<{ anchor: string }[]>`
      SELECT ((now() AT TIME ZONE 'UTC')::date - 60)::text AS anchor`
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, provisional)
      VALUES (${shadowOid}, 'a@url.test', 'shadow of a', ${regionId}::uuid, ${unitId}::uuid, true)`
    const [{ id: shadowId }] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM teammate WHERE entra_oid = ${shadowOid}`
    const instanceId = randomUUID()
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id,
         identity_state, claimed_email, project_code_hash, raw_project_code)
      VALUES (${instanceId}::uuid, ${shadowOid}, ${shadowId}::uuid, 'claude-code',
              ${regionId}::uuid, ${unitId}::uuid, 'provisional', 'a@url.test', 'h', 'P')`
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type,
         tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id, identity_state)
      VALUES (${instanceId}::uuid, ${shadowId}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
              'claude-code', 'claude-sonnet-4-6', 'input', 900, 4, 'tier-1', 'estimated',
              (${anchor}::date::timestamp AT TIME ZONE 'UTC') + interval '9 hours',
              'conv-url-restate', 'provisional')`

    // The insert's own ts_recorded (now) puts the 60-day-old day on the
    // signal: the provisional cell materialises under the SHADOW teammate.
    await runUsageRollup(t.db)
    const before = await t.client<{ identity_state: string | null; teammate_id: string }[]>`
      SELECT identity_state, teammate_id::text AS teammate_id FROM usage_rollup_daily
      WHERE day = ${anchor}::date`
    expect(before.length).toBe(1)
    expect(before[0]!.identity_state).toBe('provisional')
    expect(before[0]!.teammate_id).toBe(shadowId)

    // Age the fixture's own write instant OUT of the signal lookback, then
    // prove the day is unreachable: without this, the insert's ts_recorded
    // (minutes old) would carry the restate all by itself and the confirm's
    // ts_recorded bump — the wiring under test — could be deleted without
    // this test noticing (proven: the un-aged version stayed green with the
    // bump removed).
    await t.client`UPDATE attribution_record SET ts_recorded = now() - interval '30 days'
      WHERE claude_session_id = 'conv-url-restate'`
    await runUsageRollup(t.db)
    const unreachable = await t.client<{ identity_state: string | null }[]>`
      SELECT identity_state FROM usage_rollup_daily
      WHERE day = ${anchor}::date`
    expect(unreachable.length).toBe(1)
    expect(unreachable[0]!.identity_state).toBe('provisional') // out of every window + signal

    // The REAL merge: flips identity_state, re-points the teammate AND bumps
    // ts_recorded in one UPDATE (confirm-instance.ts step 2b) — now the ONLY
    // path that can put the day back on the signal.
    await confirmProvisionalInstance(t.db as never, {
      realTeammateId: tmA,
      realTeammateEmail: 'a@url.test',
      instanceId,
    })

    // The bump re-presents the day: exactly ONE cell for that grain — the
    // confirmed one, under the real teammate — and the provisional cell GONE.
    await runUsageRollup(t.db)
    const after = await t.client<{ identity_state: string | null; teammate_id: string }[]>`
      SELECT identity_state, teammate_id::text AS teammate_id FROM usage_rollup_daily
      WHERE day = ${anchor}::date`
    expect(after.length).toBe(1)
    expect(after[0]!.identity_state).toBe('confirmed')
    expect(after[0]!.teammate_id).toBe(tmA)
    // The whole estate still foots per (day, dims, identity_state).
    expect(await dimIdentityDiff()).toBe(0)
    expect(await identityStateFootingDiff()).toBe(0)
  })
})

/*
 * R5b.4 residual, pinned: a retroactive mutation spanning MORE days than the
 * per-run chunk cap (maxChunksPerRun * CHUNK_DAYS) converges across successive
 * ticks, not within one cadence — run N recomputes the oldest capped slice and
 * leaves a remainder, run N+1 clears it, and the final state foots against the
 * view. The cap and the one-minute freshness margin are both DELIBERATE (the
 * cap bounds a run inside the dispatch budget; the margin guards same-minute
 * write misses) — what this test proves is the ADVANCE property that makes a
 * capped run converge: a recomputed day drops OUT of the signal, so the next
 * run takes the remainder instead of re-taking the same slice.
 *
 * Production ticks are 15 minutes apart, so by the first post-confirm tick the
 * margin is already history. Successive in-test runs are milliseconds apart,
 * which would add the margin's extra re-take pass; the test compresses real
 * elapsed time by aging the confirm's WRITE INSTANT two minutes — never by
 * weakening the margin — so the runs exercise the cap remainder, the thing
 * under test.
 */
describe('usage-rollup — a mass identity confirmation exceeding the per-run cap converges across runs (R5b.4)', () => {
  it('confirm spanning 12 days at cap 10: run 1 leaves a 2-day provisional remainder, run 2 clears it', async () => {
    const { confirmProvisionalInstance } = await import('../../../server/auth/confirm-instance')

    // A real teammate + a shadow claiming their email, with attributed history
    // on 12 DISTINCT days ~200 days back — the oldest days in the estate, so
    // the oldest-first cap deterministically takes them before anything else.
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
      VALUES ('oid-c@url.test', 'c@url.test', 'c@url.test', ${regionId}::uuid, ${unitId}::uuid)`
    const [{ id: tmC }] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM teammate WHERE email = 'c@url.test'`
    const shadowOid = `provisional:${randomUUID()}`
    // ONE anchor for the 12-day span — see the restate test's midnight note.
    const [{ span0 }] = await t.client<{ span0: string }[]>`
      SELECT ((now() AT TIME ZONE 'UTC')::date - 200)::text AS span0`
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, provisional)
      VALUES (${shadowOid}, 'c@url.test', 'shadow of c', ${regionId}::uuid, ${unitId}::uuid, true)`
    const [{ id: shadowId }] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM teammate WHERE entra_oid = ${shadowOid}`
    const instanceId = randomUUID()
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id,
         identity_state, claimed_email, project_code_hash, raw_project_code)
      VALUES (${instanceId}::uuid, ${shadowOid}, ${shadowId}::uuid, 'claude-code',
              ${regionId}::uuid, ${unitId}::uuid, 'provisional', 'c@url.test', 'h', 'P')`
    for (let i = 0; i < 12; i++) {
      await t.client`INSERT INTO attribution_record
          (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type,
           tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id, identity_state)
        VALUES (${instanceId}::uuid, ${shadowId}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
                'claude-code', 'claude-sonnet-4-6', 'input', 1000, 5, 'tier-1', 'estimated',
                ((${span0}::date + ${i}::int)::timestamp AT TIME ZONE 'UTC') + interval '9 hours',
                ${'conv-url-mass-' + i}, 'provisional')`
    }
    const spanCells = () =>
      t.client<{ day: string; identity_state: string | null; teammate_id: string }[]>`
        SELECT day::text AS day, identity_state, teammate_id::text AS teammate_id
        FROM usage_rollup_daily
        WHERE day >= ${span0}::date
          AND day <= ${span0}::date + 11
        ORDER BY day`

    // Materialise the provisional cells (the inserts' own ts_recorded carries
    // the 12 days onto the signal; default cap 80 covers them in one run)…
    await runUsageRollup(t.db)
    const before = await spanCells()
    expect(before.length).toBe(12)
    expect(new Set(before.map((r) => r.identity_state))).toEqual(new Set(['provisional']))
    // …then age the seed writes out of the 2-day signal lookback, so from here
    // the ONLY thing that can re-present these days is the confirm's bump.
    await t.client`UPDATE attribution_record SET ts_recorded = now() - interval '30 days'
      WHERE instance_id = ${instanceId}::uuid`

    // The REAL merge bumps ts_recorded = now() on all 12 days in one UPDATE.
    await confirmProvisionalInstance(t.db as never, {
      realTeammateId: tmC,
      realTeammateEmail: 'c@url.test',
      instanceId,
    })
    // Compress elapsed time, preserving the REAL ordering refresh_at < write
    // < run: the write instant moves 2 minutes into the past (still far
    // inside the lookback), standing in for the >= 15 min that separates a
    // confirm from the tick after next in production, and the cells' own
    // refresh_at moves BEHIND it — in production those stamps pre-date the
    // confirm by construction; in-test the materialisation ran milliseconds
    // before it, which the margin would otherwise read as already-recomputed.
    await t.client`UPDATE attribution_record SET ts_recorded = now() - interval '2 minutes'
      WHERE instance_id = ${instanceId}::uuid`
    await t.client`UPDATE usage_rollup_daily SET refresh_at = now() - interval '10 minutes'
      WHERE day >= ${span0}::date
        AND day <= ${span0}::date + 11`

    // Run 1 at cap 10 (maxChunksPerRun 1 × CHUNK_DAYS 10): the oldest 10 of
    // the 12 affected days restate; 2 remain provisional — the remainder the
    // one-cadence claim does NOT cover (usage-rollup-lane.md R5b.4).
    const run1 = await runUsageRollup(t.db, { maxChunksPerRun: 1 })
    expect(run1.mode).toBe('incremental')
    const mid = await spanCells()
    expect(mid.length).toBe(12)
    expect(mid.filter((r) => r.identity_state === 'confirmed').length).toBe(10)
    expect(mid.filter((r) => r.identity_state === 'provisional').length).toBe(2)
    // The remainder is the two NEWEST days — the cap takes oldest first.
    expect(mid.slice(0, 10).every((r) => r.identity_state === 'confirmed')).toBe(true)

    // Run 2: the recomputed days dropped OUT of the signal (refresh_at is now
    // past write + 1 min), so the capped slice takes the remainder — converged.
    const run2 = await runUsageRollup(t.db, { maxChunksPerRun: 1 })
    expect(run2.mode).toBe('incremental')
    const after = await spanCells()
    expect(after.length).toBe(12)
    expect(after.every((r) => r.identity_state === 'confirmed')).toBe(true)
    expect(after.every((r) => r.teammate_id === tmC)).toBe(true)
    // Footing-equal end state: the whole estate agrees with the view again.
    expect(await dimIdentityDiff()).toBe(0)
    expect(await identityStateFootingDiff()).toBe(0)
  })
})

/*
 * FIX B (0138 arbiter agreement): the grain index maps NULL and '' identity
 * states onto ONE COALESCE bucket, and attribution_record carries no CHECK on
 * the column — so the aggregation boundary (cellsSelect, the 0138 reseed) must
 * collapse them via NULLIF before the upsert. Without it, two same-statement
 * cells hit one arbiter key: index creation aborts on the reseed, and a worker
 * upsert raises a cardinality violation (or lets the second cell overwrite the
 * first).
 *
 * This estate seeds a real '' row, so it runs LAST: every earlier test's
 * expectations predate the value existing.
 */
describe('usage-rollup — NULL and empty-string identity_state collapse to ONE cell (0138 arbiter agreement)', () => {
  it('two source rows identical in all dims except NULL vs empty-string land as a single NULL-state cell', async () => {
    // Same instance, teammate, day and every grain dim — only identity_state
    // differs (NULL vs ''), which the arbiter cannot tell apart.
    const day = '2026-03-15'
    for (const [conv, identity] of [
      ['conv-url-nullif-a', null],
      ['conv-url-nullif-b', ''],
    ] as const) {
      await t.client`INSERT INTO attribution_record
          (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type,
           tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id, identity_state)
        VALUES (${instB}::uuid, ${tmB}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid,
                'claude-code', 'claude-sonnet-4-6', 'input', 2000, 6, 'tier-1', 'estimated',
                (${day}::date::timestamp AT TIME ZONE 'UTC') + interval '9 hours', ${conv}, ${identity})`
    }

    // The inserts' ts_recorded puts the day on the signal; the run recomputes it.
    await runUsageRollup(t.db)
    const cells = await t.client<
      { identity_state: string | null; record_count: number; cost_usd: string }[]
    >`
      SELECT identity_state, record_count, cost_usd::text
      FROM usage_rollup_daily WHERE day = ${day}::date`
    expect(cells.length).toBe(1) // ONE cell, not an error and not two
    expect(cells[0]!.identity_state).toBeNull() // '' normalised to NULL
    expect(cells[0]!.record_count).toBe(2)
    expect(Number(cells[0]!.cost_usd)).toBe(12)
    // The NULLIF-normalised footing still holds across the whole estate.
    expect(await dimIdentityDiff()).toBe(0)
    expect(await identityStateFootingDiff()).toBe(0)
  })

  it('a stamp fixed BEFORE the capture still advances past it', async () => {
    /*
     * The case a "use statement time" fix does not reach on its own.
     *
     * statement_timestamp() is fixed when the enqueue statement STARTS. A
     * statement that began before the queue was captured, then blocked and
     * committed after the recompute, carries an instant older than the capture
     * — and GREATEST(existing, that) returns the captured value UNCHANGED. The
     * drain's equality delete then matches, and consumes work the recompute
     * never saw.
     *
     * Simulated by handing the upsert a deliberately stale instant, which is
     * exactly what such a statement supplies.
     */
    await t.client`INSERT INTO usage_rollup_refresh (teammate_id, requested_at)
      VALUES (${tmB}::uuid, statement_timestamp())`
    const [captured] = await t.client<{ at: string }[]>`
      SELECT requested_at::text AS at FROM usage_rollup_refresh WHERE teammate_id = ${tmB}::uuid`

    await t.client`INSERT INTO usage_rollup_refresh (teammate_id, requested_at)
      VALUES (${tmB}::uuid, ${captured!.at}::timestamptz - interval '5 seconds')
      ON CONFLICT (teammate_id) DO UPDATE
        SET requested_at = GREATEST(
              usage_rollup_refresh.requested_at + interval '1 microsecond',
              ${captured!.at}::timestamptz - interval '5 seconds')`

    const [after] = await t.client<{ at: string }[]>`
      SELECT requested_at::text AS at FROM usage_rollup_refresh WHERE teammate_id = ${tmB}::uuid`
    expect(
      after!.at > captured!.at,
      'a re-request with a stale statement time left the stamp at the captured value',
    ).toBe(true)

    await t.client`DELETE FROM usage_rollup_refresh
       WHERE teammate_id = ${tmB}::uuid AND requested_at = ${captured!.at}::timestamptz`
    const [left] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM usage_rollup_refresh WHERE teammate_id = ${tmB}::uuid`
    expect(left!.n, 'the drain consumed a request whose work it never did').toBe(1)
    await t.client`DELETE FROM usage_rollup_refresh WHERE teammate_id = ${tmB}::uuid`
  })
})
