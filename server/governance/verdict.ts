/*
 * verdict — the ONE gateway that decides chargeability from governance data
 * (ADR-0011 D1) or, before activation, reproduces the legacy heuristic exactly
 * (the rollback seam). Design:
 * docs/design/usage-completeness-and-provider-governance.md §4.1, §8.1, §8.4.
 *
 * THE RULE THIS MODULE ENFORCES: no active caller may blend both regimes. Every
 * money-path caller (server/reconciliation/adapters/github.ts,
 * server/workers/copilot-bill.ts, server/workers/copilot-pool-bill.ts, and the
 * governance recompute service) calls ONE of the resolve* functions below, which
 * themselves branch on `ctx.activated` — so exactly one regime executes per call,
 * chosen by one piece of state (`governance_cutover_state.status`), never a
 * per-caller decision. `server/reconciliation/legacy-chargeback-heuristic.ts` is
 * imported ONLY here.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import {
  chargebackExemptOrgSet,
  isChargebackExemptOrg,
  chargebackExemptEnterpriseSet,
  isChargebackExemptEnterprise,
} from '../reconciliation/legacy-chargeback-heuristic'

type Db = PostgresJsDatabase<typeof schema>
/** Read-only executor — satisfied by both a `Db` and a `tx` inside a transaction. */
type SqlRunner = Pick<Db, 'execute'>

export type Billing = 'billed' | 'tracked'

export type VerdictSource =
  | 'legacy-heuristic'
  | 'governance:billed'
  | 'governance:tracked'
  | 'unresolved'

export interface Verdict {
  /** true = excluded from chargeback (§B); ALWAYS showback-visible (§A) regardless. */
  exempt: boolean
  source: VerdictSource
}

export interface GovernanceResolutionContext {
  activated: boolean
  /** provider_enterprise.id -> billing, ALL providers (only github rows are read
   *  post-activation — D11 makes provider_org.billing meaningless for github). */
  enterpriseBillingById: ReadonlyMap<string, Billing>
  /** provider_org.id -> billing, ALL providers (only anthropic rows are read
   *  post-activation — github org-level billing is ignored per D11). */
  orgBillingById: ReadonlyMap<string, Billing>
  /** Legacy pre-activation GitHub org heuristic inputs (env-configured set). */
  legacyExemptOrgs: ReadonlySet<string>
  /** Legacy pre-activation GitHub enterprise heuristic inputs (App-mode path). */
  legacyExemptEnterprises: ReadonlySet<string>
}

/** governance_cutover_state is a singleton row (id = 1); absence means the
 *  migration's seed row is somehow missing — treat as not-activated (fail
 *  towards the SAFER, more-conservative legacy regime, never towards the newer
 *  one by default). */
export async function isGovernanceActivated(db: SqlRunner): Promise<boolean> {
  const rows = await db.execute<{ status: string }>(sql`
    SELECT status FROM governance_cutover_state WHERE id = 1
  `)
  return rows[0]?.status === 'activated'
}

/**
 * Load the full resolution context in a small, fixed number of queries — every
 * table read here (provider_enterprise, provider_org, governance_cutover_state)
 * is small (one row per onboarded org/enterprise), so this is safe to call once
 * per worker run / admin request and
 * hold in memory for the duration, exactly like the existing
 * `exemptSet = chargebackExemptOrgSet()` / `orgRegistry = await loadOrgRegistry(...)`
 * once-per-run patterns this codebase already uses.
 */
export async function loadGovernanceResolutionContext(db: SqlRunner): Promise<GovernanceResolutionContext> {
  const [activated, entRows, orgRows] = await Promise.all([
    isGovernanceActivated(db),
    db.execute<{ id: string; billing: Billing }>(sql`SELECT id::text AS id, billing FROM provider_enterprise`),
    db.execute<{ id: string; billing: Billing }>(sql`SELECT id::text AS id, billing FROM provider_org`),
  ])
  return {
    activated,
    enterpriseBillingById: new Map(entRows.map((r) => [r.id, r.billing])),
    orgBillingById: new Map(orgRows.map((r) => [r.id, r.billing])),
    legacyExemptOrgs: chargebackExemptOrgSet(),
    legacyExemptEnterprises: chargebackExemptEnterpriseSet(),
  }
}

function billingVerdict(b: Billing): Verdict {
  return b === 'tracked' ? { exempt: true, source: 'governance:tracked' } : { exempt: false, source: 'governance:billed' }
}

/**
 * Resolve a GitHub row's chargeback verdict.
 *
 * POST-ACTIVATION (D11): governance lives on the ENTERPRISE only — the org is
 * NEVER consulted, matching "GitHub bills the enterprise: one invoice, one
 * payer... an org on that invoice has no independent commercial status."
 * `providerEnterpriseId` unresolved (null) is the governance-unresolved bucket:
 * never chargeable, but never silently defaulted to exempt either — the
 * distinction is `source: 'unresolved'` vs `source: 'governance:tracked'`.
 *
 * PRE-ACTIVATION (legacy, rollback seam): reproduces today's exact behaviour —
 * per-org heuristic when a license org is known (the PAT path — seats,
 * copilot-bill), the enterprise-level heuristic when it is not (the App-mode
 * metrics path, which carries no per-user license org).
 */
export function resolveGithubVerdict(
  ctx: GovernanceResolutionContext,
  args: { providerEnterpriseId: string | null; enterpriseSlug: string; licenseOrg: string | null },
): Verdict {
  if (ctx.activated) {
    if (!args.providerEnterpriseId) return { exempt: true, source: 'unresolved' }
    const b = ctx.enterpriseBillingById.get(args.providerEnterpriseId)
    if (!b) return { exempt: true, source: 'unresolved' } // dangling/unknown id — defensive, never guessed chargeable
    return billingVerdict(b)
  }
  const exempt =
    args.licenseOrg != null
      ? isChargebackExemptOrg(args.licenseOrg, ctx.legacyExemptOrgs as Set<string>)
      : isChargebackExemptEnterprise(args.enterpriseSlug, ctx.legacyExemptEnterprises as Set<string>)
  return { exempt, source: 'legacy-heuristic' }
}

/**
 * Resolve an Anthropic row's chargeback verdict.
 *
 * POST-ACTIVATION: `provider_org.billing` is authoritative (D11: the org IS the
 * billing unit for Anthropic). Unresolved `providerOrgId` -> governance-unresolved
 * (never chargeable, never silently exempt).
 *
 * PRE-ACTIVATION: Anthropic has NEVER had a live exemption mechanism (design
 * §1.2 — `provider_org.billing` was "read by no money path"), so the legacy
 * verdict is unconditionally "chargeable" — this reproduces that exactly, not
 * an approximation of it.
 */
export function resolveAnthropicVerdict(
  ctx: GovernanceResolutionContext,
  args: { providerOrgId: string | null },
): Verdict {
  if (ctx.activated) {
    if (!args.providerOrgId) return { exempt: true, source: 'unresolved' }
    const b = ctx.orgBillingById.get(args.providerOrgId)
    if (!b) return { exempt: true, source: 'unresolved' }
    return billingVerdict(b)
  }
  return { exempt: false, source: 'legacy-heuristic' }
}
