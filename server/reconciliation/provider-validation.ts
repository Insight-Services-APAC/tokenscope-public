/*
 * Shared validation for the reconciliation-provider admin surface
 * (server/api/v1/admin/reconciliation/{orgs,enterprises}*). One place for the
 * DB-CHECK invariants so the create + patch routes can't drift apart:
 *
 *   - credential_secret_name charset (mirrors resolveOrgApiKey /
 *     reconciliation/credentials.ts: ^[a-z0-9-]{3,64}$). A name outside this set
 *     would never resolve to an env var, so we reject it at the API boundary
 *     rather than silently store a dead credential pointer.
 *   - provider_org.api_kind CHECK (mig 0063): anthropic ⇒ one of the two API
 *     kinds; github ⇒ NULL. Re-validated app-side so the failure is a clean 400
 *     (not a raw 23514 → 500 surfacing the constraint name).
 *   - provider_enterprise.external_id lowercase CHECK (mig 0062). We auto-lowercase
 *     anthropic org-ids (case-insensitive identifiers), but a github enterprise SLUG
 *     is part of the credential lane key, so we REJECT a mixed-case slug loudly per
 *     the 0062 runbook intent rather than silently rewrite it.
 *
 * These are pure functions (no DB / no env) so they unit-test trivially and are
 * reused verbatim by both the org and enterprise routes.
 */
import { z } from 'zod'
import type { AnthropicApiKind } from './adapters/registry'

export const PROVIDERS = ['anthropic', 'github'] as const
export const RECONCILIATION_MODES = ['reconciled', 'indicative'] as const
export const BILLING = ['billed', 'tracked'] as const
// ADR-0011 D10 — the four ratified pooled-overage allocation policies.
// consumption-share is Insight's default; every policy conserves the
// distributed total exactly (server/governance/copilot-overage-allocation.ts).
export const OVERAGE_ALLOCATION_POLICIES = [
  'consumption-share',
  'excess-share',
  'excess-equal',
  'seat-share',
] as const
export const ANTHROPIC_API_KINDS: readonly AnthropicApiKind[] = [
  'enterprise-analytics',
  'claude-code-admin',
] as const

/** Same charset as resolveOrgApiKey / credentials.envKeyForSecret. */
export const CREDENTIAL_SECRET_NAME_RE = /^[a-z0-9-]{3,64}$/

/** A github enterprise slug / org login: lowercase, GitHub's canonical casing. */
export const LOWERCASE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

// Auto-lowercased (the env-var lookup uppercases it anyway), so a casing slip is corrected.
export const credentialSecretNameSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z
    .string()
    .regex(
      CREDENTIAL_SECRET_NAME_RE,
      'credential_secret_name must be lowercase letters, digits and hyphens (3-64 chars)',
    ),
)

export const apiKindSchema = z.enum(ANTHROPIC_API_KINDS as [AnthropicApiKind, ...AnthropicApiKind[]])
export const providerSchema = z.enum(PROVIDERS)
export const reconciliationModeSchema = z.enum(RECONCILIATION_MODES)
export const billingSchema = z.enum(BILLING)
export const overageAllocationPolicySchema = z.enum(OVERAGE_ALLOCATION_POLICIES)

/*
 * provider_enterprise.github_app_id (mig 0078) — the App-id that opts a github
 * enterprise into the GitHub-App credential path (docs/design/github-pat-to-github-app-
 * transition.md). A GitHub App id is a positive integer; validate it as a digit string
 * (`^\d+$`) at the API boundary so a malformed value is a clean 400, not a downstream
 * surprise. Non-secret (the id), so it round-trips through the create/list/patch
 * surface unredacted — only the private key (NUXT_GITHUB_APP_KEY_<NAME>) is a secret.
 * Trimmed; empty string normalises to null (clears App mode → reverts to PAT).
 */
export const GITHUB_APP_ID_RE = /^\d+$/
export const githubAppIdSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z
    .string()
    .regex(GITHUB_APP_ID_RE, 'github_app_id must be a positive integer (the GitHub App id, e.g. 1234567)'),
)

export type Provider = (typeof PROVIDERS)[number]
export type ReconciliationMode = (typeof RECONCILIATION_MODES)[number]
export type Billing = (typeof BILLING)[number]
export type OverageAllocationPolicy = (typeof OVERAGE_ALLOCATION_POLICIES)[number]

/**
 * The provider_org.api_kind CHECK (mig 0063), as a pure predicate. Returns an
 * error string when violated, or null when the (provider, apiKind) pair is legal.
 *
 *   anthropic ⇒ apiKind ∈ {enterprise-analytics, claude-code-admin}
 *   github    ⇒ apiKind IS NULL
 */
export function validateApiKindForProvider(
  provider: Provider,
  apiKind: AnthropicApiKind | null | undefined,
): string | null {
  if (provider === 'anthropic') {
    if (apiKind == null) {
      return "anthropic provider_org requires api_kind (one of: enterprise-analytics, claude-code-admin)"
    }
    if (!ANTHROPIC_API_KINDS.includes(apiKind)) {
      return `api_kind '${apiKind}' is not valid for anthropic`
    }
    return null
  }
  // github (or any non-anthropic): api_kind MUST be null.
  if (apiKind != null) {
    return `api_kind must be null for ${provider} (it has a single billing API)`
  }
  return null
}

/**
 * Reconciled-org credential rule. A RECONCILED anthropic org must carry a
 * credential_secret_name (the poller can't reconcile without a key). Indicative
 * orgs legitimately have none. (For github the credential lives on the enterprise,
 * so this org-level rule only applies to anthropic.)
 */
export function validateReconciledCredential(
  provider: Provider,
  mode: ReconciliationMode,
  credentialSecretName: string | null | undefined,
): string | null {
  if (provider === 'anthropic' && mode === 'reconciled' && !credentialSecretName) {
    return 'a reconciled anthropic org requires a credentialSecretName'
  }
  return null
}

/**
 * Canonicalise + validate a provider_enterprise external_id against the mig-0062
 * lowercase CHECK. Both providers AUTO-LOWERCASE: GitHub canonicalises slugs to
 * lowercase (its API returns lowercase and the attribution resolvers compare
 * lower()=lower()), and anthropic org-ids are case-insensitive — so accepting any
 * casing and storing it lowercase is correct, not a mis-route. Returns { value } on
 * success or { error } only on a genuinely malformed slug (bad charset).
 */
export function canonicaliseExternalId(
  provider: Provider,
  externalId: string,
): { value: string } | { error: string } {
  const lowered = externalId.trim().toLowerCase()
  if (lowered.length === 0) return { error: 'external_id must not be empty' }
  if (provider === 'github' && !LOWERCASE_SLUG_RE.test(lowered)) {
    return { error: 'github external_id must look like a slug — letters, numbers and hyphens (e.g. insight-services)' }
  }
  return { value: lowered }
}
