/*
 * Credential resolver for the two-level lane registry (§3.2, R3 M-4).
 *
 * Generalises the existing `analytics-poller.resolveOrgApiKey` convention to both
 * providers + the org->enterprise fallback. Secrets are NOT read from the DB: the
 * DB holds a `credential_secret_name`, which maps to an env var (a container-app
 * secret -> Key Vault ref). Onboarding a credential is therefore also a deployment
 * change (provision the env var). The strict charset stops two distinct secret
 * names collapsing onto the same env var (one scope silently using another's key).
 *
 * The analytics-poller's `resolveOrgApiKey` is now a thin alias over `readSecret`
 * here (consolidated) — this module is the single source of truth for the
 * credential_secret_name -> env-var convention across both providers.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type { ReconcileProvider } from './types'

// The resolver body uses only db.execute(sql`…`) (the raw escape hatch), so it works
// on either the schema-typed getDb() handle (worker callers) OR the RLS-bound request
// transaction from withRequestRls, which is widened to Record<string, unknown>. Typing
// the param as the widened db (the recordAuditEvent convention, server/db/audit.ts) lets
// BOTH call paths pass their db without an unsafe cast — the schema-typed db is assignable
// to the widened one.
type Db = PostgresJsDatabase<Record<string, unknown>>

const CREDENTIAL_SECRET_NAME_RE = /^[a-z0-9-]{3,64}$/

const ENV_PREFIX: Record<ReconcileProvider, string> = {
  anthropic: 'NUXT_ANTHROPIC_KEY_',
  github: 'NUXT_GITHUB_PAT_',
}

/*
 * GitHub-App credential path (docs/design/github-pat-to-github-app-transition.md).
 *
 * When a github enterprise opts into App mode (provider_enterprise.github_app_id set,
 * mig 0078), the SAME credential_secret_name names the App PRIVATE KEY env var under
 * this DISTINCT prefix — so an App enterprise and a PAT enterprise can share a secret
 * name without their env vars colliding (NUXT_GITHUB_APP_KEY_<NAME> vs
 * NUXT_GITHUB_PAT_<NAME>). The value is the App private key (multi-line PEM),
 * BASE64-ENCODED at the GitHub-secret boundary — raw newlines do not survive the
 * GH-secret → bicep → KV → container-env pipeline (every existing secret is
 * single-line). github-app-auth.ts base64-DECODES it before crypto.createPrivateKey.
 */
const GITHUB_APP_KEY_PREFIX = 'NUXT_GITHUB_APP_KEY_'

/** Map a credential_secret_name to its env var, or null if the name is malformed. */
export function envKeyForSecret(provider: ReconcileProvider, secretName: string): string | null {
  if (!CREDENTIAL_SECRET_NAME_RE.test(secretName)) return null
  return `${ENV_PREFIX[provider]}${secretName.toUpperCase().replace(/-/g, '_')}`
}

/**
 * Map a credential_secret_name to the GitHub-App PRIVATE-KEY env var (App mode only),
 * or null if the name is malformed. Mirrors envKeyForSecret but under the App prefix.
 */
export function envKeyForGithubAppKey(secretName: string): string | null {
  if (!CREDENTIAL_SECRET_NAME_RE.test(secretName)) return null
  return `${GITHUB_APP_KEY_PREFIX}${secretName.toUpperCase().replace(/-/g, '_')}`
}

/** Read the secret value from the environment, or null if unset/malformed. */
export function readSecret(provider: ReconcileProvider, secretName: string | null | undefined): string | null {
  if (!secretName) return null
  const env = envKeyForSecret(provider, secretName)
  if (!env) return null
  return process.env[env] ?? null
}

/** Read the GitHub-App private key (base64 PEM) for a secret name, or null if unset/malformed. */
export function readGithubAppKey(secretName: string | null | undefined): string | null {
  if (!secretName) return null
  const env = envKeyForGithubAppKey(secretName)
  if (!env) return null
  return process.env[env] ?? null
}

/**
 * Which github credential path the resolver selected.
 *   'github-pat'  — the classic enterprise manage_billing PAT (today's default; also
 *                   the implicit kind for anthropic, which never branches on this).
 *   'github-app'  — a registered GitHub App (mig 0078). `value` is the base64-encoded
 *                   App private key (PEM); `appId` is the App id. The github
 *                   adapter/identity resolver branch on this at the ADAPTER seam (never
 *                   by overloading the live PAT methods). See github-app-auth.ts.
 */
export type CredentialKind = 'github-pat' | 'github-app'

export interface ResolvedCredential {
  secretName: string
  /** PAT mode: the PAT. App mode: the base64-encoded App private key (PEM). */
  value: string
  level: 'org' | 'enterprise'
  /** Default 'github-pat'. App mode sets 'github-app' (+ appId). The adapter branches
   *  on this; anthropic ignores it. Defaulted (not required) so every existing caller /
   *  test that builds a ResolvedCredential literal stays valid + on the PAT path. */
  kind?: CredentialKind
  /** App mode only: provider_enterprise.github_app_id (the JWT `iss`). */
  appId?: string
  /** Anthropic org grain only: which API reconciles this org (provider_org.api_kind,
   *  mig 0063). Carried so reconciliation-sync can thread it onto AdapterScope and
   *  the anthropic adapter can branch. Null for github / pre-0063 rows. */
  apiKind?: 'enterprise-analytics' | 'claude-code-admin' | null
}

/**
 * Thrown when an enterprise has OPTED INTO App mode (github_app_id set) but the App
 * private key env var is absent. FAIL-LOUD per the adversarial review: silently
 * falling back to the PAT path would be a green run with zero attribution. The
 * message NEVER carries the key value or the env var's contents — only the secret
 * NAME (already non-secret) so the operator knows which env var to provision.
 */
export class MissingGithubAppKeyError extends Error {
  constructor(
    public readonly enterpriseSlug: string,
    public readonly secretName: string,
  ) {
    super(
      `github enterprise '${enterpriseSlug}' is configured for App mode (github_app_id set) ` +
        `but no App private key is wired for credential_secret_name '${secretName}' ` +
        `(expected env ${envKeyForGithubAppKey(secretName) ?? '<malformed-secret-name>'}). ` +
        `Refusing to fall back to the PAT path — that would be a green run with zero attribution.`,
    )
    this.name = 'MissingGithubAppKeyError'
  }
}

/*
 * Anthropic grain: resolve by org. Uses the org's own credential_secret_name, else
 * the parent provider_enterprise's. Returns null if neither resolves to a value.
 */
export async function resolveOrgCredential(
  db: Db,
  args: { provider: ReconcileProvider; externalOrgId: string },
): Promise<ResolvedCredential | null> {
  const rows = await db.execute<{
    org_secret: string | null
    ent_secret: string | null
    api_kind: string | null
  }>(sql`
    SELECT po.credential_secret_name AS org_secret,
           pe.credential_secret_name AS ent_secret,
           po.api_kind AS api_kind
    FROM provider_org po
    LEFT JOIN provider_enterprise pe ON pe.id = po.provider_enterprise_id
    WHERE po.provider = ${args.provider} AND lower(po.external_org_id) = lower(${args.externalOrgId})
    LIMIT 1
  `)
  const row = rows[0]
  if (!row) return null
  // api_kind is CHECK-constrained (mig 0063) to the two valid values for anthropic
  // and NULL for github; narrow the DB text to the typed union (anything else → null,
  // and the adapter then defaults to the legacy claude-code-admin path).
  const apiKind: ResolvedCredential['apiKind'] =
    row.api_kind === 'enterprise-analytics' || row.api_kind === 'claude-code-admin'
      ? row.api_kind
      : null
  const candidates: ReadonlyArray<[string | null, 'org' | 'enterprise']> = [
    [row.org_secret, 'org'],
    [row.ent_secret, 'enterprise'],
  ]
  for (const [secretName, level] of candidates) {
    const value = readSecret(args.provider, secretName)
    if (value && secretName) return { secretName, value, level, apiKind }
  }
  return null
}

/*
 * GitHub grain: resolve by enterprise (one credential reads all child orgs).
 *
 * Two credential paths, branched by provider_enterprise.github_app_id (mig 0078):
 *   - github_app_id IS NULL  → PAT mode: read the classic manage_billing PAT from
 *     NUXT_GITHUB_PAT_<NAME>. Unchanged from before App mode existed.
 *   - github_app_id IS NOT NULL → App mode INTENDED: read the App private key (base64
 *     PEM) from NUXT_GITHUB_APP_KEY_<NAME>. If that env is ABSENT, THROW
 *     MissingGithubAppKeyError (fail-loud, requirement 4) — do NOT silently fall back
 *     to the PAT path; an App-opted enterprise running on a PAT would be a green run
 *     with zero attribution.
 *
 * For anthropic the github_app_id column is always NULL, so this is the PAT/legacy
 * path verbatim (anthropic never reaches an enterprise credential here today — it
 * resolves by org via resolveOrgCredential — but the branch is provider-safe regardless).
 */
export async function resolveEnterpriseCredential(
  db: Db,
  args: { provider: ReconcileProvider; externalId: string },
): Promise<ResolvedCredential | null> {
  // CANONICAL CASING (P1-7 / mig 0062): external_id is stored lowercase (CHECK
  // constraint) and the directory-sync / roster reader compare lower()=lower().
  // Match the same way here so a caller passing a non-canonical casing still
  // resolves the credential (was an EXACT match -> silent zero-attribution on a
  // casing mismatch).
  const rows = await db.execute<{ ent_secret: string | null; github_app_id: string | null }>(sql`
    SELECT credential_secret_name AS ent_secret, github_app_id
    FROM provider_enterprise
    WHERE provider = ${args.provider} AND lower(external_id) = lower(${args.externalId})
    LIMIT 1
  `)
  const row = rows[0]
  if (!row) return null
  const secretName = row.ent_secret

  // App mode INTENDED iff github_app_id is set (github only — anthropic stores NULL).
  // Trim so a stray-whitespace value doesn't accidentally read as "set" / "unset".
  const appId = args.provider === 'github' ? (row.github_app_id?.trim() || null) : null
  if (appId) {
    // FAIL-LOUD: the App key MUST resolve, else throw rather than degrade to PAT.
    const appKey = readGithubAppKey(secretName)
    if (!appKey || !secretName) {
      throw new MissingGithubAppKeyError(args.externalId, secretName ?? '<unset>')
    }
    return { secretName, value: appKey, level: 'enterprise', kind: 'github-app', appId }
  }

  // PAT mode (default): unchanged behaviour.
  const value = readSecret(args.provider, secretName)
  if (value && secretName) return { secretName, value, level: 'enterprise', kind: 'github-pat' }
  return null
}
