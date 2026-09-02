// @vitest-environment node
/*
 * The rollup coverage gate.
 *
 * This is the only thing standing between a stalled rollup worker and a money
 * figure that is quietly too low, so every way of being unsafe gets its own
 * case. A gate that is merely usually right is worse than no gate: it moves the
 * failure from "obviously broken" to "plausible and wrong".
 *
 * Each condition is tested by REMOVING it from an otherwise-open state, so a
 * red here names the exact condition that stopped mattering.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  resolveRollupGate,
  resolveRollupCoverage,
  resolveRollupGates,
  MAX_RUN_AGE_MINUTES,
} from '../../../server/usage/rollup-gate'
import { REFRESH_DAYS } from '../../../server/workers/usage-rollup'
import { SOURCE_WRITE_TABLES } from '../../../server/usage/source-writes'

let t: TestDb

const TEAMMATE = '9a1e0000-0000-4000-8000-0000000000f1'
/** A colleague, to prove the currency check is scoped to the reader. */
const OTHER = '9a1e0000-0000-4000-8000-0000000000f2'
const REGION = '9a1e0000-0000-4000-8000-00000000000a'
const UNIT = '9a1e0000-0000-4000-8000-00000000000b'
const INSTANCE = '9a1e0000-0000-4000-8000-00000000000c'
const PROJECT = '9a1e0000-0000-4000-8000-00000000000d'
const NOW_ISO = '2026-05-15T12:00:00.000Z'
const TODAY = '2026-05-15'
/** Well inside the sweep horizon. */
const WINDOW_START = '2026-05-01T00:00:00.000Z'

async function setMarkers(opts: {
  backfill?: boolean
  wideThrough?: string | null
  runMinutesAgo?: number | null
}) {
  await t.client`DELETE FROM kv_store WHERE mount = 'usage-rollup'`
  await t.client`DELETE FROM worker_run WHERE worker_name = 'usage-rollup'`
  if (opts.backfill !== false) {
    await t.client`INSERT INTO kv_store (mount, key, value) VALUES ('usage-rollup','backfill-complete', now()::text)`
  }
  if (opts.wideThrough !== null) {
    await t.client`INSERT INTO kv_store (mount, key, value)
      VALUES ('usage-rollup','wide-through', ${opts.wideThrough ?? TODAY})`
  }
  if (opts.runMinutesAgo !== null) {
    await t.client`INSERT INTO worker_run (worker_name, status, started_at)
      VALUES ('usage-rollup','success', now() - (${String(opts.runMinutesAgo ?? 1)} || ' minutes')::interval)`
  }
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  // The currency check reads §A source tables, which are teammate-scoped, so
  // the two readers need a home. Nothing here depends on the org shape.
  await t.client`INSERT INTO region (id, code, display_name)
    VALUES (${REGION}::uuid, 'gate-test', 'Gate Test') ON CONFLICT (id) DO NOTHING`
  await t.client`INSERT INTO org_unit
      (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${UNIT}::uuid, ${REGION}::uuid, 'gatetest'::ltree, 'gate-test', 'Gate Test',
            'business_unit', true) ON CONFLICT (id) DO NOTHING`
  for (const [id, tag] of [[TEAMMATE, 'me'], [OTHER, 'other']] as const) {
    await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id)
      VALUES (${id}::uuid, ${'oid-gate-' + tag}, ${'gate-' + tag + '@example.test'},
              ${'Gate ' + tag}, ${REGION}::uuid, ${UNIT}::uuid)
      ON CONFLICT (id) DO NOTHING`
  }
  // The attribution arm's FKs. Nothing here is under test; it exists so a row
  // can legally land in the primary lane.
  await t.client`INSERT INTO instance_attestation
      (instance_id, principal_oid, teammate_id, project_code_hash, tool,
       session_token_hash, region_id, org_unit_id, cost_owning_unit_id)
    VALUES (${INSTANCE}::uuid, 'oid-gate-me', ${TEAMMATE}::uuid, 'gate-hash', 'claude-code',
            'gate-token-hash', ${REGION}::uuid, ${UNIT}::uuid, ${UNIT}::uuid)
    ON CONFLICT (instance_id) DO NOTHING`
  await t.client`INSERT INTO project
      (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES (${PROJECT}::uuid, 'P-GATE', 'gate-hash', 'Gate Project', 'billable',
            ${REGION}::uuid, ${UNIT}::uuid)
    ON CONFLICT (id) DO NOTHING`
}, 300_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await setMarkers({})
  /*
   * EVERY source table, not just the two the first cases used. A write left
   * behind by one case keeps the gate shut for the next, which its own "must be
   * OPEN" precondition then reports — that is how this list came to be complete.
   */
  const mine = [TEAMMATE, OTHER]
  await t.client`DELETE FROM usage_rollup_refresh WHERE teammate_id = ANY(${mine}::uuid[])`
  await t.client`DELETE FROM usage_rollup_daily WHERE teammate_id = ANY(${mine}::uuid[])`
  await t.client`DELETE FROM unaccounted_usage WHERE teammate_id = ANY(${mine}::uuid[])`
  await t.client`DELETE FROM attribution_record WHERE teammate_id = ANY(${mine}::uuid[])`
  await t.client`DELETE FROM actual_spend WHERE teammate_id = ANY(${mine}::uuid[])`
  await t.client`DELETE FROM provider_usage_fact WHERE teammate_id = ANY(${mine}::uuid[])`
  await t.client`DELETE FROM reconciliation_record WHERE teammate_id = ANY(${mine}::uuid[])`
})

describe('resolveRollupGate', () => {
  it('OPENS when coverage is provable — otherwise the split is dead code', async () => {
    // Asserted first and deliberately: a gate that never opens would make every
    // other case below pass while the optimisation did nothing.
    const gate = await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE)
    expect(gate).not.toBeNull()
    expect(gate!.todayUtc).toBe(TODAY)
    // The rollup owns up to YESTERDAY; today is always live.
    expect(gate!.settledThrough).toBe('2026-05-14')
  })

  it('CLOSES when the backfill never completed', async () => {
    await setMarkers({ backfill: false })
    expect(await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE)).toBeNull()
  })

  it('CLOSES when no wide sweep is recorded', async () => {
    await setMarkers({ wideThrough: null })
    expect(await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE)).toBeNull()
  })

  it('CLOSES when the last wide sweep is older than a day', async () => {
    await setMarkers({ wideThrough: '2026-05-13' })
    expect(await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE)).toBeNull()
  })

  it('stays OPEN when the sweep ran yesterday — the pre-03:00-UTC window', async () => {
    // The sweep runs at/after 03:00 UTC. Demanding today's date would close the
    // gate for the first three hours of every day for no reason.
    await setMarkers({ wideThrough: '2026-05-14' })
    expect(await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE)).not.toBeNull()
  })

  it('CLOSES when the worker has not succeeded recently — the stalled-worker case', async () => {
    /*
     * THE CONDITION A FIRST DRAFT OMITTED. Both markers above can read healthy
     * while the worker is dead: they record what was true when the sweep
     * finished, so a worker that dies immediately afterwards leaves them intact
     * until the next UTC day. Without this the page would serve confidently
     * stale money for hours.
     */
    await setMarkers({ runMinutesAgo: MAX_RUN_AGE_MINUTES + 5 })
    expect(await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE)).toBeNull()
  })

  it('CLOSES when there is no successful run at all', async () => {
    await setMarkers({ runMinutesAgo: null })
    expect(await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE)).toBeNull()
  })

  it('CLOSES when the window reaches past the sweep horizon', async () => {
    // Beyond REFRESH_DAYS the rollup rests on the original backfill and mutation
    // signals rather than a periodic regeneration — a weaker guarantee than this
    // gate asserts, so it declines rather than assuming.
    const beyond = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - (REFRESH_DAYS + 1) * 86_400_000)
    expect(await resolveRollupGate(t.db, { startIso: beyond.toISOString(), endIso: NOW_ISO }, NOW_ISO, TEAMMATE)).toBeNull()
  })

  it('uses the REQUEST clock, not the wall clock, for the boundary', async () => {
    // The handler clamps its window with the same instant; a gate that read its
    // own clock could classify a day as settled that the window still treats as
    // today.
    const gate = await resolveRollupGate(t.db, { startIso: '2026-05-10T00:00:00.000Z', endIso: '2026-05-12T08:00:00.000Z' }, '2026-05-12T08:00:00.000Z', TEAMMATE)
    expect(gate?.todayUtc).toBe('2026-05-12')
    expect(gate?.settledThrough).toBe('2026-05-11')
  })

  it('CLOSES when a settled day is STALE — the lag that makes mixed bases unsafe', async () => {
    /*
     * THE CONDITION THAT MAKES THE REST OF THE PAGE SAFE.
     *
     * The three checks above prove the rollup HAS these days. This proves it is
     * up to DATE with them. Without it a row written after the last run sits in
     * the view and not in the rollup, so any figure pair split across the two
     * bases — untagged_usd against its no-project decomposition, the attributed
     * headline against declared-personal — disagrees transiently, and both pairs
     * carry an asserted invariant.
     *
     * Uses the worker's own definition of stale: a day whose §A source rows
     * carry a write instant newer than that day's rollup refresh_at.
     */
    const day = '2026-05-10'
    await t.client`INSERT INTO usage_rollup_daily
        (day, teammate_id, tool, usage_provenance, cost_usd, tokens, record_count, refresh_at)
      VALUES (${day}::date, ${TEAMMATE}::uuid, 'claude-code', 'otel-emitted', 1, 1, 1,
              now() - interval '1 hour')`
    expect(
      await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE),
      'a materialised, current day must not close the gate',
    ).not.toBeNull()

    // ...and a source row for that day written SINCE. The rollup now lags.
    await t.client`INSERT INTO unaccounted_usage
        (teammate_id, day, tool, cost_usd, tokens, computed_at)
      VALUES (${TEAMMATE}::uuid, ${day}::date, 'copilot', 1, 1, now())`
    expect(await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE)).toBeNull()
  })

  it('a stale TODAY does not close the gate — today never comes from the rollup', async () => {
    // Only SETTLED days matter: today is always read live, so a write landing
    // today cannot make the two bases disagree.
    await t.client`INSERT INTO unaccounted_usage
        (teammate_id, day, tool, cost_usd, tokens, computed_at)
      VALUES (${TEAMMATE}::uuid, ${TODAY}::date, 'copilot', 1, 1, now())`
    expect(await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE)).not.toBeNull()
  })

  it("another teammate's lag does not close MY gate", async () => {
    // The check is teammate-scoped: this read serves one person, and a colleague
    // whose day has not been re-presented says nothing about mine. A global
    // check would leave the gate shut most of the time on a busy estate.
    await t.client`INSERT INTO unaccounted_usage
        (teammate_id, day, tool, cost_usd, tokens, computed_at)
      VALUES (${OTHER}::uuid, '2026-05-10'::date, 'copilot', 1, 1, now())`
    expect(await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE)).not.toBeNull()
  })

  it('CLOSES on a PENDING REFRESH REQUEST — the invalidation no timestamp carries', async () => {
    /*
     * The currency test below compares source write instants against
     * refresh_at, which sees an insert and cannot see a DELETE. Quarantining a
     * session removes it from v_complete_usage without writing anything, and a
     * re-home changes the dimensions a row rolls up under; both reach the
     * worker through this queue, drained a bounded number of teammates per run.
     * While an entry is pending, nothing else in this gate can tell that the
     * rollup is wrong.
     */
    await t.client`INSERT INTO usage_rollup_refresh (teammate_id) VALUES (${TEAMMATE}::uuid)`
    expect(
      await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE),
    ).toBeNull()
  })

  it("a pending refresh for SOMEONE ELSE does not close my gate", async () => {
    await t.client`INSERT INTO usage_rollup_refresh (teammate_id) VALUES (${OTHER}::uuid)`
    expect(
      await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE),
    ).not.toBeNull()
  })

  it("another teammate's FRESH cell cannot certify my stale day", async () => {
    /*
     * The witness has to match the candidate on every identity dimension it
     * certifies. The queue recomputes ONE teammate at a time, so a cell on the
     * same day belonging to a colleague is not evidence about mine — and a
     * day-only witness would let their refresh open my gate over my own lag.
     */
    const day = '2026-05-10'
    await t.client`INSERT INTO usage_rollup_daily
        (day, teammate_id, tool, usage_provenance, cost_usd, tokens, record_count, refresh_at)
      VALUES (${day}::date, ${OTHER}::uuid, 'claude-code', 'otel-emitted', 1, 1, 1, now())`
    await t.client`INSERT INTO unaccounted_usage
        (teammate_id, day, tool, cost_usd, tokens, computed_at)
      VALUES (${TEAMMATE}::uuid, ${day}::date, 'copilot', 1, 1, now() - interval '5 minutes')`
    expect(
      await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE),
    ).toBeNull()
  })

  it('a lag OUTSIDE the requested window does not close the gate', async () => {
    /*
     * Currency is asked only about days this window can actually be served
     * from. A pending write to 05-10 must not push a request for the window
     * ENDING 05-01 onto the expensive path — that is the whole benefit of the
     * lane, given away for a day the response does not contain.
     *
     * (The earlier window still starts inside the 40-day horizon; a window that
     * reaches past it is closed by the horizon check for its own reasons, and
     * would prove nothing here.)
     */
    await t.client`INSERT INTO unaccounted_usage
        (teammate_id, day, tool, cost_usd, tokens, computed_at)
      VALUES (${TEAMMATE}::uuid, '2026-05-10'::date, 'copilot', 1, 1, now())`
    const earlier = { startIso: '2026-04-20T00:00:00.000Z', endIso: '2026-05-01T00:00:00.000Z' }
    expect(await resolveRollupGate(t.db, earlier, NOW_ISO, TEAMMATE)).not.toBeNull()
    // ...and the same lag DOES close a window that contains the day.
    expect(
      await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE),
    ).toBeNull()
  })

  describe('EVERY source arm closes the gate', () => {
    /*
     * The gate is only as good as its inventory. One malformed or missing arm
     * leaves this suite green while the gate opens over stale money in that
     * source — and an earlier version of this file tested `unaccounted_usage`
     * alone, so four of the five arms were entirely uncovered.
     *
     * Each case materialises a settled day, proves the gate OPENS, then writes
     * to exactly one source for that day and proves it CLOSES. The open
     * assertion is what stops a case passing because the gate was already shut.
     */
    const DAY = '2026-05-10'

    async function materialise() {
      await t.client`INSERT INTO usage_rollup_daily
          (day, teammate_id, tool, usage_provenance, cost_usd, tokens, record_count, refresh_at)
        VALUES (${DAY}::date, ${TEAMMATE}::uuid, 'claude-code', 'otel-emitted', 1, 1, 1,
                now() - interval '1 hour')`
      expect(
        await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE),
        'the gate must be OPEN before the write, or the case proves nothing',
      ).not.toBeNull()
    }

    const shut = async () =>
      expect(
        await resolveRollupGate(t.db, { startIso: WINDOW_START, endIso: NOW_ISO }, NOW_ISO, TEAMMATE),
      ).toBeNull()

    it('attribution_record — the primary OTel lane', async () => {
      await materialise()
      await t.client`INSERT INTO attribution_record
          (instance_id, teammate_id, project_id, region_id, org_unit_id, cost_owning_unit_id,
           tool, model, token_type, tokens, cost_usd, rate_card_id, rate_card_version,
           fidelity_tier, cost_basis, ts_event, ts_recorded)
        VALUES (${INSTANCE}::uuid, ${TEAMMATE}::uuid, ${PROJECT}::uuid, ${REGION}::uuid,
                ${UNIT}::uuid, ${UNIT}::uuid, 'claude-code', 'sonnet', 'input', 10, 1,
                gen_random_uuid(), 1, 'tier-1', 'estimated',
                ${DAY + 'T09:00:00Z'}::timestamptz, now())`
      await shut()
    })

    it('actual_spend — the provider daily total', async () => {
      await materialise()
      await t.client`INSERT INTO actual_spend
          (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, pulled_at)
        VALUES (${TEAMMATE}::uuid, ${DAY}::date, 'claude-code', 0, 0, 1, 'api', now())`
      await shut()
    })

    it('provider_usage_fact — the API lane', async () => {
      await materialise()
      // cost_type non-NULL = a cost row (the check constraint pairs them).
      await t.client`INSERT INTO provider_usage_fact
          (teammate_id, date, tool, source, provider, cost_type, cost_usd, pulled_at)
        VALUES (${TEAMMATE}::uuid, ${DAY}::date, 'copilot', 'api', 'github',
                'premium_request', 1, now())`
      await shut()
    })

    it('reconciliation_record — the Copilot teammate-scope arm', async () => {
      await materialise()
      await t.client`INSERT INTO reconciliation_record
          (teammate_id, provider, enterprise_ref, period_date, category, scope,
           actual_usd, otel_attributed_usd, delta_usd, spend_class, disposition, computed_at)
        VALUES (${TEAMMATE}::uuid, 'github', 'ent', ${DAY}::date, 'copilot_interactive',
                'teammate', 1, 0, 1, 'indicative', 'untagged', now())`
      await shut()
    })

    it('unaccounted_usage — the remainder arm', async () => {
      await materialise()
      await t.client`INSERT INTO unaccounted_usage
          (teammate_id, day, tool, cost_usd, tokens, computed_at)
        VALUES (${TEAMMATE}::uuid, ${DAY}::date, 'copilot', 1, 1, now())`
      await shut()
    })

    it('the inventory the gate uses names exactly these five tables', () => {
      // The arms above are the behavioural half. This is the structural half:
      // a source added to the lane and to the worker but not to the shared
      // inventory would leave both readers blind, and no type can catch it.
      expect([...SOURCE_WRITE_TABLES].sort()).toEqual(
        [
          'actual_spend',
          'attribution_record',
          'provider_usage_fact',
          'reconciliation_record',
          'unaccounted_usage',
        ].sort(),
      )
    })
  })

  describe('batched resolution', () => {
    /*
     * The gate is resolved once per WINDOW and the page has three, so it was
     * six round trips on a request already issuing ~50 against a
     * credit-throttled server. Coverage does not depend on the window, so it is
     * resolved once and the per-window questions are asked together.
     *
     * Two properties have to hold, and the second is the one that could
     * silently go wrong: the batch must be CHEAPER, and it must give the SAME
     * answers as asking one at a time.
     */
    const WINDOWS = [
      { startIso: WINDOW_START, endIso: NOW_ISO },
      { startIso: '2026-05-05T00:00:00.000Z', endIso: '2026-05-12T00:00:00.000Z' },
      { startIso: '2026-04-20T00:00:00.000Z', endIso: '2026-05-01T00:00:00.000Z' },
      // Past the 40-day horizon: must come back null without being asked about.
      { startIso: '2026-01-01T00:00:00.000Z', endIso: '2026-02-01T00:00:00.000Z' },
    ]

    it('gives the SAME answer per window as resolving each alone', async () => {
      const one = []
      for (const w of WINDOWS) one.push(await resolveRollupGate(t.db, w, NOW_ISO, TEAMMATE))
      const coverage = await resolveRollupCoverage(t.db, NOW_ISO, TEAMMATE)
      const many = await resolveRollupGates(t.db, coverage, WINDOWS, NOW_ISO, TEAMMATE)
      expect(many).toEqual(one)
      // ...and the fixture must contain BOTH verdicts, or this compares two
      // uniform lists and proves nothing about the per-window mapping.
      expect(many.some((g) => g !== null), 'no window opened').toBe(true)
      expect(many.some((g) => g === null), 'no window closed').toBe(true)
    })

    it('keeps a per-window STALE verdict attached to its own window', async () => {
      // The batch answers several windows from one scan, so a mix-up would map
      // one window's staleness onto another and be invisible above.
      const day = '2026-05-10'
      await t.client`INSERT INTO usage_rollup_daily
          (day, teammate_id, tool, usage_provenance, cost_usd, tokens, record_count, refresh_at)
        VALUES (${day}::date, ${TEAMMATE}::uuid, 'claude-code', 'otel-emitted', 1, 1, 1,
                now() - interval '1 hour')`
      await t.client`INSERT INTO unaccounted_usage
          (teammate_id, day, tool, cost_usd, tokens, computed_at)
        VALUES (${TEAMMATE}::uuid, ${day}::date, 'copilot', 1, 1, now())`

      const coverage = await resolveRollupCoverage(t.db, NOW_ISO, TEAMMATE)
      const [containsIt, endsBeforeIt] = await resolveRollupGates(
        t.db,
        coverage,
        [
          { startIso: WINDOW_START, endIso: NOW_ISO },
          { startIso: WINDOW_START, endIso: '2026-05-08T00:00:00.000Z' },
        ],
        NOW_ISO,
        TEAMMATE,
      )
      expect(containsIt, 'the window containing the stale day must close').toBeNull()
      expect(endsBeforeIt, 'a window ending before it must stay open').not.toBeNull()
    })

    it('asks NOTHING when coverage fails', async () => {
      // A closed gate is now cheaper than it was: no currency query at all.
      await setMarkers({ backfill: false })
      expect(await resolveRollupCoverage(t.db, NOW_ISO, TEAMMATE)).toBeNull()
      expect(await resolveRollupGates(t.db, null, WINDOWS, NOW_ISO, TEAMMATE)).toEqual(
        WINDOWS.map(() => null),
      )
    })
  })
})
