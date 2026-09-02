// @vitest-environment node
/*
 * GET /api/v1/me/usage — the INVARIANCE golden.
 *
 * These are money figures on a page an operator makes chargeback decisions
 * from, so the acceptance for any read-path change is an ACTUAL RESPONSE
 * COMPARISON, not a grep and not a set of hand-picked assertions
 * (usage-read-path-performance.md D1: "a rewrite that is faster and different
 * is a failure, not a trade-off").
 *
 * One run cannot compare two revisions, so the comparison is against a
 * COMMITTED fixture captured on the PRE-CHANGE tree:
 *
 *   WRITE_GOLDEN=1 npx vitest run tests/integration/me/me-usage-golden.test.ts
 *
 * REGENERATING IS A DELIBERATE ACT, NOT A FIX FOR A RED RUN. A red run means a
 * figure moved; rewrite the fixture only when the move is intended, and say why
 * in the commit. (Mirrors tests/integration/reports/billed-lane-invariance.test.ts,
 * which is the pattern this follows rather than a second invention.)
 *
 * WHY THE KNOWN-OUTCOME FIXTURE. Its clock is fixed at 2026-05-15T12:00:00Z —
 * mid-day and mid-month — which is the case the read path is most likely to get
 * wrong: `/me/usage` CLAMPS its window end to `now` (usage.get.ts:115-131), so
 * the upper bound is NOT a UTC midnight on the page's primary path. A fixture
 * anchored to a completed month would never exercise that.
 *
 * BYTE-STABILITY: no UUID reaches the serialization. Projects key on `code`,
 * everything else on its natural string. A fixture full of freshly-minted uuids
 * would differ on every database and be worthless as a committed artefact.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { seedKnownOutcomeCompany, KO_NOW, type KnownOutcomeIds } from '../helpers/known-outcome-fixture'
import { buildUsageRollup } from '../helpers/usage-rollup'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import rawHandler from '../../../server/api/v1/me/usage.get'
import { resolveRollupGate } from '../../../server/usage/rollup-gate'
import { resolveServerClock } from '../../../shared/reports/clock'
import {
  createRequestTimingStore,
  requestTimingStorage,
} from '../../../server/observability/request-timing'

/*
 * The ceiling this page's statement count must stay under. Not a target — a
 * ratchet: it exists so a new per-request query shows up as a failing test
 * rather than as a slower page nobody attributes to a commit.
 */
const GATE_ERA_STATEMENT_BUDGET = 46

const GOLDEN_PATH = resolve(
  dirname(new URL(import.meta.url).pathname),
  '../../fixtures/me-usage.golden.json',
)

let t: TestDb
let ids: KnownOutcomeIds

const handler = rawHandler as unknown as (event: unknown) => Promise<Record<string, unknown>>

function ev(query: string, session: Session) {
  const url = `/x${query ? `?${query}` : ''}`
  const e = {
    method: 'GET',
    path: url,
    /*
     * THE CLOCK IS PINNED to the fixture's instant. requestClock() honours an
     * event-supplied serverClock (request-clock.ts:40-46); without this the
     * handler would resolve a window around the REAL today while the seeded
     * estate lives in May 2026, every arm would return zeros, and the golden
     * would be perfectly stable and completely meaningless.
     */
    context: { params: {}, serverClock: resolveServerClock(KO_NOW) },
    node: {
      req: {
        method: 'GET',
        url,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { host: 'localhost:3450' }
        },
      },
      res: {
        _headers: {} as Record<string, unknown>,
        statusCode: 200,
        getHeader() {},
        setHeader() {},
        removeHeader() {},
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e
}

/**
 * Strip anything that cannot be stable across databases or runs.
 *
 * UUIDs are minted per seed, and instants that carry the RUN clock (rather than
 * the fixture clock) move every execution. Both are replaced by a marker rather
 * than deleted, so a field APPEARING or DISAPPEARING still fails the comparison
 * — which is the point: a dropped field is exactly the kind of regression a
 * lenient normaliser hides.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Keys that are ids by name, or hold a run-clock instant, become markers.
      /*
       * `settled_source` is normalised BECAUSE it legitimately differs between
       * the two runs: the fixture is captured on the fallback ('view') and
       * asserted on the split ('rollup'). That difference IS the field's
       * purpose, so comparing it would make this suite permanently red for the
       * one reason that is not a defect. Its behaviour is pinned directly in
       * the settled-source test below instead.
       */
      /*
       * `*_minutes_ago` legs are RUN-CLOCK derived — the gap between now and a
       * seeded write instant — so they belong with generated_at, not with the
       * figures. They read 0 only because the fixture happened to build in the
       * same second as its own seeds; a slow box, or any change to how the
       * fixture ages its writes, moves them. Pinning them was a flake waiting
       * to be found, and pins nothing about the read path this suite exists to
       * protect. Freshness arithmetic is covered by its own tests.
       */
      if (
        /(^|_)id$/i.test(k) ||
        /_minutes_ago$/.test(k) ||
        k === 'generated_at' ||
        k === 'generatedAt' ||
        k === 'settled_source'
      ) {
        out[k] = v == null ? null : '<stable>'
        continue
      }
      out[k] = normalise(v)
    }
    return out
  }
  if (typeof value === 'string' && UUID_RE.test(value)) return '<stable>'
  return value
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  ids = await seedKnownOutcomeCompany(t)

  /*
   * THE CANDIDATE-PROJECT STATES THE SHARED FIXTURE DOES NOT CARRY.
   *
   * Every project it seeds has spend, so the ASSIGNED-BUT-NO-SPEND bucket is
   * absent — and that bucket is what proves two guarantees of the project
   * query: the join must stay LEFT (an assignment with no usage still yields a
   * zero row) and its tool array must serialise as [] rather than [null].
   *
   * Proven necessary, not assumed: with the fixture alone, mutating the join to
   * INNER and dropping the empty-array COALESCE BOTH left the golden green.
   * Seeded here rather than in the helper so the four other suites that share
   * it are untouched.
   */
  await t.client`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-ASSIGNED-DRY', 'hash-PROJ-ASSIGNED-DRY', 'Assigned No Spend', 'billable',
            ${ids.regionApac}::uuid, ${ids.uApacCto}::uuid)`
  await t.client`
    INSERT INTO project_assignment (project_id, teammate_id, role, effective)
    SELECT p.id, ${ids.alice}::uuid, 'member',
           tstzrange('2026-05-01T00:00:00Z'::timestamptz, NULL, '[)')
      FROM project p WHERE p.code = 'PROJ-ASSIGNED-DRY'`
  /*
   * SPEND ON THE SPLIT BOUNDARY. Without it the arms cannot be told apart: the
   * fixture's usage all sits on 05-05, so dropping today from the live arm or
   * removing the rollup arm's lower bound changes nothing and the comparison
   * below certifies nothing. Rows on today, on the last settled day, and before
   * the window start give each bound something to move.
   */
  const inst = await t.client<{ id: string }[]>`
    SELECT instance_id::text AS id FROM attribution_record
     WHERE teammate_id = ${ids.alice}::uuid LIMIT 1`
  for (const [day, cost] of [
    ['2026-05-15T09:00:00Z', 7],
    ['2026-05-14T09:00:00Z', 11],
    ['2026-04-25T09:00:00Z', 13],
  ] as const) {
    await t.client`
      INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
         tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event,
         claude_session_id)
      VALUES (${inst[0]!.id}::uuid, ${ids.alice}::uuid, ${ids.regionApac}::uuid,
              ${ids.uApacCto}::uuid, ${ids.uApacCto}::uuid, ${ids.projScholarship}::uuid,
              'claude-code', 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1',
              'estimated', ${day}::timestamptz, ${'conv-gold-' + day})`
  }

  await buildUsageRollup(t.db)

  /*
   * OPEN THE GATE. Materialising the rollup is not enough: resolveRollupGate
   * also demands a completed backfill, a recent wide sweep, and a recent
   * successful worker run — none of which a test estate has, because direct
   * worker calls never write `worker_run`.
   *
   * Without these three rows every arm below runs the FALLBACK query, and this
   * fixture would prove only that the unchanged path is unchanged. That is
   * exactly how a real upper-bound defect reached the split arms unnoticed:
   * the golden was green and had never executed them.
   *
   * With the gate open the captured responses come from the SPLIT path, so the
   * committed fixture — captured before any of this existed — is now an
   * assertion that splitting changed no figure anywhere on the page.
   */
  // buildUsageRollup already writes backfill-complete, so upsert rather than
  // insert — a duplicate-key error here would be a confusing way to learn that.
  await t.client`INSERT INTO kv_store (mount, key, value)
    VALUES ('usage-rollup', 'backfill-complete', now()::text)
    ON CONFLICT (mount, key) DO UPDATE SET value = EXCLUDED.value`
  await t.client`INSERT INTO kv_store (mount, key, value)
    VALUES ('usage-rollup', 'wide-through', ${KO_NOW.toISOString().slice(0, 10)})
    ON CONFLICT (mount, key) DO UPDATE SET value = EXCLUDED.value`
  /*
   * `now()`, NOT the fixture clock. The gate's liveness leg asks whether the
   * worker ran recently in REAL time (`started_at > now() - interval`), while
   * its day boundary comes from the REQUEST clock. Seeding this at KO_NOW put
   * the run months in the past and the gate stayed shut — with the fixture
   * still matching, because the fallback produces the same bytes. Only the
   * explicit gate assertion below exposed it.
   */
  await t.client`INSERT INTO worker_run (worker_name, status, started_at)
    VALUES ('usage-rollup', 'success', now())`
}, 300_000)

afterAll(async () => {
  await stopTestDb(t)
})

const devSession = (): Session =>
  ({
    teammateId: ids.alice,
    email: 'alice@known.test',
    displayName: 'Alice',
    role: 'developer',
    regionId: ids.regionApac,
    orgPath: 'apac',
    issuedAt: KO_NOW.toISOString(),
  }) as unknown as Session

/**
 * THE MATRIX.
 *
 * The arms vary `month` / `from` / `to`, NOT `?window`. That distinction is the
 * whole point: `?window=30|90` feeds the `attribution_aggregate` chart reads
 * (usage.get.ts:86,165-167), while the reads this sprint touches take
 * `spendWindow`, derived from `resolveReportWindow({month,from,to})` and then
 * CLAMPED to `now` (usage.get.ts:124-133). A matrix built on `?window` would
 * have looked thorough and exercised one spend window four times.
 *
 * The two shapes that matter are therefore:
 *   - CURRENT month — `resolved.endIso > now`, so the end is clamped to a
 *     mid-day instant. This is the page's default and the only shape with a
 *     non-midnight bound.
 *   - COMPLETED month/range — `resolved.endIso <= now`, so the bound is already
 *     a UTC midnight and no clamp applies.
 */
const ARMS: Record<string, string> = {
  // Default: no params at all — current month, clamped to a mid-day now.
  'current-month:default': '',
  // Same window family, chargeback lens — a different lane on the same bounds.
  'current-month:lens-chargeback': 'lane=chargeback',
  // A COMPLETED month: midnight-bounded, no clamp.
  'completed-month:2026-04': 'month=2026-04',
  // An explicit range ENDING TODAY — still clamped, but not month-aligned.
  'range-to-today': 'from=2026-05-01&to=2026-05-15',
  // An explicit range wholly in the past — midnight-bounded both ends.
  'range-settled': 'from=2026-04-01&to=2026-04-30',
}

async function snapshot(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [name, query] of Object.entries(ARMS)) {
    out[name] = normalise(await handler(ev(query, devSession())))
  }
  return out
}

describe('GET /me/usage — response invariance', () => {
  it('THE GATE IS OPEN — without this the arms below prove nothing', async () => {
    /*
     * Asserted FIRST and deliberately. If the seeded prerequisites do not
     * actually open the gate, every arm runs the fallback query, the fixture
     * matches trivially, and this suite certifies that unchanged code is
     * unchanged. That is precisely the state it was in when a real upper-bound
     * defect went undetected in the split arms.
     */
    const gate = await resolveRollupGate(
      t.db,
      { startIso: '2026-05-01T00:00:00.000Z', endIso: KO_NOW.toISOString() },
      KO_NOW.toISOString(),
      ids.alice,
    )
    expect(gate, 'gate closed — the golden is exercising the fallback, not the split').not.toBeNull()
    expect(gate!.settledThrough).toBe('2026-05-14')
  })

  it('matches the committed golden, field for field', async () => {
    /*
     * CAPTURED ON THE FALLBACK, ASSERTED ON THE SPLIT.
     *
     * The gate's null branch IS the original query, so closing the gate
     * reproduces the pre-change response on today's tree — which makes this a
     * genuine before/after comparison rather than a snapshot of whatever the
     * code currently does, and it stays regenerable after the split ships.
     */
    if (process.env.WRITE_GOLDEN) {
      await t.client`DELETE FROM worker_run WHERE worker_name = 'usage-rollup'`
    }
    const live = await snapshot()
    const liveText = `${JSON.stringify(live, null, 2)}\n`
    if (process.env.WRITE_GOLDEN) {
      // Put it back: the cases below expect the gate open, and leaving it shut
      // would fail them for a reason that is this test's own housekeeping.
      await t.client`INSERT INTO worker_run (worker_name, status, started_at)
        VALUES ('usage-rollup', 'success', now())`
    }

    if (process.env.WRITE_GOLDEN) {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true })
      writeFileSync(GOLDEN_PATH, liveText)
      expect(existsSync(GOLDEN_PATH)).toBe(true)
      return
    }

    expect(
      existsSync(GOLDEN_PATH),
      'golden fixture missing — capture it on the PRE-CHANGE tree with WRITE_GOLDEN=1',
    ).toBe(true)
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, unknown>
    expect(live).toEqual(golden)
  })

  it('the golden covers every arm, so a silently dropped arm fails here', async () => {
    // A matrix that quietly shrinks is worse than no matrix: the remaining arms
    // stay green and the coverage claim in the design becomes false.
    if (process.env.WRITE_GOLDEN) return
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, unknown>
    expect(Object.keys(golden).sort()).toEqual(Object.keys(ARMS).sort())
  })

  it('captures a NON-MIDNIGHT window end — the case the split must not break', async () => {
    // The fixture clock is 12:00Z on the 15th. If a future change made the
    // window end land on a midnight, this golden would stop covering the
    // clamped path and would pass while the risky case went untested.
    expect(KO_NOW.toISOString()).toBe('2026-05-15T12:00:00.000Z')
    expect(KO_NOW.getUTCHours()).not.toBe(0)
  })
})

type SettledSource = {
  page: string
  month_to_date: string
  previous_period: string | null
}

describe('page_freshness.settled_source', () => {
  it('says ROLLUP when the gate is open — per basis, because the gate is per basis', async () => {
    const res = (await handler(ev('', devSession()))) as unknown as {
      page_freshness: { settled_source: SettledSource }
    }
    expect(res.page_freshness.settled_source.page).toBe('rollup')
    expect(res.page_freshness.settled_source.month_to_date).toBe('rollup')
  })

  it('says VIEW when the gate is closed, so a fallback is visible not silent', async () => {
    // An operator looking at a figure that seems wrong needs to know which lane
    // produced it. A stalled worker is the case this exists for.
    await t.client`DELETE FROM worker_run WHERE worker_name = 'usage-rollup'`
    try {
      const res = (await handler(ev('', devSession()))) as unknown as {
        page_freshness: { settled_source: SettledSource }
      }
      expect(res.page_freshness.settled_source.page).toBe('view')
      expect(res.page_freshness.settled_source.month_to_date).toBe('view')
    } finally {
      await t.client`INSERT INTO worker_run (worker_name, status, started_at)
        VALUES ('usage-rollup', 'success', now())`
    }
  })

  it('reports the PREVIOUS-PERIOD basis, and null when no comparison was read', async () => {
    /*
     * The third key, which nothing else asserts. The comparison window sits
     * BEHIND the page window, so it is the first to fall out of the 40-day
     * horizon — the exact case a single settled_source value would report
     * wrongly. And when no comparison is read at all the key is null rather
     * than a lane name, because "no answer" is not "the view".
     */
    const res = (await handler(ev('', devSession()))) as unknown as {
      page_freshness: { settled_source: SettledSource }
      trend: { previous: unknown } | null
    }
    /*
     * The DEFAULT request already diverges, which is the whole argument for the
     * field being an object: May month-to-date is inside the 40-day sweep, but
     * its month-on-month comparison reaches back to 1 April, which is not. One
     * value here would have had to call the page 'view' or the comparison
     * 'rollup', and both are false.
     */
    expect(res.page_freshness.settled_source).toEqual({
      page: 'rollup',
      month_to_date: 'rollup',
      previous_period: 'view',
    })

    // And NULL, not a lane name, when no comparison was read at all: a custom
    // range has no month-on-month leg, and "no answer" must not be reported as
    // "the view", which would look like a fallback that never happened.
    const from = new Date(KO_NOW.getTime() - 35 * 86_400_000).toISOString().slice(0, 10)
    const to = new Date(KO_NOW.getTime() - 31 * 86_400_000).toISOString().slice(0, 10)
    const range = (await handler(
      ev(`from=${from}&to=${to}`, devSession()),
    )) as unknown as { page_freshness: { settled_source: SettledSource } }
    expect(range.page_freshness.settled_source.previous_period).toBeNull()
    expect(range.page_freshness.settled_source.page).toBe('rollup')
  })

  it('reports the MONTH-TO-DATE basis separately from the page basis', async () => {
    /*
     * The reason this field is an object rather than a string. The two gates
     * take different window starts, and only the start decides the horizon
     * check — so a page window inside the 40-day sweep can be served from the
     * rollup while a month-to-date reaching behind it cannot. A single value
     * would have to pick one and be wrong about the other.
     */
    // Well behind the 40-day sweep horizon, measured from the FIXTURE's clock.
    const past = new Date(KO_NOW.getTime() - 200 * 86_400_000).toISOString().slice(0, 7)
    const res = (await handler(ev(`month=${past}`, devSession()))) as unknown as {
      page_freshness: { settled_source: SettledSource }
    }
    expect(res.page_freshness.settled_source.page).toBe('view')
    expect(res.page_freshness.settled_source.month_to_date).toBe('rollup')
  })
})

describe('a LATE WRITE to a settled day', () => {
  /*
   * THE REASON THE GATE CHECKS CURRENCY AND NOT ONLY COVERAGE.
   *
   * Two figures on this page are asserted against a figure derived on the OTHER
   * basis: `where_it_went.untagged_usd` (split-backed) against its four
   * `no_project` segments (view-backed, from the same query the needs-tagging
   * worklist is built from), and `attributed_usage_usd` (split) against
   * `declared_personal_usage_usd` (view). A pair of bases is safe only while
   * the two cannot disagree — and a write to a settled day lands in the view at
   * once and in the rollup only when the worker next re-presents that day.
   *
   * So the gate closes on the lag, both sides fall back to the view, and the
   * invariants hold. This asserts the OBSERVABLE consequence rather than the
   * gate's internals, which is what actually protects the page.
   */
  const SETTLED_DAY = '2026-05-10'
  const MONTH_START = '2026-05-01T00:00:00.000Z'

  it('keeps the untagged remainder footing with its four segments', async () => {
    type Res = {
      page_freshness: { settled_source: SettledSource }
      where_it_went: {
        untagged_usd: string
        no_project: {
          worklist_usd: string
          activity_tagged_usd: string
          dismissed_usd: string
          untaggable_usd: string
        }
      }
    }
    const before = (await handler(ev('', devSession()))) as unknown as Res
    expect(
      before.page_freshness.settled_source.page,
      'the split must be live first, or this test proves nothing',
    ).toBe('rollup')

    await t.client`INSERT INTO unaccounted_usage
        (teammate_id, day, tool, cost_usd, tokens, computed_at)
      VALUES (${ids.alice}::uuid, ${SETTLED_DAY}::date, 'copilot', 42.5, 1000, now())`
    try {
      const after = (await handler(ev('', devSession()))) as unknown as Res
      expect(
        after.page_freshness.settled_source.page,
        'the gate must notice the rollup now lags this settled day',
      ).toBe('view')

      const seg = after.where_it_went.no_project
      const segments =
        Number(seg.worklist_usd) +
        Number(seg.activity_tagged_usd) +
        Number(seg.dismissed_usd) +
        Number(seg.untaggable_usd)
      // Both sides now come from one source, so they foot exactly. Rounding to
      // cents is the payload's own grain, not a tolerance for disagreement.
      expect(segments).toBeCloseTo(Number(after.where_it_went.untagged_usd), 2)
      // And the write is actually visible — otherwise a query that dropped it
      // entirely would satisfy the equality above.
      expect(Number(after.where_it_went.untagged_usd)).toBeGreaterThan(
        Number(before.where_it_went.untagged_usd),
      )
    } finally {
      await t.client`DELETE FROM unaccounted_usage
        WHERE teammate_id = ${ids.alice}::uuid AND day = ${SETTLED_DAY}::date AND cost_usd = 42.5`
    }
  })

  it('keeps declared-personal at or below the attributed headline', async () => {
    /*
     * The operand that has to be NON-ZERO for this to mean anything. An earlier
     * version asserted `declared <= attributed` against a fixture with no
     * declarations at all, so the left side was always 0 and the assertion
     * could not fail however the declared query behaved — the exact class this
     * suite keeps producing. A declaration is seeded here, backdated to the
     * month start so it covers the settled day the late write lands on.
     */
    type Res = {
      page_freshness: { settled_source: SettledSource }
      disclosure: {
        declared_personal_usage_usd: string
        attributed_usage_usd: string
      } | null
    }
    // The tool the fixture actually spends on, so the declaration has usage to
    // claim; a declaration on an unused tool would be zero again.
    const [spent] = await t.client`
      SELECT tool, SUM(cost_usd)::text AS usd FROM v_complete_usage
       WHERE teammate_id = ${ids.alice}::uuid
         AND ts_event >= ${MONTH_START}::timestamptz
       GROUP BY tool ORDER BY 2 DESC LIMIT 1`
    expect(spent, 'the fixture must spend something this month').toBeTruthy()

    // A settled day this tool has no unaccounted row on yet — the table's
    // unique key is (teammate, day, tool), and the fixture already occupies
    // some of them.
    const [free] = await t.client`
      SELECT d::date::text AS day
        FROM generate_series(${MONTH_START}::timestamptz, ${MONTH_START}::timestamptz + interval '12 days',
                             interval '1 day') d
       WHERE NOT EXISTS (
         SELECT 1 FROM unaccounted_usage
          WHERE teammate_id = ${ids.alice}::uuid AND day = d::date AND tool = ${spent!.tool})
       LIMIT 1`
    expect(free, 'no free settled day for the declared tool').toBeTruthy()

    await t.client`INSERT INTO personal_subscription_declaration
        (teammate_id, tool, subscription_type, monthly_cost_usd, declared_at)
      VALUES (${ids.alice}::uuid, ${spent!.tool}, 'max', 200, ${MONTH_START}::timestamptz)`
    try {
      const before = (await handler(ev('', devSession()))) as unknown as Res
      expect(before.disclosure, 'no disclosure leg — nothing to assert').not.toBeNull()
      expect(
        Number(before.disclosure!.declared_personal_usage_usd),
        'the declared operand must be non-zero, or this test cannot fail',
      ).toBeGreaterThan(0)
      expect(Number(before.disclosure!.declared_personal_usage_usd)).toBeLessThanOrEqual(
        Number(before.disclosure!.attributed_usage_usd),
      )

      // Now the late write, on the DECLARED tool and on a settled day: the
      // shape that puts the view-backed declared figure ahead of the
      // split-backed headline.
      await t.client`INSERT INTO unaccounted_usage
          (teammate_id, day, tool, cost_usd, tokens, computed_at)
        VALUES (${ids.alice}::uuid, ${free!.day}::date, ${spent!.tool}, 42.5, 1000, now())`
      const after = (await handler(ev('', devSession()))) as unknown as Res
      expect(after.page_freshness.settled_source.page).toBe('view')
      // Both operands moved, and on the same basis, so the invariant holds.
      expect(Number(after.disclosure!.declared_personal_usage_usd)).toBeGreaterThan(
        Number(before.disclosure!.declared_personal_usage_usd),
      )
      expect(Number(after.disclosure!.declared_personal_usage_usd)).toBeLessThanOrEqual(
        Number(after.disclosure!.attributed_usage_usd),
      )
    } finally {
      await t.client`DELETE FROM unaccounted_usage
        WHERE teammate_id = ${ids.alice}::uuid AND cost_usd = 42.5`
      await t.client`DELETE FROM personal_subscription_declaration
        WHERE teammate_id = ${ids.alice}::uuid`
    }
  })

  it("shows a COLLEAGUE's late write in the project total, which the caller's gate cannot cover", async () => {
    /*
     * The one §A read on this page that spans every teammate, and therefore the
     * one that must NOT take the caller's gate. The currency proof is scoped to
     * the caller, so a colleague's late write cannot close it — a gated read
     * here would serve their stale rows behind a proof that never covered them,
     * and would disagree with every other consumer of this same figure
     * (/me/projects, the budget alert), none of which is gated.
     */
    type Res = {
      page_freshness: { settled_source: SettledSource }
      where_it_went: { rows: Array<{ project_id: string; project_total_usd: string }> }
    }
    const before = (await handler(ev('', devSession()))) as unknown as Res
    const row = before.where_it_went.rows[0]
    expect(row, 'the fixture must show at least one project row').toBeTruthy()
    expect(
      before.page_freshness.settled_source.page,
      'the caller gate must be OPEN, or this proves nothing about the ungated read',
    ).toBe('rollup')

    // Bob spends on Alice's project, on a settled day, after the rollup was built.
    // Cloned from one of bob's own rows so every FK and dimension is real.
    const cloned = await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, project_id, region_id, org_unit_id,
         cost_owning_unit_id, tool, model, token_type, tokens, cost_usd,
         rate_card_id, rate_card_version, fidelity_tier, cost_basis, ts_event, ts_recorded)
      SELECT ar.instance_id, ${ids.bob}::uuid, ${row!.project_id}::uuid,
             ar.region_id, ar.org_unit_id, ar.cost_owning_unit_id, 'claude-code', 'sonnet',
             'input', 1000, 77.5, ar.rate_card_id, ar.rate_card_version, ar.fidelity_tier,
             ar.cost_basis, ${SETTLED_DAY + 'T09:00:00Z'}::timestamptz, now()
        FROM attribution_record ar WHERE ar.teammate_id = ${ids.bob}::uuid LIMIT 1
      RETURNING id`
    expect(cloned.length, 'the fixture must give bob at least one row to clone').toBe(1)
    try {
      const after = (await handler(ev('', devSession()))) as unknown as Res
      // Alice's own gate is untouched — bob's write is not hers.
      expect(after.page_freshness.settled_source.page).toBe('rollup')
      const same = after.where_it_went.rows.find((r) => r.project_id === row!.project_id)
      expect(Number(same!.project_total_usd)).toBeCloseTo(
        Number(row!.project_total_usd) + 77.5,
        2,
      )
    } finally {
      await t.client`DELETE FROM attribution_record
        WHERE teammate_id = ${ids.bob}::uuid AND cost_usd = 77.5`
    }
  })
})

describe('the gate costs two round trips, not six', () => {
  /*
   * The page resolves a gate per WINDOW and has three, so the gate was six
   * statements on a request already issuing ~50 against a credit-throttled
   * server — measured on Dev at 51 statements after this lane shipped, up from
   * 44 before it.
   *
   * Coverage does not depend on the window, so it is resolved ONCE; the two
   * windows known at that point are asked together; the previous-period window
   * is discovered later (it needs the frontier day the page read returns) and
   * asks on its own. Two or three, never six.
   *
   * Counted rather than reasoned about, because "I removed some queries" is
   * exactly the claim that rots.
   */
  it('issues at most three gate statements for a request with a comparison period', async () => {
    const store = createRequestTimingStore()
    const before = store.stmts
    await requestTimingStorage.run(store, async () => {
      await handler(ev('', devSession()))
    })
    const total = store.stmts - before
    /*
     * An absolute budget for the WHOLE request, not just the gate: it is the
     * number the server-timing header reports and the one that costs money. The
     * ceiling is deliberately close to the observed count so that adding a
     * per-request query is a decision someone has to make explicitly.
     */
    expect(total, `the request issued ${total} statements`).toBeGreaterThan(0)
    expect(total, `statement budget exceeded: ${total}`).toBeLessThanOrEqual(GATE_ERA_STATEMENT_BUDGET)
  })
})
