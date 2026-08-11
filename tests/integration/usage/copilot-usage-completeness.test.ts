// @vitest-environment node
/*
 * §A usage completeness for COPILOT — the per-(teammate, day) usage truth is GitHub's
 * ai_credit/usage (per-(user, day), verified live), persisted as reconciliation_record.actual_usd
 * (GROSS, scope='teammate', status='proposed'). The v_teammate_usage_daily view (mig 0073) sources
 * copilot usage from there, LANED by category since mig 0086 (D4): copilot_interactive →
 * 'copilot-cli' (unaccounted + over-emission work exactly like Claude), copilot_coding_agent →
 * 'copilot-agent' (OTel-invisible / ingest_only → usage DISPLAY only: never a taggable
 * unaccounted record, never OTel-joined).
 *
 * Mig 0101 (Workstream A, §3.1 A3) adds v_complete_usage's third, ingest-only completeness
 * arm, so 'copilot-agent' is NOW also visible through v_complete_usage (Across/Regional/
 * Cost-Centre usage cards, velocity-watch) — closing the divergence this file used to pin as
 * deliberate ("an owner follow-up, deliberately not done here", mig 0086's own header). It
 * remains permanently absent from unaccounted_usage (the needs-tagging worklist): visible ≠
 * taggable, and that distinction is what mig 0101 generalises rather than removes.
 *
 * This is the correction to the earlier wrong call that Copilot had "no per-day usage truth": it
 * always did — the §A readers just weren't reading reconciliation_record. The Copilot per-cost-centre
 * POOLED bill (§B) is a different axis and is deliberately NOT the §A usage source.
 * docs/design/provider-billing-attribution-model.md §A.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { detectOverEmission } from '../../../server/usage/over-emission-detection'
import { reconcileUnaccountedUsage } from '../../../server/usage/unaccounted-reconciliation'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''
let instanceId = ''
const WINDOW = { startDate: '2026-06-01', endDate: '2026-06-30' }
const DAY = '2026-06-20'

/** The per-user Copilot GROSS usage the engine persists from GitHub ai_credit/usage (the §A truth). */
async function copApiUsage(
  grossUsd: string,
  opts: { category?: string; enterpriseRef?: string; status?: string } = {},
): Promise<void> {
  await t.db.insert(schema.reconciliationRecord).values({
    teammateId, provider: 'github', enterpriseRef: opts.enterpriseRef ?? 'ent-demo', licenseOrg: 'org-demo',
    periodDate: DAY, category: opts.category ?? 'copilot_interactive', scope: 'teammate', regionId, orgUnitId,
    actualQty: '100', actualUnitType: 'ai-credits', actualUsd: grossUsd,
    otelAttributedUsd: '0', deltaUsd: '0', spendClass: 'indicative',
    indicativeReason: 'copilot-pre-billing', disposition: 'untagged', status: opts.status ?? 'proposed',
  })
}
/** A Copilot OTel session (attribution_record tool='copilot-cli'). */
async function otelCop(conv: string, costUsd: string): Promise<void> {
  await t.db.insert(schema.attributionRecord).values({
    instanceId, claudeSessionId: conv, teammateId, regionId, orgUnitId,
    tool: 'copilot-cli', model: 'gpt', tokenType: 'output', tokens: 1000n, costUsd,
    fidelityTier: 'tier-1', costBasis: 'estimated', tsEvent: new Date(`${DAY}T12:00:00.000Z`), sourceRunId: randomUUID(),
  })
}

beforeAll(async () => {
  t = await startTestDb(); process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'cp', displayName: 'CP' }).returning(); regionId = r!.id
  const [ou] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'cp', code: 'cp-bu', displayName: 'CP', unitType: 'bu', isCostOwningUnit: true }).returning(); orgUnitId = ou!.id
  const [tm] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-cp', email: 'cp@x.test', regionId, orgUnitId }).returning(); teammateId = tm!.id
  instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({ instanceId, principalOid: 'oid-cp', teammateId, projectCodeHash: 'h', rawProjectCode: 'CP', tool: 'copilot-cli', tsStart: new Date('2026-06-01T00:00:00Z'), regionId, orgUnitId })
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)
beforeEach(async () => {
  await t.client`DELETE FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM session_quarantine WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM attribution_record WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM reconciliation_record WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM actual_spend WHERE teammate_id = ${teammateId}::uuid`
})

describe('Copilot §A usage completeness', () => {
  it('brings across un-enrolled Copilot usage (API gross $34, OTel $19 → $15 unaccounted)', async () => {
    // The owner's example, for Copilot: an enrolled container emits $19, an un-enrolled one
    // spends $15 silently; GitHub's per-user usage knows the full $34. The $15 must come across.
    await copApiUsage('34.00')
    await otelCop('cop-enrolled', '19.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const [row] = await t.client<{ tool: string; cost: string }[]>`
      SELECT tool, cost_usd::text AS cost FROM unaccounted_usage
      WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date AND cost_usd > 0`
    expect(row!.tool).toBe('copilot-cli')
    expect(Number(row!.cost)).toBeCloseTo(15, 2)
  })

  it('v_teammate_usage_daily lanes copilot by category: TWO rows per (teammate, day) — copilot-cli + copilot-agent (mig 0086, D4)', async () => {
    await copApiUsage('20.00', { category: 'copilot_interactive' })
    await copApiUsage('14.00', { category: 'copilot_coding_agent' })
    const rows = await t.client<{ tool: string; usd: string; tokens: string | null }[]>`
      SELECT tool, usage_usd::text AS usd, tokens::text AS tokens FROM v_teammate_usage_daily
      WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date ORDER BY tool`
    expect(rows.map((r) => [r.tool, Number(r.usd)])).toEqual([
      ['copilot-agent', 14],
      ['copilot-cli', 20],
    ])
    for (const r of rows) expect(r.tokens).toBeNull() // credits-metered, both lanes
  })

  it('RESOLVED surface divergence (mig 0101, A3): copilot-agent is now visible in v_complete_usage too, via the ingest-only completeness arm — still never taggable', async () => {
    await copApiUsage('20.00', { category: 'copilot_interactive' })
    await copApiUsage('14.00', { category: 'copilot_coding_agent' })
    await otelCop('cop-div', '19.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    // §A usage lane: the coding-agent dollars ARE visible (display lane, mig 0086 —
    // feeds v_teammate_usage_daily readers like the Finance Overage-Drivers weight).
    const lane = await t.client<{ usd: string }[]>`
      SELECT usage_usd::text AS usd FROM v_teammate_usage_daily
      WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date AND tool = 'copilot-agent'`
    expect(lane).toHaveLength(1)
    expect(Number(lane[0]!.usd)).toBe(14)
    /*
     * Completeness lane (v_complete_usage = attribution ∪ unaccounted ∪
     * ingest-only, mig 0101 A3): the coding-agent row is now PRESENT, through
     * the THIRD arm — reading v_teammate_usage_daily filtered to
     * INGEST_ONLY_USAGE_TOOLS, never through arm 1 (still OTel-invisible: no
     * attribution row) or arm 2 (still ingest_only-excluded from
     * unaccounted_usage: the `reconcileUnaccountedUsage` call above produced no
     * copilot-agent row, asserted by the next test). This resolves the
     * divergence the mig 0086 header and this test used to document as an
     * intentional, deliberately-unclosed gap ("an owner follow-up") — the
     * follow-up is migration 0101. Reads 0 rows if arm 3 regresses (the
     * completeness rollups would go blind to coding-agent spend again); reads
     * >1 row if the lane somehow ALSO reaches arm 1 or arm 2 (a double-count —
     * see tests/integration/reports/complete-usage-view.test.ts's disjointness
     * assertions for the general case).
     */
    const complete = await t.client<{ cost: string; model: string | null; provenance: string; identity_state: string; project_id: string | null }[]>`
      SELECT cost_usd::text AS cost, model, usage_provenance AS provenance, identity_state, project_id::text AS project_id
      FROM v_complete_usage WHERE teammate_id = ${teammateId}::uuid AND tool = 'copilot-agent'`
    expect(complete).toHaveLength(1)
    expect(Number(complete[0]!.cost)).toBe(14)
    // model is NULL for a STRUCTURAL reason (no source API exposes a model split
    // for this surface), not an attribution failure — usage_provenance carries
    // that distinction (R1-M3; shared/reports/model-attribution.ts).
    expect(complete[0]!.model).toBeNull()
    expect(complete[0]!.provenance).toBe('provider-usage')
    expect(complete[0]!.identity_state).toBe('confirmed') // bill-anchored, never provisional
    expect(complete[0]!.project_id).toBeNull() // untaggable by construction
  })

  it('coding-agent still NEVER reaches v_complete_usage via arm 1 or arm 2 — only via arm 3 (worklist safety survives A3)', async () => {
    await copApiUsage('14.00', { category: 'copilot_coding_agent' })
    await reconcileUnaccountedUsage(t.db, WINDOW)
    // No unaccounted_usage row for copilot-agent: A2 (INGEST_ONLY_USAGE_TOOLS in
    // reconcileUnaccountedUsage) still excludes it from the needs-tagging worklist.
    const uu = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid AND tool = 'copilot-agent'`
    expect(Number(uu[0]!.n)).toBe(0)
    // No attribution_record row either — the lane is OTel-invisible by nature,
    // not by a filter, so there is nothing for arm 1 to carry.
    const ar = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM attribution_record WHERE teammate_id = ${teammateId}::uuid AND tool = 'copilot-agent'`
    expect(Number(ar[0]!.n)).toBe(0)
    // Exactly one v_complete_usage row (arm 3 only).
    const complete = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM v_complete_usage WHERE teammate_id = ${teammateId}::uuid AND tool = 'copilot-agent'`
    expect(Number(complete[0]!.n)).toBe(1)
  })

  it('coding-agent usage NEVER becomes a taggable unaccounted record (display-only lane, D4); copilot-cli reconciles against interactive ONLY', async () => {
    // Pre-0086 the two categories summed into one copilot-cli row ((20+14) − 19 = 15) and
    // every coding-agent dollar was taggable. Post-split: interactive reconciles on its own
    // basis (20 − 19 = 1) and the coding-agent $14 — OTel-invisible, no session, nothing to
    // tag — produces NO needs-tagging record at all (design D4: usage display only).
    await copApiUsage('20.00', { category: 'copilot_interactive' })
    await copApiUsage('14.00', { category: 'copilot_coding_agent' })
    await otelCop('cop-e', '19.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const rows = await t.client<{ tool: string; cost: string }[]>`
      SELECT tool, cost_usd::text AS cost FROM unaccounted_usage
      WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date ORDER BY tool`
    expect(rows.map((r) => [r.tool, Number(r.cost)])).toEqual([['copilot-cli', 1]])
  })

  it('coding-agent usage never corroborates interactive OTel (over-emission joins per lane; agent lane is never OTel-joined)', async () => {
    // Pre-0086 the coding-agent credits inflated the copilot-cli api_usd and could MASK an
    // uncorroborated interactive emission. Post-split the bases match per lane: OTel $500
    // vs interactive truth $50 flags, regardless of the $500 the agent burned GitHub-side.
    await copApiUsage('50.00', { category: 'copilot_interactive' })
    await copApiUsage('500.00', { category: 'copilot_coding_agent' })
    await otelCop('cop-big', '500.00')
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(1)
    const [flag] = await t.client<{ tool: string; over: string }[]>`
      SELECT tool, over_usd::text AS over FROM over_emission WHERE teammate_id = ${teammateId}::uuid AND over_usd > 0`
    expect(flag!.tool).toBe('copilot-cli') // never 'copilot-agent' — no OTel carries that tool
    expect(Number(flag!.over)).toBeCloseTo(450, 2)
  })

  it('flags a material Copilot over-emission (API $50, OTel $500 → $450 uncorroborated)', async () => {
    await copApiUsage('50.00')
    await otelCop('cop-big', '450.00')
    await otelCop('cop-small', '50.00')
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(1)
    expect(res.totalOverUsd).toBeCloseTo(450, 2)
    const [flag] = await t.client<{ tool: string }[]>`SELECT tool FROM over_emission WHERE teammate_id = ${teammateId}::uuid AND over_usd > 0`
    expect(flag!.tool).toBe('copilot-cli')
  })

  it('does NOT flag Copilot OTel when there is no reconciliation usage (org not onboarded — absence ≠ forgery)', async () => {
    await otelCop('cop-noapi', '300.00') // OTel only, no reconciliation_record row
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(0)
  })

  it('sources Copilot usage from reconciliation_record, NOT actual_spend (no double-count with the §B bill)', async () => {
    // A future §B Copilot bill writer may land copilot-cli rows in actual_spend; those are the
    // POOLED bill, not per-user usage, and must NEVER feed §A. The view excludes them.
    await t.db.insert(schema.actualSpend).values({ teammateId, date: DAY, tool: 'copilot-cli', inputTokens: 0n, outputTokens: 0n, costUsd: '999.00', source: 'copilot-overage' })
    await copApiUsage('34.00')
    await otelCop('cop-x', '19.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const [row] = await t.client<{ cost: string }[]>`
      SELECT cost_usd::text AS cost FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date AND tool = 'copilot-cli'`
    expect(Number(row!.cost)).toBeCloseTo(15, 2) // 34 − 19; the actual_spend 999 is ignored
  })

  it('sums Copilot usage across enterprises (a login holding seats in two enterprises), not a duplicate', async () => {
    // ai_credit/usage returns per-enterprise seat usage for a login; the streams are disjoint, so
    // the §A operand is the SUM. Lock the semantics so a GROUP BY / index change can't regress it.
    await copApiUsage('20.00', { enterpriseRef: 'ent-a' })
    await copApiUsage('14.00', { enterpriseRef: 'ent-b' })
    await otelCop('cop-e', '19.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const [row] = await t.client<{ cost: string }[]>`
      SELECT cost_usd::text AS cost FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date`
    expect(Number(row!.cost)).toBeCloseTo(15, 2) // (20+14) − 19, summed across enterprises
  })

  it('reads the LIVE reconciliation row across the lifecycle (applied beats coexisting proposed; superseded/rejected ignored)', async () => {
    // Guards the load-bearing coupling: §A must follow the current row per logical key, not just
    // 'proposed'. When a future booking worker flips proposed→applied, §A must NOT silently drop it.
    // The 'applied' and 'proposed' rows below share ONE logical key (same category) — the only case
    // that actually exercises the precedence CASE: applied must win over a (newer) proposed.
    await copApiUsage('34.00', { category: 'copilot_interactive', status: 'applied' })       // F2: booked → wins
    await copApiUsage('99.00', { category: 'copilot_interactive', status: 'proposed' })       // transient coexisting → loses on precedence
    await copApiUsage('500.00', { category: 'copilot_coding_agent', status: 'superseded' })   // stale → ignored
    await copApiUsage('999.00', { category: 'copilot_coding_agent', status: 'rejected' })     // rejected → ignored
    await otelCop('cop-e', '19.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const [row] = await t.client<{ cost: string }[]>`
      SELECT cost_usd::text AS cost FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date`
    expect(Number(row!.cost)).toBeCloseTo(15, 2) // 34 (applied, beats proposed $99) − 19; superseded/rejected excluded
  })

  it('reconciles DOWN: deletes an UNTAGGED orphan, zero-preserves a TAGGED orphan, keeps live rows', async () => {
    // Simulates the real sandbox artifact: copilot-cli unaccounted rows written by an older code
    // version (which read the §B bill from actual_spend) that the current view no longer produces.
    // §A must never show MORE than the provider truth → orphans must be corrected.
    const [proj] = await t.db.insert(schema.project).values({ code: 'P-ORPHAN', codeHash: 'p-orphan', displayName: 'Orphan Proj', type: 'billable', regionId, costOwningUnitId: orgUnitId }).returning()
    await t.client`
      INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, computed_at)
      VALUES (${teammateId}::uuid, ${regionId}::uuid, ${orgUnitId}::uuid, '2026-06-15'::date, 'copilot-cli', 307.84, 0, 'api-reconciled', now())` // UNTAGGED orphan
    await t.client`
      INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, project_id, activity, tagged_at, computed_at)
      VALUES (${teammateId}::uuid, ${regionId}::uuid, ${orgUnitId}::uuid, '2026-06-16'::date, 'copilot-cli', 200.00, 0, 'api-reconciled', ${proj!.id}::uuid, 'build', now(), now())` // TAGGED orphan
    // A live, view-backed row must survive untouched.
    await copApiUsage('34.00')
    await otelCop('cop-live', '19.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const untagged = await t.client<{ cost: string }[]>`SELECT cost_usd::text AS cost FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid AND day = '2026-06-15'::date AND tool = 'copilot-cli'`
    expect(untagged).toHaveLength(0) // untagged orphan DELETED (no ghost)
    const [tagged] = await t.client<{ cost: string; project: string | null }[]>`SELECT cost_usd::text AS cost, project_id::text AS project FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid AND day = '2026-06-16'::date AND tool = 'copilot-cli'`
    expect(Number(tagged!.cost)).toBe(0) // tagged orphan zeroed...
    expect(tagged!.project).toBe(proj!.id) // ...but the tag is preserved
    const [live] = await t.client<{ cost: string }[]>`SELECT cost_usd::text AS cost FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date AND tool = 'copilot-cli'`
    expect(Number(live!.cost)).toBeCloseTo(15, 2) // live row preserved
  })

  it('reconciles Claude and Copilot independently in the same window', async () => {
    await t.db.insert(schema.actualSpend).values({ teammateId, date: DAY, tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd: '34.00', source: 'api' })
    await t.db.insert(schema.attributionRecord).values({
      instanceId, claudeSessionId: 'claude-sess', teammateId, regionId, orgUnitId, tool: 'claude-code',
      model: 'opus', tokenType: 'output', tokens: 1000n, costUsd: '19.00', fidelityTier: 'tier-1',
      costBasis: 'estimated', tsEvent: new Date(`${DAY}T12:00:00Z`), sourceRunId: randomUUID(),
    })
    await copApiUsage('20.00')
    await otelCop('cop-sess', '5.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const rows = await t.client<{ tool: string; cost: string }[]>`
      SELECT tool, cost_usd::text AS cost FROM unaccounted_usage
      WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date AND cost_usd > 0 ORDER BY tool`
    expect(rows.map((r) => [r.tool, Number(r.cost)])).toEqual([['claude-code', 15], ['copilot-cli', 15]])
  })
})
