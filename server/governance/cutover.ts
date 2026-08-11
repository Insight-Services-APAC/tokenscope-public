/*
 * cutover — the governance cutover preflight / activate / rollback state
 * machine (design §8.1/§8.4, Required outcome 3).
 *
 * STATE MACHINE (governance_cutover_state, singleton row id=1):
 *
 *   not_started ──preflight──▶ preflight_verified ──activate──▶ activated
 *        ▲                            │                            │
 *        └────────────rollback────────┴────────────rollback─────────┘
 *                (via rolled_back)                        (only pre-closed-period)
 *
 * preflight is idempotent + re-runnable from not_started / preflight_verified /
 * rolled_back (NOT from activated — re-preflighting a live regime is
 * meaningless; roll back first). Each call recomputes from scratch and
 * overwrites the previous snapshot; nothing is assumed carried over.
 *
 * THE ALGORITHM (design §8.1), exactly in this order:
 *   1. Compute the OLD verdict for every registered unit from the legacy
 *      heuristic ∪ env (github) or "always billed" (anthropic — it never had
 *      a live heuristic, so preserving its behaviour means writing `billed`
 *      everywhere, not leaving the schema default `tracked` in place).
 *   2. Detect MIXED enterprises — a github enterprise whose registered orgs
 *      do not share one old verdict. Hard precondition failure: abort,
 *      nothing written, the full mismatch list returned to the caller for a
 *      human decision.
 *   3. Write BOTH sides explicitly (every registered unit gets an explicit
 *      `billing`, never left at the implicit default).
 *   4. Verify: recompute the NEW verdict (via the same resolver
 *      server/governance/verdict.ts uses post-activation) from what was JUST
 *      written and assert it equals the OLD verdict for every unit. Any
 *      mismatch aborts the WHOLE transaction (nothing persisted) — this
 *      function is used for both preflight and activate's own re-verification,
 *      so "verify" is never duplicated logic that could drift.
 *   5. Record success (only reached if 1-4 all held).
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { advisoryXactLock } from '../db/advisory-lock'
import { recordAuditEvent } from '../db/audit'
import { chargebackExemptOrgSet, isChargebackExemptOrg, chargebackExemptEnterpriseSet, isChargebackExemptEnterprise } from '../reconciliation/legacy-chargeback-heuristic'
import { resolveGithubVerdict, resolveAnthropicVerdict, type Billing } from './verdict'

type Db = PostgresJsDatabase<typeof schema>
type Tx = PostgresJsDatabase<Record<string, unknown>>

export type CutoverStatus = 'not_started' | 'preflight_verified' | 'activated' | 'rolled_back'

export class CutoverError extends Error {
  constructor(
    message: string,
    public readonly code: 'wrong-state' | 'mixed-enterprise' | 'verify-failed' | 'closed-period-since-activation',
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'CutoverError'
  }
}

interface UnitVerdict {
  kind: 'provider_enterprise' | 'provider_org'
  id: string
  provider: 'anthropic' | 'github'
  externalRef: string
  oldExempt: boolean
}

interface MixedEnterpriseDetail {
  enterpriseId: string
  externalId: string
  orgVerdicts: { providerOrgId: string; externalOrgId: string; exempt: boolean }[]
}

export interface CutoverStateSnapshot {
  status: CutoverStatus
  preflightSnapshot: unknown
  preflightVerifiedAt: string | null
  preflightVerifiedBy: string | null
  activatedAt: string | null
  activatedBy: string | null
  rolledBackAt: string | null
  rolledBackBy: string | null
}

async function lockCutover(tx: Tx): Promise<void> {
  await tx.execute(advisoryXactLock('governanceCutover', 'state'))
}

/**
 * Serialize a billing edit against preflight/activation/rollback without taking
 * the advisory lock. The shared row lock avoids an advisory-order inversion:
 * billing edits may subsequently take finance-period locks while recomputing
 * open rows, whereas cutover transitions never do.
 */
export async function lockGovernanceCutoverForBillingEdit(tx: Tx): Promise<CutoverStatus> {
  const rows = await tx.execute<{ status: CutoverStatus }>(sql`
    SELECT status FROM governance_cutover_state WHERE id = 1 FOR SHARE
  `)
  const row = rows[0]
  if (!row) throw new Error('governance_cutover_state singleton row (id=1) is missing — migration 0104 seed did not run')
  return row.status
}

async function readState(tx: Tx): Promise<CutoverStateSnapshot> {
  const rows = await tx.execute<{
    status: CutoverStatus
    preflight_snapshot: unknown
    preflight_verified_at: string | null
    preflight_verified_by: string | null
    activated_at: string | null
    activated_by: string | null
    rolled_back_at: string | null
    rolled_back_by: string | null
  }>(sql`
    SELECT status, preflight_snapshot, preflight_verified_at::text AS preflight_verified_at,
           preflight_verified_by::text AS preflight_verified_by, activated_at::text AS activated_at,
           activated_by::text AS activated_by, rolled_back_at::text AS rolled_back_at,
           rolled_back_by::text AS rolled_back_by
    FROM governance_cutover_state WHERE id = 1 FOR UPDATE
  `)
  const r = rows[0]
  if (!r) throw new Error('governance_cutover_state singleton row (id=1) is missing — migration 0104 seed did not run')
  return {
    status: r.status,
    preflightSnapshot: r.preflight_snapshot,
    preflightVerifiedAt: r.preflight_verified_at,
    preflightVerifiedBy: r.preflight_verified_by,
    activatedAt: r.activated_at,
    activatedBy: r.activated_by,
    rolledBackAt: r.rolled_back_at,
    rolledBackBy: r.rolled_back_by,
  }
}

/** Read-only, unlocked — for a status GET endpoint. */
export async function getCutoverState(db: Pick<Db, 'execute'>): Promise<CutoverStateSnapshot> {
  const rows = await db.execute<{
    status: CutoverStatus
    preflight_snapshot: unknown
    preflight_verified_at: string | null
    preflight_verified_by: string | null
    activated_at: string | null
    activated_by: string | null
    rolled_back_at: string | null
    rolled_back_by: string | null
  }>(sql`
    SELECT status, preflight_snapshot, preflight_verified_at::text AS preflight_verified_at,
           preflight_verified_by::text AS preflight_verified_by, activated_at::text AS activated_at,
           activated_by::text AS activated_by, rolled_back_at::text AS rolled_back_at,
           rolled_back_by::text AS rolled_back_by
    FROM governance_cutover_state WHERE id = 1
  `)
  const r = rows[0]
  if (!r) throw new Error('governance_cutover_state singleton row (id=1) is missing — migration 0104 seed did not run')
  return {
    status: r.status,
    preflightSnapshot: r.preflight_snapshot,
    preflightVerifiedAt: r.preflight_verified_at,
    preflightVerifiedBy: r.preflight_verified_by,
    activatedAt: r.activated_at,
    activatedBy: r.activated_by,
    rolledBackAt: r.rolled_back_at,
    rolledBackBy: r.rolled_back_by,
  }
}

/**
 * Compute the OLD (legacy, pre-cutover) verdict for every registered unit, and
 * detect mixed GitHub enterprises. Pure read — no writes.
 */
async function computeOldVerdicts(tx: Tx): Promise<{ units: UnitVerdict[]; mixed: MixedEnterpriseDetail[] }> {
  const legacyExemptOrgs = chargebackExemptOrgSet()
  const legacyExemptEnterprises = chargebackExemptEnterpriseSet()

  const units: UnitVerdict[] = []
  const mixed: MixedEnterpriseDetail[] = []

  // Anthropic: every registered org is old-verdict "billed" (never exempt) —
  // §1.2/§4.1: provider_org.billing has NEVER been read by an Anthropic money
  // path, so preserving today's behaviour means writing `billed` explicitly
  // everywhere, not leaving the schema default (`tracked`) to silently become
  // load-bearing the moment activation starts reading it.
  const anthropicOrgs = await tx.execute<{ id: string; external_org_id: string }>(sql`
    SELECT id::text AS id, external_org_id FROM provider_org WHERE provider = 'anthropic'
  `)
  for (const org of anthropicOrgs) {
    units.push({ kind: 'provider_org', id: org.id, provider: 'anthropic', externalRef: org.external_org_id, oldExempt: false })
  }

  // GitHub: per-enterprise, from its registered orgs (PAT-mode reality) or the
  // enterprise-level heuristic when it has none (App-mode / not yet onboarded).
  const enterprises = await tx.execute<{ id: string; external_id: string }>(sql`
    SELECT id::text AS id, external_id FROM provider_enterprise WHERE provider = 'github'
  `)
  for (const ent of enterprises) {
    const orgs = await tx.execute<{ id: string; external_org_id: string }>(sql`
      SELECT id::text AS id, external_org_id FROM provider_org
      WHERE provider = 'github' AND provider_enterprise_id = ${ent.id}::uuid
    `)
    if (orgs.length === 0) {
      const exempt = isChargebackExemptEnterprise(ent.external_id, legacyExemptEnterprises)
      units.push({ kind: 'provider_enterprise', id: ent.id, provider: 'github', externalRef: ent.external_id, oldExempt: exempt })
      continue
    }
    const orgVerdicts = orgs.map((o) => ({
      providerOrgId: o.id,
      externalOrgId: o.external_org_id,
      exempt: isChargebackExemptOrg(o.external_org_id, legacyExemptOrgs),
    }))
    const distinctVerdicts = new Set(orgVerdicts.map((o) => o.exempt))
    if (distinctVerdicts.size > 1) {
      mixed.push({ enterpriseId: ent.id, externalId: ent.external_id, orgVerdicts })
      continue // do not add a unit verdict for a mixed enterprise — it has none
    }
    units.push({
      kind: 'provider_enterprise',
      id: ent.id,
      provider: 'github',
      externalRef: ent.external_id,
      oldExempt: orgVerdicts[0]!.exempt,
    })
  }

  return { units, mixed }
}

export interface PreflightResult {
  state: CutoverStateSnapshot
  unitsVerified: number
}

/**
 * Run (or re-run) the preflight. Transactional + idempotent: on ANY failure
 * (mixed enterprise, verify mismatch) the caller's transaction is expected to
 * roll back (throw propagates); nothing about governance_cutover_state or any
 * `billing` column persists from a failed attempt.
 */
export async function preflightGovernanceCutover(
  tx: Tx,
  args: { actorTeammateId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<PreflightResult> {
  await lockCutover(tx)
  const state = await readState(tx)
  if (state.status === 'activated') {
    throw new CutoverError('preflight cannot run while governance is already activated — roll back first', 'wrong-state')
  }

  const { units, mixed } = await computeOldVerdicts(tx)
  if (mixed.length > 0) {
    throw new CutoverError(
      `${mixed.length} GitHub enterprise(s) have orgs that disagree on the legacy chargeback verdict — each is an explicit commercial decision a human must make before cutover`,
      'mixed-enterprise',
      mixed,
    )
  }

  // Write BOTH sides explicitly (§8.1 step 3).
  for (const u of units) {
    const billing: Billing = u.oldExempt ? 'tracked' : 'billed'
    if (u.kind === 'provider_org') {
      await tx.execute(sql`UPDATE provider_org SET billing = ${billing} WHERE id = ${u.id}::uuid`)
    } else {
      await tx.execute(sql`UPDATE provider_enterprise SET billing = ${billing} WHERE id = ${u.id}::uuid`)
    }
  }

  // Verify: recompute the NEW verdict from what was JUST written, using the
  // EXACT resolver the money paths use post-activation, and assert equality.
  const freshBillingRows = await tx.execute<{ id: string; billing: Billing }>(sql`
    SELECT id::text AS id, billing FROM provider_enterprise
    UNION ALL
    SELECT id::text AS id, billing FROM provider_org
  `)
  const billingById = new Map(freshBillingRows.map((r) => [r.id, r.billing]))
  const activatedCtx = {
    activated: true,
    enterpriseBillingById: billingById,
    orgBillingById: billingById,
    legacyExemptOrgs: new Set<string>(),
    legacyExemptEnterprises: new Set<string>(),
  }
  const mismatches: { id: string; externalRef: string; old: boolean; recomputed: boolean }[] = []
  for (const u of units) {
    const recomputed =
      u.kind === 'provider_org'
        ? resolveAnthropicVerdict(activatedCtx, { providerOrgId: u.id }).exempt
        : resolveGithubVerdict(activatedCtx, { providerEnterpriseId: u.id, enterpriseSlug: u.externalRef, licenseOrg: null }).exempt
    if (recomputed !== u.oldExempt) {
      mismatches.push({ id: u.id, externalRef: u.externalRef, old: u.oldExempt, recomputed })
    }
  }
  if (mismatches.length > 0) {
    throw new CutoverError(
      `${mismatches.length} unit(s) failed the preflight equivalence check — the new governance verdict would not match today's behaviour`,
      'verify-failed',
      mismatches,
    )
  }

  const snapshot = {
    computedAt: new Date().toISOString(),
    units: units.map((u) => ({ kind: u.kind, id: u.id, provider: u.provider, externalRef: u.externalRef, verdict: u.oldExempt ? 'tracked' : 'billed' })),
  }

  await tx.execute(sql`
    UPDATE governance_cutover_state
    SET status = 'preflight_verified', preflight_snapshot = ${JSON.stringify(snapshot)}::jsonb,
        preflight_verified_at = now(), preflight_verified_by = ${args.actorTeammateId}::uuid, updated_at = now()
    WHERE id = 1
  `)

  await recordAuditEvent(tx, {
    eventType: 'governance-cutover-preflight-verified',
    actorTeammateId: args.actorTeammateId,
    subjectKind: 'governance_cutover_state',
    subjectId: null,
    payload: { unitsVerified: units.length, snapshot },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  })

  return { state: await getCutoverState(tx), unitsVerified: units.length }
}

/**
 * Activate: only succeeds from `preflight_verified`. Re-verifies (recomputes
 * old-vs-new from CURRENT data) before flipping — a defence against drift
 * between preflight and activate (e.g. a new org registered in between).
 */
export async function activateGovernanceCutover(
  tx: Tx,
  args: { actorTeammateId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<CutoverStateSnapshot> {
  await lockCutover(tx)
  const state = await readState(tx)
  if (state.status !== 'preflight_verified') {
    throw new CutoverError('activation requires a verified preflight — run preflight first', 'wrong-state')
  }

  // Re-verify against CURRENT data (not the stale snapshot) — same computation
  // preflight just did; any drift since then aborts activation.
  const { units, mixed } = await computeOldVerdicts(tx)
  if (mixed.length > 0) {
    throw new CutoverError('a GitHub enterprise now has mixed orgs — re-run preflight', 'mixed-enterprise', mixed)
  }
  const freshBillingRows = await tx.execute<{ id: string; billing: Billing }>(sql`
    SELECT id::text AS id, billing FROM provider_enterprise
    UNION ALL
    SELECT id::text AS id, billing FROM provider_org
  `)
  const billingById = new Map(freshBillingRows.map((r) => [r.id, r.billing]))
  const activatedCtx = {
    activated: true,
    enterpriseBillingById: billingById,
    orgBillingById: billingById,
    legacyExemptOrgs: new Set<string>(),
    legacyExemptEnterprises: new Set<string>(),
  }
  const mismatches: { id: string }[] = []
  for (const u of units) {
    const recomputed =
      u.kind === 'provider_org'
        ? resolveAnthropicVerdict(activatedCtx, { providerOrgId: u.id }).exempt
        : resolveGithubVerdict(activatedCtx, { providerEnterpriseId: u.id, enterpriseSlug: u.externalRef, licenseOrg: null }).exempt
    if (recomputed !== u.oldExempt) mismatches.push({ id: u.id })
  }
  if (mismatches.length > 0) {
    throw new CutoverError(
      `${mismatches.length} unit(s) drifted since the last preflight — re-run preflight before activating`,
      'verify-failed',
      mismatches,
    )
  }

  await tx.execute(sql`
    UPDATE governance_cutover_state
    SET status = 'activated', activated_at = now(), activated_by = ${args.actorTeammateId}::uuid, updated_at = now()
    WHERE id = 1
  `)

  await recordAuditEvent(tx, {
    eventType: 'governance-cutover-activated',
    actorTeammateId: args.actorTeammateId,
    subjectKind: 'governance_cutover_state',
    subjectId: null,
    payload: { unitsVerified: units.length },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  })

  return getCutoverState(tx)
}

/**
 * Rollback: only allowed from `activated`, and only while NO finance_period
 * has been closed since activation (design: "allowed only before any closed
 * period uses the new regime"). Does not touch `billing` values — they remain
 * exactly as preflight wrote them; only the read-path activation flag flips
 * back, so the legacy heuristic resumes deciding chargeability.
 */
export async function rollbackGovernanceCutover(
  tx: Tx,
  args: { actorTeammateId: string; reason: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<CutoverStateSnapshot> {
  await lockCutover(tx)
  const state = await readState(tx)
  if (state.status !== 'activated') {
    throw new CutoverError('rollback requires governance to currently be activated', 'wrong-state')
  }

  const closedSince = await tx.execute<{ period_month: string }>(sql`
    SELECT period_month::text AS period_month FROM finance_period
    WHERE closed_at >= ${state.activatedAt}::timestamptz
       OR restated_at >= ${state.activatedAt}::timestamptz
  `)
  if (closedSince.length > 0) {
    throw new CutoverError(
      `${closedSince.length} finance period(s) have already been closed under the new governance regime — rollback is no longer safe`,
      'closed-period-since-activation',
      closedSince.map((r) => r.period_month),
    )
  }

  await tx.execute(sql`
    UPDATE governance_cutover_state
    SET status = 'rolled_back', rolled_back_at = now(), rolled_back_by = ${args.actorTeammateId}::uuid, updated_at = now()
    WHERE id = 1
  `)

  await recordAuditEvent(tx, {
    eventType: 'governance-cutover-rolled-back',
    actorTeammateId: args.actorTeammateId,
    subjectKind: 'governance_cutover_state',
    subjectId: null,
    payload: { reason: args.reason },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  })

  return getCutoverState(tx)
}
