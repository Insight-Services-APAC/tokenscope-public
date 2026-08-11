/*
 * governance-keys — resolves the (provider_org_id, provider_enterprise_id)
 * GOVERNANCE KEY every money row must carry (Workstream B, design §4.0 "money
 * rows have no governance key" / R1-H9). Without this key, `billing`
 * (ADR-0011 D1) has nothing to join against and cannot decide anything.
 *
 * Populated at every ingest/replay/reconciliation writer:
 *   - server/workers/analytics-poller.ts   → actual_spend (anthropic) + pending_placement enqueue
 *   - server/workers/copilot-bill.ts       → actual_spend (github, flat-seat showback)
 *   - server/reconciliation/engine.ts      → reconciliation_record (both providers)
 *   - server/reconciliation/placement-store.ts → replayOwedBills carries the
 *     pending_placement row's ALREADY-RESOLVED key straight through (no new
 *     resolution at replay time — see that file).
 *
 * A row whose key cannot be resolved (the org/enterprise is not yet
 * registered) is NEVER guessed at — it stays NULL, showback-visible, and
 * excluded from chargeback (governance-unresolved bucket, design §4.0 point 3)
 * until the bounded backfill worker (server/workers/governance-key-backfill.ts)
 * resolves it or an operator links/creates the missing provider_org /
 * provider_enterprise row and triggers a targeted resweep.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

export interface GovernanceKeyRef {
  providerOrgId: string | null
  providerEnterpriseId: string | null
}

const UNRESOLVED: GovernanceKeyRef = { providerOrgId: null, providerEnterpriseId: null }

/** A tiny per-run cache so a hot ingest loop (one lookup per seat/record) does not
 *  issue one query per row for a scope that resolves to a handful of orgs. Callers
 *  create ONE cache per worker invocation (mirrors the dimsCache/historyCache
 *  pattern in server/reconciliation/engine.ts). */
export function createGovernanceKeyCache(): Map<string, GovernanceKeyRef> {
  return new Map()
}

/**
 * Resolve an Anthropic org's governance key from its `external_org_id`
 * (the same string `sourceForOrg()` embeds into `actual_spend.source`).
 * `providerEnterpriseId` is normally null for Anthropic (D11: the org itself
 * is the billing unit — no enterprise row holds the credential), but is read
 * straight off the row in case one has been registered as a grouping parent.
 */
export async function resolveAnthropicGovernanceKey(
  db: Db,
  cache: Map<string, GovernanceKeyRef>,
  externalOrgId: string | null | undefined,
): Promise<GovernanceKeyRef> {
  if (!externalOrgId) return UNRESOLVED
  const cacheKey = `anthropic:${externalOrgId.toLowerCase()}`
  const cached = cache.get(cacheKey)
  if (cached) return cached
  const rows = await db.execute<{ id: string; provider_enterprise_id: string | null }>(sql`
    SELECT id::text AS id, provider_enterprise_id::text AS provider_enterprise_id
    FROM provider_org
    WHERE provider = 'anthropic' AND lower(external_org_id) = lower(${externalOrgId})
    LIMIT 1
  `)
  const row = rows[0]
  const ref: GovernanceKeyRef = row
    ? { providerOrgId: row.id, providerEnterpriseId: row.provider_enterprise_id }
    : UNRESOLVED
  cache.set(cacheKey, ref)
  return ref
}

/**
 * Resolve a GitHub (enterprise, licenseOrg) pair's governance key. The
 * enterprise is ALWAYS resolvable when the credential scope is a registered
 * `provider_enterprise` (which every caller here already has, by construction
 * — a reconciliation run does not exist without one); `providerOrgId` is
 * resolved from `licenseOrg` when present (a seat's license org, or an
 * App-mode metrics record which carries none — org-less is a legitimate,
 * non-error state per ADR-0011 D11: GitHub billing is enterprise-level, the
 * org is attribution/homing only, never required for chargeability).
 */
export async function resolveGithubGovernanceKey(
  db: Db,
  cache: Map<string, GovernanceKeyRef>,
  args: { enterpriseSlug: string; licenseOrg?: string | null },
): Promise<GovernanceKeyRef> {
  const cacheKey = `github:${args.enterpriseSlug.toLowerCase()}:${(args.licenseOrg ?? '').toLowerCase()}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  const entRows = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM provider_enterprise
    WHERE provider = 'github' AND lower(external_id) = lower(${args.enterpriseSlug})
    LIMIT 1
  `)
  const providerEnterpriseId = entRows[0]?.id ?? null

  let providerOrgId: string | null = null
  if (providerEnterpriseId && args.licenseOrg) {
    // Match by (login OR display name) under THIS enterprise — mirrors
    // copilot-pool-bill.ts's loadOrgRegistry (a bill's organizationName may be
    // the display name, not the login).
    const orgRows = await db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM provider_org
      WHERE provider = 'github' AND provider_enterprise_id = ${providerEnterpriseId}::uuid
        AND (lower(external_org_id) = lower(${args.licenseOrg}) OR lower(display_name) = lower(${args.licenseOrg}))
      LIMIT 1
    `)
    providerOrgId = orgRows[0]?.id ?? null
  }

  const ref: GovernanceKeyRef = { providerOrgId, providerEnterpriseId }
  cache.set(cacheKey, ref)
  return ref
}

/**
 * Generic resolver for a `ReconciledLine`-shaped input, branching internally on
 * `provider` so a caller like `server/reconciliation/engine.ts` — which is
 * explicitly provider-agnostic ("never branches on provider") — can resolve the
 * governance key for ANY line with a single call.
 */
export async function resolveGovernanceKeyForLine(
  db: Db,
  cache: Map<string, GovernanceKeyRef>,
  line: { provider: 'anthropic' | 'github'; enterpriseRef: string; licenseOrg: string | null },
): Promise<GovernanceKeyRef> {
  return line.provider === 'anthropic'
    ? resolveAnthropicGovernanceKey(db, cache, line.enterpriseRef)
    : resolveGithubGovernanceKey(db, cache, { enterpriseSlug: line.enterpriseRef, licenseOrg: line.licenseOrg })
}
