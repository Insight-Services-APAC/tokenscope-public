/*
 * buildUsageRollup / rebuildUsageRollup — TEST-ONLY materialisation of
 * `usage_rollup_daily` (mig 0136) for the report integration suites.
 *
 * The region reports' §A fetchers read the rollup, not the live view
 * (docs/design/usage-rollup-lane.md R5), so a suite that seeds the raw §A
 * tables and then calls a region endpoint would read an EMPTY rollup unless it
 * runs the worker after seeding (design R8: "their seeds now run the rollup
 * worker once in setup — a shared helper — which is itself the proof the swap
 * changed no figure").
 *
 * `buildUsageRollup` drives the REAL worker (server/workers/usage-rollup.ts) to
 * completion. `worker_run` is empty under direct calls (only the dispatch
 * harness writes it), so every run stays in BACKFILL mode; backfill resumes by
 * day-existence, so looping to `backfillComplete` materialises every
 * `v_complete_usage` day exactly once. Call it in `beforeAll`, AFTER all
 * seeding.
 *
 * `rebuildUsageRollup` is for suites that MUTATE §A data mid-test (a re-tag, a
 * fresh insert between assertions): backfill-mode resume treats "day has rollup
 * rows" as "day is done", so a plain re-run would SKIP a mutated day. The
 * rebuild clears the materialised days and the worker's completion probe, then
 * rebuilds from scratch — correct for tests, where the estate is tiny. It is
 * NOT a production pattern: production retro-mutations go through the
 * `usage_rollup_refresh` queue (design R4).
 */
import { sql } from 'drizzle-orm'
import { runUsageRollup } from '../../../server/workers/usage-rollup'
import type { TestDb } from './db'

/** Safety valve only — each pass materialises >= 80 days, far beyond any fixture. */
const MAX_PASSES = 50

/** Run the usage-rollup worker to completion against the suite's db handle. */
export async function buildUsageRollup(db: TestDb['db']): Promise<void> {
  await ageSourceWrites(db)
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const result = await runUsageRollup(db)
    if (result.backfillComplete) return
  }
  throw new Error(`usage rollup backfill did not complete within ${MAX_PASSES} passes`)
}

/**
 * Put the fixture's §A writes BEFORE the build, which in production they always
 * are and in a fixture they never are.
 *
 * Both the worker's stale signal and the read-side coverage gate require
 * `refresh_at >= last_write + 1 minute` — a margin against the race where a
 * source write commits inside a recompute transaction that did not see it. A
 * fixture seeds its §A rows and builds the rollup in the same second, so every
 * day it materialises is by that rule still stale, the read gate never opens,
 * and a suite written to exercise the rollup lane quietly exercises the
 * fallback instead. That is the failure this helper existed to prevent.
 *
 * Ageing the WRITES is the shape that stays honest. Stamping `refresh_at`
 * forward would also open the gate, and would keep it open over a write made
 * later in the test — masking exactly the lag the gate is there to catch, which
 * `me-usage-golden.test.ts` asserts on. Only writes already in the ground when
 * the rollup was built are moved; anything a test inserts afterwards is a
 * genuinely late write and is treated as one.
 *
 * Ten minutes: comfortably past the one-minute margin, and well inside the
 * worker's own two-day write lookback, so nothing here can age out of the
 * signal it is meant to be part of.
 */
async function ageSourceWrites(db: TestDb['db']): Promise<void> {
  const back = sql`interval '10 minutes'`
  await db.execute(sql`UPDATE attribution_record SET ts_recorded = ts_recorded - ${back}`)
  await db.execute(sql`UPDATE actual_spend SET pulled_at = pulled_at - ${back}`)
  await db.execute(sql`UPDATE provider_usage_fact SET pulled_at = pulled_at - ${back}`)
  await db.execute(sql`UPDATE reconciliation_record SET computed_at = computed_at - ${back}`)
  await db.execute(sql`UPDATE unaccounted_usage
      SET computed_at = computed_at - ${back},
          tagged_at = tagged_at - ${back}`)
}

/**
 * Clear and rebuild the rollup after a MID-TEST §A mutation (see the header for
 * why a plain re-run is not enough). Deleting the `worker_run` completion rows
 * keeps a dispatch-harness-driven suite in backfill mode too.
 */
export async function rebuildUsageRollup(db: TestDb['db']): Promise<void> {
  await db.execute(sql`DELETE FROM usage_rollup_daily`)
  await db.execute(sql`DELETE FROM worker_run WHERE worker_name = 'usage-rollup'`)
  // The worker also self-records completion in kv_store (independent of
  // run-health bookkeeping) — clear it or the rebuild runs incremental.
  await db.execute(sql`DELETE FROM kv_store WHERE mount = 'usage-rollup'`)
  await buildUsageRollup(db)
}
