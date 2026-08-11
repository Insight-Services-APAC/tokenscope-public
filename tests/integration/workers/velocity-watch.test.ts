// @vitest-environment node
/*
 * velocity-watch worker — integration test over a real testcontainers
 * Postgres so the ISO-week aggregation SQL is exercised end-to-end (per
 * AGENTS.md anti-pattern §"Never mock Drizzle — use a real test DB").
 *
 * Covers:
 *  1. happy path — week 5 ≈ 45% over the prior 4-week mean → one
 *     velocity-warning is dispatched with the body shape DrawerBodyVelocity
 *     expects.
 *  2. below-threshold — 10% over the mean → no dispatch.
 *  3. insufficient-history — only 2 prior weeks → no dispatch (needs 4).
 *  4. idempotency — running twice yields one item, second run reports
 *     skippedExisting=1.
 *  5. governance dial — a REGION override of 'velocity.spike_threshold'
 *     (mig 0049) fires a spike that the platform default would let pass,
 *     while teammates in other regions stay on the platform bar.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { runVelocityWatch } from '../../../server/workers/velocity-watch'

let t: TestDb
// Fixed "now" — a Wednesday — so the current ISO week is unambiguous.
const NOW = new Date(Date.UTC(2026, 5, 17, 12, 0, 0)) // Wed 17-Jun-2026

// Pre-allocated identity scaffolding shared by all tests. Each test creates
// its own teammate to keep fixtures isolated.
let regionId: string
let buId: string
let projectId: string
let rateCardId: string
let rateCardVersion: number

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'vw', displayName: 'Velocity Watch Region' })
    .returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'vw.svc',
      code: 'vw-svc',
      displayName: 'VW Services',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  buId = bu!.id
  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: 'VW-1',
      codeHash: 'h-vw-1',
      displayName: 'Velocity Watch Project',
      type: 'billable',
      regionId,
      costOwningUnitId: buId,
    })
    .returning()
  projectId = proj!.id

  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)
  rateCardId = rc!.id
  rateCardVersion = rc!.version
}, 90_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

/**
 * Compute the Monday-start (UTC) of the ISO week containing `d`.
 * Mirrors the helper inside server/workers/velocity-watch.ts so the
 * tests don't need to import private helpers.
 */
function isoWeekStartUtc(d: Date): Date {
  const day = d.getUTCDay()
  const offset = (day + 6) % 7
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset),
  )
}

function addWeeksUtc(d: Date, weeks: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 7 * weeks),
  )
}

async function createTeammate(
  suffix: string,
  scope?: { regionId: string; orgUnitId: string },
): Promise<string> {
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-vw-${suffix}`,
      email: `${suffix}@vw.test`,
      displayName: `VW ${suffix}`,
      regionId: scope?.regionId ?? regionId,
      orgUnitId: scope?.orgUnitId ?? buId,
    })
    .returning()
  return tm!.id
}

/**
 * Emit a single attribution_record (with its parent instance_attestation)
 * at the given timestamp for the given teammate, with the given cost.
 */
async function emit(
  teammateId: string,
  when: Date,
  costUsd: number,
  identityState?: string,
): Promise<void> {
  const sid = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: sid,
    principalOid: `oid-${teammateId}`,
    teammateId,
    projectCodeHash: 'h-vw-1',
    rawProjectCode: 'VW-1',
    tool: 'claude-code',
    sessionTokenHash: 'tok-vw-' + sid,
    tsStart: when,
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId: sid,
    teammateId,
    projectId,
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
    tool: 'claude-code',
    model: 'claude-opus-4-1',
    tokenType: 'output',
    tokens: BigInt(1000),
    costUsd: costUsd.toFixed(6),
    rateCardId,
    rateCardVersion,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    identityState,
    tsEvent: when,
  })
}

/** Copilot §A usage — lands in unaccounted_usage, never attribution_record. */
async function emitCopilot(teammateId: string, when: Date, costUsd: number): Promise<void> {
  await t.db.insert(schema.unaccountedUsage).values({
    teammateId,
    regionId,
    orgUnitId: buId,
    projectId,
    day: when.toISOString().slice(0, 10),
    tool: 'copilot-cli',
    costUsd: costUsd.toFixed(6),
    tokens: 0n,
  })
}

/** Ingest-only §A usage (mig 0101, A3) — a non-Code Claude surface, landing in
 *  actual_spend and reaching v_complete_usage ONLY through the third,
 *  non-taggable completeness arm (never attribution_record, never
 *  unaccounted_usage). */
async function emitIngestOnly(teammateId: string, when: Date, costUsd: number): Promise<void> {
  await t.db.insert(schema.actualSpend).values({
    teammateId,
    date: when.toISOString().slice(0, 10),
    tool: 'claude-ai',
    inputTokens: 0n,
    outputTokens: 0n,
    costUsd: costUsd.toFixed(6),
    source: 'anthropic-analytics-api',
  })
}

describe('runVelocityWatch', () => {
  it('dispatches a velocity-warning when current week is >25% over 4-week mean', async () => {
    const teammateId = await createTeammate('happy')
    const currentWeek = isoWeekStartUtc(NOW)
    // Weeks 1..4 = $100 each (single emit); week 5 = $145 (single emit).
    for (let i = 4; i >= 1; i--) {
      const when = addWeeksUtc(currentWeek, -i)
      // Place each event mid-week (Wednesday) so it's unambiguously in
      // that ISO week.
      const midWeek = new Date(when.getTime() + 2 * 24 * 60 * 60 * 1000)
      await emit(teammateId, midWeek, 100)
    }
    const currentMid = new Date(currentWeek.getTime() + 2 * 24 * 60 * 60 * 1000)
    await emit(teammateId, currentMid, 145)

    const result = await runVelocityWatch(t.db, { now: NOW })
    expect(result.alertsDispatched).toBe(1)
    expect(result.skippedExisting).toBe(0)

    const rows = await t.client<{
      subject: string
      category: string
      severity: string
      body: {
        weeklySeries?: number[]
        meanUsd?: number
        currentUsd?: number
        deltaPct?: number
      }
      related_entity_kind: string | null
      related_entity_id: string | null
    }[]>`
      SELECT subject, category, severity,
             body::jsonb AS body,
             related_entity_kind,
             related_entity_id::text AS related_entity_id
      FROM inbox_item
      WHERE recipient_teammate_id = ${teammateId}::uuid
        AND category = 'velocity-warning'
    `
    expect(rows.length).toBe(1)
    const item = rows[0]!
    expect(item.category).toBe('velocity-warning')
    expect(item.related_entity_kind).toBe('teammate')
    expect(item.related_entity_id).toBe(teammateId)
    expect(Array.isArray(item.body.weeklySeries)).toBe(true)
    expect(item.body.weeklySeries!.length).toBe(5)
    expect(item.body.currentUsd).toBeCloseTo(145, 2)
    expect(item.body.meanUsd).toBeCloseTo(100, 2)
    expect(item.body.deltaPct).toBeCloseTo(0.45, 2)
    expect(item.subject).toContain('+45%')
  })

  it('does not dispatch when current week is only 10% above mean', async () => {
    const teammateId = await createTeammate('below')
    const currentWeek = isoWeekStartUtc(NOW)
    for (let i = 4; i >= 1; i--) {
      const midWeek = new Date(addWeeksUtc(currentWeek, -i).getTime() + 2 * 86_400_000)
      await emit(teammateId, midWeek, 100)
    }
    await emit(teammateId, new Date(currentWeek.getTime() + 2 * 86_400_000), 110)

    await runVelocityWatch(t.db, { now: NOW })

    // Assert per-teammate (the global counter is polluted by sibling tests'
    // happy-path teammate which legitimately re-flags every run).
    const rows = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM inbox_item
      WHERE recipient_teammate_id = ${teammateId}::uuid
        AND category = 'velocity-warning'
    `
    expect(rows.length).toBe(0)
  })

  it('does not dispatch when teammate has fewer than 4 prior weeks of data', async () => {
    const teammateId = await createTeammate('thin')
    const currentWeek = isoWeekStartUtc(NOW)
    // Only 2 prior weeks of data + current week.
    for (const i of [2, 1]) {
      const midWeek = new Date(addWeeksUtc(currentWeek, -i).getTime() + 2 * 86_400_000)
      await emit(teammateId, midWeek, 100)
    }
    await emit(teammateId, new Date(currentWeek.getTime() + 2 * 86_400_000), 500)

    await runVelocityWatch(t.db, { now: NOW })

    const rows = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM inbox_item
      WHERE recipient_teammate_id = ${teammateId}::uuid
        AND category = 'velocity-warning'
    `
    expect(rows.length).toBe(0)
  })

  it('is idempotent: a second run within the same week skips the existing item', async () => {
    const teammateId = await createTeammate('idem')
    const currentWeek = isoWeekStartUtc(NOW)
    for (let i = 4; i >= 1; i--) {
      const midWeek = new Date(addWeeksUtc(currentWeek, -i).getTime() + 2 * 86_400_000)
      await emit(teammateId, midWeek, 100)
    }
    await emit(teammateId, new Date(currentWeek.getTime() + 2 * 86_400_000), 145)

    // First run dispatches the warning. We assert per-teammate row count
    // rather than the global counters because sibling tests' teammates
    // may also be flagged in the same scan (their inbox items predate
    // the simulated currentWeekStart so the idempotency check lets them
    // through). The producer's per-teammate behaviour is what matters.
    await runVelocityWatch(t.db, { now: NOW })

    const afterFirst = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM inbox_item
      WHERE recipient_teammate_id = ${teammateId}::uuid
        AND category = 'velocity-warning'
    `
    expect(afterFirst.length).toBe(1)

    // Manually backdate the item we just dispatched so the idempotency
    // check sees it as created during the simulated current week, not
    // at real wall-clock time. Without this hop the test would need a
    // dedicated isolated DB; with it the per-teammate idempotency rule
    // is exercised end-to-end.
    await t.db.execute(sql`
      UPDATE inbox_item
      SET created_at = ${currentWeek.toISOString()}::timestamptz + INTERVAL '1 day'
      WHERE recipient_teammate_id = ${teammateId}::uuid
        AND category = 'velocity-warning'
    `)

    await runVelocityWatch(t.db, { now: NOW })

    const afterSecond = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM inbox_item
      WHERE recipient_teammate_id = ${teammateId}::uuid
        AND category = 'velocity-warning'
    `
    expect(afterSecond.length).toBe(1)
  })

  it('excludes PROVISIONAL usage from the velocity signal (no manager page)', async () => {
    // A current-week spike made entirely of PROVISIONAL (emit-on-install,
    // pre-confirmation) usage must not page a manager. The prior 4 weeks are
    // confirmed (NULL); the current week is a big provisional spike that WOULD
    // fire (+145%) if it were counted — but it's excluded, so currentUsd=0.
    const provId = await createTeammate('provisional')
    const currentWeek = isoWeekStartUtc(NOW)
    for (let i = 4; i >= 1; i--) {
      const midWeek = new Date(addWeeksUtc(currentWeek, -i).getTime() + 2 * 86_400_000)
      await emit(provId, midWeek, 100) // confirmed (NULL) baseline
    }
    await emit(provId, new Date(currentWeek.getTime() + 2 * 86_400_000), 245, 'provisional')

    // Contrast teammate: identical shape but the spike is CONFIRMED -> fires.
    const confId = await createTeammate('confirmed')
    for (let i = 4; i >= 1; i--) {
      const midWeek = new Date(addWeeksUtc(currentWeek, -i).getTime() + 2 * 86_400_000)
      await emit(confId, midWeek, 100)
    }
    await emit(confId, new Date(currentWeek.getTime() + 2 * 86_400_000), 245, 'confirmed')

    await runVelocityWatch(t.db, { now: NOW })

    const prov = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM inbox_item
      WHERE recipient_teammate_id = ${provId}::uuid AND category = 'velocity-warning'
    `
    expect(prov.length).toBe(0) // provisional spike suppressed
    const conf = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM inbox_item
      WHERE recipient_teammate_id = ${confId}::uuid AND category = 'velocity-warning'
    `
    expect(conf.length).toBe(1) // confirmed spike still pages
  })

  it('a region override of the spike-threshold dial fires below the platform bar', async () => {
    // A second region with a 5% override: +10% over the mean is below the
    // platform default (25%, the "below" test above) but above this region's
    // bar — so the SAME spike shape that stayed quiet there fires here.
    const [r2] = await t.db
      .insert(schema.region)
      .values({ code: 'vw2', displayName: 'VW Override Region' })
      .returning()
    const [bu2] = await t.db
      .insert(schema.orgUnit)
      .values({
        regionId: r2!.id,
        path: 'vw2.svc',
        code: 'vw2-svc',
        displayName: 'VW2 Services',
        unitType: 'bu',
        isCostOwningUnit: true,
      })
      .returning()
    await t.db.insert(schema.governanceSetting).values({
      key: 'velocity.spike_threshold',
      scopeType: 'region',
      scopeId: r2!.id,
      valueNumeric: '0.05',
    })

    const teammateId = await createTeammate('dialled', { regionId: r2!.id, orgUnitId: bu2!.id })
    const currentWeek = isoWeekStartUtc(NOW)
    for (let i = 4; i >= 1; i--) {
      const midWeek = new Date(addWeeksUtc(currentWeek, -i).getTime() + 2 * 86_400_000)
      await emit(teammateId, midWeek, 100)
    }
    await emit(teammateId, new Date(currentWeek.getTime() + 2 * 86_400_000), 110)

    await runVelocityWatch(t.db, { now: NOW })

    const rows = await t.client<{ subject: string; body: { deltaPct?: number } }[]>`
      SELECT subject, body::jsonb AS body FROM inbox_item
      WHERE recipient_teammate_id = ${teammateId}::uuid
        AND category = 'velocity-warning'
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.body.deltaPct).toBeCloseTo(0.1, 2)
  })

  it('SCHEDULE: fires on the end-of-week clock it is actually cronned at (Sun 23:50)', async () => {
    // The worker evaluates the week CONTAINING `now` against 4 full trailing
    // weeks. Cronned at Monday 09:00 the current week was 9 hours old, so a spike
    // could not clear mean x threshold and the job would run green forever
    // without firing — the silent-no-op trap, inside the PR that exists to close
    // it. Every other test here uses a mid-week clock and could not see it.
    // Cron is now '50 23 * * 0'; this pins that a run at that instant DOES fire.
    const teammateId = await createTeammate('sunday-night')
    const sundayNight = new Date(Date.UTC(2026, 5, 21, 23, 50, 0)) // Sun 21-Jun-2026
    const currentWeek = isoWeekStartUtc(sundayNight)
    for (let i = 4; i >= 1; i--) {
      const midWeek = new Date(currentWeek.getTime() - i * 7 * 86_400_000 + 2 * 86_400_000)
      await emit(teammateId, midWeek, 100)
    }
    await emit(teammateId, new Date(currentWeek.getTime() + 2 * 86_400_000), 145)

    const res = await runVelocityWatch(t.db, { now: sundayNight })
    expect(res.alertsDispatched).toBeGreaterThanOrEqual(1)
    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'velocity-warning' AND recipient_teammate_id = ${teammateId}::uuid`
    expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(1)
  })

  it('COPILOT-ONLY teammate is scanned and can spike (was invisible before)', async () => {
    // A teammate whose spend is entirely Copilot has ZERO attribution_record rows,
    // so the old worker never even scanned them — they could never trip a spike
    // no matter how sharply their burn rose.
    const teammateId = await createTeammate('copilot-only')
    const currentWeek = isoWeekStartUtc(NOW)
    for (let i = 4; i >= 1; i--) {
      const midWeek = new Date(currentWeek.getTime() - i * 7 * 86_400_000 + 2 * 86_400_000)
      await emitCopilot(teammateId, midWeek, 100)
    }
    await emitCopilot(teammateId, new Date(currentWeek.getTime() + 2 * 86_400_000), 145)

    const res = await runVelocityWatch(t.db, { now: NOW })
    expect(res.alertsDispatched).toBeGreaterThanOrEqual(1)
    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'velocity-warning' AND recipient_teammate_id = ${teammateId}::uuid`
    expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(1)
  })

  it('a claude->copilot TOOL SWITCH is not read as a velocity drop', async () => {
    // Same total burn, different tool: prior weeks claude, current week copilot.
    // Reading attribution_record alone showed the current week as ~0 (a spurious
    // drop); the complete lane sees flat spend and correctly does NOT fire.
    const teammateId = await createTeammate('switcher')
    const currentWeek = isoWeekStartUtc(NOW)
    for (let i = 4; i >= 1; i--) {
      const midWeek = new Date(currentWeek.getTime() - i * 7 * 86_400_000 + 2 * 86_400_000)
      await emit(teammateId, midWeek, 100)
    }
    await emitCopilot(teammateId, new Date(currentWeek.getTime() + 2 * 86_400_000), 100)

    await runVelocityWatch(t.db, { now: NOW })
    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'velocity-warning' AND recipient_teammate_id = ${teammateId}::uuid`
    expect(Number(rows[0]!.c)).toBe(0) // flat, not a spike
  })

  it('an INGEST-ONLY-only teammate (non-Code Claude surfaces) is scanned and can spike (mig 0101, A3 — untaggable provider-only spend is velocity-eligible)', async () => {
    /*
     * design §3.1 "Safety — worklist yes, alerts no (R1-M2)": untaggable
     * provider-only spend (the non-Code Claude surfaces, copilot-agent) is
     * VELOCITY-eligible — it is real spend by a real person — even though it
     * can never belong to a project budget. Before migration 0101 these
     * surfaces had ZERO v_complete_usage rows (excluded from both arms), so a
     * teammate whose ENTIRE spend was e.g. Claude Chat could never trip a
     * spike, mirroring the pre-fix Copilot-only blind spot above. Arm 3 fixes
     * this the same way arm 2 fixed Copilot.
     */
    const teammateId = await createTeammate('ingest-only')
    const currentWeek = isoWeekStartUtc(NOW)
    for (let i = 4; i >= 1; i--) {
      const midWeek = new Date(currentWeek.getTime() - i * 7 * 86_400_000 + 2 * 86_400_000)
      await emitIngestOnly(teammateId, midWeek, 100)
    }
    await emitIngestOnly(teammateId, new Date(currentWeek.getTime() + 2 * 86_400_000), 145)

    const res = await runVelocityWatch(t.db, { now: NOW })
    expect(res.alertsDispatched).toBeGreaterThanOrEqual(1)
    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'velocity-warning' AND recipient_teammate_id = ${teammateId}::uuid`
    expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(1)
  })

})

