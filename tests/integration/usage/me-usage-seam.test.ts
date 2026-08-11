// @vitest-environment node
/*
 * ADR 0012 decision 1 — "My usage" reads the same §A seam as every other
 * project surface, and is month-TO-DATE.
 *
 * getMyUsage used to be hand-rolled: an OTel sum over attribution_record plus a
 * scalar subquery over unaccounted_usage, with its own copy of the quarantine
 * exclusion. PR #217 moved five project surfaces onto v_complete_usage and left
 * this one behind, so the homepage hero and the project page could disagree
 * about the same project BY CONSTRUCTION — two definitions of one figure.
 *
 * It was also bounded BELOW only (`ts_event >= monthStart`, no upper bound), so
 * a row dated later this month counted toward a month-TO-DATE headline. #217
 * introduced monthToDateWindow for exactly this; the two developer heroes were
 * the last unbounded callers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { UnallocatedSummary } from '../../../server/utils/me-queries'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { getMyUsage } from '../../../server/utils/me-queries'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''
let projectId = ''
let instanceId = ''

/** Fixed clock: mid-month, so "later this month" is a reachable state. */
const NOW = new Date('2026-06-15T12:00:00.000Z')

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'ms', displayName: 'MS' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ms', code: 'ms-bu', displayName: 'MS', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ms', email: 'ms@x.test', displayName: 'MS', regionId, orgUnitId })
    .returning()
  teammateId = tm!.id
  const [pr] = await t.db
    .insert(schema.project)
    .values({ code: 'ms-proj', codeHash: 'h-ms-proj', displayName: 'MS Project', type: 'billable', regionId, costOwningUnitId: orgUnitId })
    .returning()
  projectId = pr!.id

  await t.client`INSERT INTO instance_attestation
      (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p-ms', ${teammateId}::uuid, 'claude-code', ${regionId}::uuid, ${orgUnitId}::uuid, 'h', 'P')`
  const [inst] = await t.client<{ id: string }[]>`
    SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`
  instanceId = inst!.id
})

afterAll(async () => {
  await stopTestDb(t)
})

/** An OTel emission (arm 1) at an explicit instant. */
async function emit(tsIso: string, costUsd: number, session: string): Promise<void> {
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, project_id, tool, model, token_type,
       tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instanceId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${orgUnitId}::uuid,
            ${projectId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100, ${costUsd},
            'tier-1', 'estimated', ${tsIso}::timestamptz, ${session})`
}

async function bucketCost(): Promise<number> {
  const usage = await getMyUsage(t.db, teammateId, NOW)
  const b = usage.buckets.find((x) => x.project_code === 'ms-proj')
  return b ? Number(b.cost_usd) : 0
}

describe('month-to-date, not month-unbounded', () => {
  it('counts spend that has already happened', async () => {
    await emit('2026-06-10T00:00:00.000Z', 11, 'sess-past')
    expect(await bucketCost()).toBeCloseTo(11, 2)
  })

  it('EXCLUDES a row dated later this month', async () => {
    /*
     * The defect this closes. A clock-skewed emission or a backfill dated
     * 2026-06-20 is inside the calendar month but has NOT been spent as of the
     * 15th. Counting it inflates a figure whose own label says "month to date",
     * and would page a developer for a budget they have not yet blown.
     */
    await emit('2026-06-20T00:00:00.000Z', 500, 'sess-future')
    expect(await bucketCost()).toBeCloseTo(11, 2)
    expect(await bucketCost()).not.toBeCloseTo(511, 2)
  })

  it('excludes a row from a DIFFERENT month, in both directions', async () => {
    await emit('2026-05-31T23:59:59.000Z', 700, 'sess-prev')
    await emit('2026-07-01T00:00:01.000Z', 900, 'sess-next')
    expect(await bucketCost()).toBeCloseTo(11, 2)
  })
})

describe('one lane, through the seam', () => {
  it('sums OTel and the reconciled API gap as ONE figure', async () => {
    /*
     * Arm 1 (attribution_record) and arm 2 (unaccounted_usage tagged to the
     * project) are both this developer's spend on this budget. The seam unions
     * them; the old code added a scalar subquery to a join and had to keep the
     * two windows in step by hand.
     */
    await t.db.insert(schema.unaccountedUsage).values({
      teammateId,
      regionId,
      orgUnitId,
      day: '2026-06-12',
      tool: 'claude-code',
      costUsd: '7',
      projectId,
      source: 'api-reconciled',
    })
    expect(await bucketCost()).toBeCloseTo(18, 2) // 11 OTel + 7 reconciled
  })

  it('agrees with v_complete_usage read directly for the same teammate+project', async () => {
    // The seam IS the definition. If these diverge, "My usage" has grown a
    // second one again — which is the whole defect ADR 0012 decision 1 names.
    const [row] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total
      FROM v_complete_usage
      WHERE teammate_id = ${teammateId}::uuid
        AND project_id = ${projectId}::uuid
        AND ts_event >= '2026-06-01T00:00:00.000Z'::timestamptz
        AND ts_event <  ${NOW.toISOString()}::timestamptz`
    expect(await bucketCost()).toBeCloseTo(Number(row!.total), 2)
  })

  it('excludes a dev-confirmed forgery, via the view rather than a local copy', async () => {
    /*
     * The quarantine exclusion used to be spelled out inline here AND in the
     * view. Two copies of an integrity rule is how one of them stops matching.
     */
    await emit('2026-06-11T00:00:00.000Z', 250, 'sess-forged')
    await t.client`INSERT INTO session_quarantine
        (conversation_id, instance_id, teammate_id, region_id, org_unit_id,
         session_ts_start, session_ts_end, instance_ts_start, reason)
      VALUES ('sess-forged', ${instanceId}::uuid, ${teammateId}::uuid, ${regionId}::uuid,
              ${orgUnitId}::uuid, now(), now(), now(), 'api-uncorroborated')`
    try {
      expect(await bucketCost()).toBeCloseTo(18, 2) // the 250 must not appear
    } finally {
      await t.client`DELETE FROM session_quarantine WHERE conversation_id = 'sess-forged'`
      await t.client`DELETE FROM attribution_record WHERE claude_session_id = 'sess-forged'`
    }
  })
})

/*
 * ── ARM 3: IN THE TOTAL, OUT OF THE QUEUE ───────────────────────────────────
 *
 * ADR 0012 decision 1a — "your usage" means ALL of it on the patterns surface.
 * The unallocated read was hand-rolled off `attribution_record` UNION
 * `unaccounted_usage`: arms 1 and 2 only. Migration 0101 added a third §A arm to
 * `v_complete_usage` for usage that can never be OTel-emitted or reconciled into
 * a taggable row (the non-Code Claude surfaces; the Copilot coding-agent lane),
 * and it carries `project_id` NULL BY CONSTRUCTION — so it is unallocated spend
 * that the reporting surfaces counted and the developer's own headline did not.
 *
 * The other half is the reason this could not just be added to `untagged`: the
 * needs-tagging worklist is a queue of decisions the developer can act on, and
 * there is no session and no `unaccounted_usage` row here to attach a project or
 * an activity to. (Not "no reconciled row" — the coding-agent branch below is
 * sourced from `reconciliation_record`; the row it lacks is the taggable one.)
 * Untaggable and untagged are different states — the same split the
 * reporting coverage note makes on `usage_provenance`.
 */
describe('the untaggable arm (mig 0101) counts as usage without becoming work', () => {
  /** A non-Code Claude surface (actual_spend → v_teammate_usage_daily → arm 3). */
  const CLAUDE_AI_USD = 25
  /** The coding-agent lane (reconciliation_record → the same arm, other branch). */
  const COPILOT_AGENT_USD = 18
  /** An ORDINARY untagged conversation — the control the queue must still hold. */
  const UNTAGGED_USD = 4

  const unallocated = async (): Promise<UnallocatedSummary> =>
    (await getMyUsage(t.db, teammateId, NOW)).unallocated

  beforeAll(async () => {
    // Arm 1, no project claim: a real needs-tagging item. Without it every
    // "arm 3 is not in the queue" assertion below would sit on a queue that is
    // empty anyway, and could not fail.
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, project_id, tool, model, token_type,
         tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${instanceId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${orgUnitId}::uuid,
              NULL, 'claude-code', 'claude-sonnet-4-6', 'input', 100, ${UNTAGGED_USD},
              'tier-1', 'estimated', '2026-06-13T00:00:00.000Z'::timestamptz, 'sess-untagged')`
    await t.client`INSERT INTO actual_spend
        (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
         region_id, org_unit_id, cost_owning_unit_id, dimension_source)
      VALUES (${teammateId}::uuid, '2026-06-12'::date, 'claude-ai', 1000, 1000, ${CLAUDE_AI_USD},
              'anthropic-analytics-api', ${regionId}::uuid, ${orgUnitId}::uuid, ${orgUnitId}::uuid,
              'ingest-snapshot')`
    await t.client`INSERT INTO reconciliation_record
        (teammate_id, provider, enterprise_ref, period_date, category, scope, region_id, org_unit_id,
         cost_owning_unit_id, actual_qty, actual_unit_type, actual_usd, otel_attributed_usd, delta_usd,
         spend_class, disposition, status)
      VALUES (${teammateId}::uuid, 'github', 'ent-ms', '2026-06-14'::date, 'copilot_coding_agent',
              'teammate', ${regionId}::uuid, ${orgUnitId}::uuid, ${orgUnitId}::uuid,
              '10', 'ai-credits', ${String(COPILOT_AGENT_USD)}, '0', ${String(COPILOT_AGENT_USD)},
              'indicative', 'ingest_only', 'proposed')`
  })

  it('counts provider-only usage in the unallocated total, both branches of the arm', async () => {
    const u = await unallocated()
    expect(Number(u.untaggable_cost_usd)).toBeCloseTo(CLAUDE_AI_USD + COPILOT_AGENT_USD, 2)
    // Each branch on its own, so a total that happened to match with one branch
    // missing and the other doubled would still be red.
    expect(Number(u.untaggable_cost_usd)).not.toBeCloseTo(CLAUDE_AI_USD, 2)
    expect(Number(u.untaggable_cost_usd)).not.toBeCloseTo(COPILOT_AGENT_USD, 2)
    expect(Number(u.total_cost_usd)).toBeCloseTo(
      UNTAGGED_USD + CLAUDE_AI_USD + COPILOT_AGENT_USD,
      2,
    )
    // The figure that was shipped before this change — the whole arm dropped.
    expect(Number(u.total_cost_usd)).not.toBeCloseTo(UNTAGGED_USD, 2)
  })

  it('keeps it OUT of the needs-tagging queue — untaggable is not untagged', async () => {
    const u = await unallocated()
    // Guard the guard: the queue holds the ordinary untagged conversation, so
    // "arm 3 is absent from it" is a claim that can fail.
    expect(u.needs_tagging_count).toBe(1)
    expect(u.needs_tagging_sessions).toBe(1)
    expect(u.needs_tagging_days).toBe(0)
    expect(Number(u.untagged_cost_usd)).toBeCloseTo(UNTAGGED_USD, 2)
    expect(Number(u.untagged_cost_usd)).not.toBeCloseTo(
      UNTAGGED_USD + CLAUDE_AI_USD + COPILOT_AGENT_USD,
      2,
    )
  })

  it('the four buckets still foot to the unallocated total', async () => {
    // The identity the summary's own contract states. Adding a fourth bucket to
    // the total without adding it to the split would break it silently.
    const u = await unallocated()
    expect(
      Number(u.tagged_cost_usd) +
        Number(u.untagged_cost_usd) +
        Number(u.dismissed_cost_usd) +
        Number(u.untaggable_cost_usd),
    ).toBeCloseTo(Number(u.total_cost_usd), 2)
  })

  it('agrees with v_complete_usage arm 3 read directly — one definition, not two', async () => {
    // The seam IS the definition (the same standard the bucket path is held to
    // above). `usage_provenance = 'provider-usage'` selects exactly arm 3.
    const [row] = await t.client<{ total: string; items: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total, COUNT(*)::text AS items
      FROM v_complete_usage
      WHERE teammate_id = ${teammateId}::uuid
        AND project_id IS NULL
        AND usage_provenance = 'provider-usage'
        AND ts_event >= '2026-06-01T00:00:00.000Z'::timestamptz`
    const u = await unallocated()
    expect(Number(u.untaggable_cost_usd)).toBeCloseTo(Number(row!.total), 2)
    expect(u.untaggable_count).toBe(Number(row!.items))
  })

  it('adds nothing to a project bucket — arm 3 has no project to belong to', async () => {
    // `project_id` is NULL by construction on this arm, so a budget figure that
    // moved would mean the arm had been joined somewhere it does not belong.
    expect(await bucketCost()).toBeCloseTo(18, 2)
  })
})
