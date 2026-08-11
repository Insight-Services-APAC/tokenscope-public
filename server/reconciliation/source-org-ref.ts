/*
 * source-org-ref — the `actual_spend.source` string convention, in one place.
 *
 * `actual_spend.source` already embeds the provider org identity in free text
 * (design §4.0: "Anthropic org identity is embedded in the free-text `source`"):
 *   - Anthropic: `sourceForOrg()` in server/workers/analytics-poller.ts writes
 *     `anthropic-analytics-api:<externalOrgId>`, or the bare legacy
 *     `anthropic-analytics-api` for pre-multi-org rows (no org suffix — those
 *     rows predate per-org sourcing and cannot be parsed to an org; they stay
 *     governance-unresolved forever, which is the correct, explicit outcome).
 *   - GitHub: server/workers/copilot-bill.ts's flat-seat showback writer uses
 *     `copilot-seat:<licenseOrgLowercased>`.
 *
 * Ingest-time writers already know the org id/string directly and do NOT need
 * this parser (they resolve provider_org_id straight from what they already
 * have — see governance-keys.ts). This module exists for the two places that
 * only have the STORED `source` string to work from: the governance-key
 * backfill worker (historical rows written before this module existed) and the
 * pre-activation legacy-verdict recompute path (which needs the license org
 * string, not just its resolved UUID, to reproduce the exact historical
 * heuristic behaviour).
 */

export type SourceOrgProvider = 'anthropic' | 'github' | null

export interface SourceOrgRef {
  provider: SourceOrgProvider
  /** The external org id/login embedded in the source, or null when the
   *  source carries no org suffix (unparseable — e.g. legacy bare-prefix rows). */
  externalOrgId: string | null
}

/*
 * NOT imported from server/workers/analytics-poller.ts's (exported) SOURCE_PREFIX:
 * that module ends up importing governance-keys.ts (which needs this parser) for
 * the ingest-time governance-key resolution, so importing back here would be a
 * circular module dependency. Duplicated literal instead — pinned equal to
 * analytics-poller's SOURCE_PREFIX by tests/unit/reconciliation/source-org-ref.test.ts.
 */
export const ANTHROPIC_SOURCE_PREFIX = 'anthropic-analytics-api'
/** Must match the literal in server/workers/copilot-bill.ts's upsertCopilotBillRow caller. */
export const GITHUB_SEAT_SOURCE_PREFIX = 'copilot-seat'

/**
 * Parse an `actual_spend.source` value back into (provider, external org id).
 * Returns `{ provider: null, externalOrgId: null }` for any source this
 * convention does not recognise (never guessed — an unrecognised source is
 * exactly as unresolved as a bare-prefix one).
 */
export function parseActualSpendSourceOrgRef(source: string): SourceOrgRef {
  if (source === ANTHROPIC_SOURCE_PREFIX) return { provider: 'anthropic', externalOrgId: null }
  if (source.startsWith(`${ANTHROPIC_SOURCE_PREFIX}:`)) {
    const rest = source.slice(ANTHROPIC_SOURCE_PREFIX.length + 1).trim()
    return { provider: 'anthropic', externalOrgId: rest || null }
  }
  if (source.startsWith(`${GITHUB_SEAT_SOURCE_PREFIX}:`)) {
    const rest = source.slice(GITHUB_SEAT_SOURCE_PREFIX.length + 1).trim()
    return { provider: 'github', externalOrgId: rest && rest !== 'unknown' ? rest : null }
  }
  return { provider: null, externalOrgId: null }
}
