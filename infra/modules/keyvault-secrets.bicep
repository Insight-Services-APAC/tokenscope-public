// ── Key Vault Secrets — Store application secrets for KV references ──
// Populates the Key Vault with secrets consumed by the Container App
// via Key Vault references (keyVaultUrl + user-assigned MI).
//
// SECURITY: Connection strings are constructed HERE, not in main.bicep,
// so that individual secret components (passwords, keys) are never
// exposed via string interpolation at the root scope.
//
// ── SAFETY CONTRACT ─────────────────────────────────────────────────
// Every secret write below is wrapped in `if (!empty(<param>))`. An
// empty parameter is a NO-OP and leaves the existing KV value intact.
// NEVER remove these guards — a bicep run with empty params previously
// clobbered 6 production secrets (lineage: Tuckwell incident
// 2026-04-15 01:04 UTC, full RCA at /workspace/tmp/infra/bicep/modules/
// keyvault-secrets.bicep:10-17), including a PII encryption key which
// was load-bearing for decrypting already-stored data. The same trap
// applies here: TokenScope's HMAC + session keys protect signed
// state across revisions. Clobbering them on an empty re-run would
// invalidate every active developer session AND every plugin-emitted
// session-attestation token. Rotate by passing the new value
// explicitly; never by re-running bicep without it.

@description('Key Vault name to store secrets in.')
param keyVaultName string

// ── Database connection params (URL built internally) ───────────────

@description('PostgreSQL admin login. URL-encoded inside the module via uriComponent().')
@secure()
param pgAdminLogin string = ''

@description('PostgreSQL admin password.')
@secure()
param pgAdminPassword string = ''

@description('PostgreSQL server FQDN (e.g. psql-tokenscope-sandbox-aue.postgres.database.azure.com).')
param pgServerFqdn string = ''

// ── Redis connection params (URL built internally) ──────────────────

@description('Redis host name.')
param redisHostName string = ''

@description('Redis SSL port (default 6380 for Cache for Redis).')
param redisSslPort int = 6380

@description('Redis primary access key.')
@secure()
param redisPrimaryKey string = ''

// ── Session + HMAC secrets ──────────────────────────────────────────

@description('Nuxt session signing secret (NUXT_SESSION_SECRET).')
@secure()
param sessionSecret string = ''

@description('Nuxt HMAC session key (NUXT_HMAC_SESSION_KEY).')
@secure()
param hmacSessionKey string = ''

@description('Internal worker HMAC key (NUXT_INTERNAL_WORKER_HMAC_KEY).')
@secure()
param internalWorkerHmacKey string = ''

// ── External-API secrets ────────────────────────────────────────────

@description('Anthropic admin key for the analytics poller. Optional: when set, this CREATES the anthropic-admin-api-key KV secret from the value. Leave empty when the secret is placed in Key Vault out-of-band (e.g. dev) — the container app references it either way (gated by hasAnthropicKey).')
@secure()
param anthropicApiKey string = ''

// ── GitHub Copilot reconciliation PATs (F2 — GATED OFF until onboarded) ──
// TEMPLATE for the per-enterprise manage_billing PAT used by Copilot billing
// reconciliation. Each maps to a provider_enterprise.credential_secret_name and is
// read at runtime as NUXT_GITHUB_PAT_<NAME> (server/reconciliation/credentials.ts:
// envKeyForSecret -> prefix NUXT_GITHUB_PAT_ + upper-cased, '-'→'_' name).
//
// NO-OP UNTIL PROVIDED: every secret write below is wrapped in `if (!empty(...))`
// (the SAFETY CONTRACT above) so leaving the param empty is a no-op that NEVER
// clobbers an existing KV value. F2 is gated off in the app (no reconciled
// provider_enterprise row -> no credential lookup) until an enterprise is seeded
// AND its PAT is provided here. Two scaffolded enterprises:
//   1. NFR / internal (e.g. the partner-demo enterprise — credential_secret_name
//      'partner-demo' -> env NUXT_GITHUB_PAT_PARTNER_DEMO -> kv secret
//      'github-pat-partner-demo').
//   2. Production (a real client enterprise — name + slug supplied post-merge per
//      the multi-org onboarding runbook).
// PAT scopes: manage_billing:enterprise + read:org + per-org SAML SSO authorization
// (see docs/build/copilot-multi-org-onboarding.md §2). Onboarding a credential is a
// DEPLOYMENT change (provision the value + redeploy), by design.
@description('GitHub manage_billing PAT for the NFR/internal enterprise (credential_secret_name "partner-demo"). Empty = NO-OP (F2 stays gated off).')
@secure()
param githubPatPartnerDemo string = ''

@description('GitHub manage_billing PAT for the production client enterprise. Empty = NO-OP. Set the secret name to match the production provider_enterprise.credential_secret_name (rename this param + the resource name + the env wiring to match once the real slug is known).')
@secure()
param githubPatProduction string = ''

@description('GitHub manage_billing PAT for the APAC NFR/internal enterprise (credential_secret_name "enterprise-nfr"). Empty = NO-OP. Supplied as a GitHub Actions secret at apply time; this CREATES the github-pat-enterprise-nfr KV secret from the value (no manual KV write needed).')
@secure()
param githubPatApacNfr string = ''

// ── GitHub App private keys (App-credential path — OPT-IN per enterprise) ──
// The App-mode replacement for a PAT (docs/design/github-pat-to-github-app-transition.md):
// a registered GitHub App's PRIVATE KEY, read at runtime as NUXT_GITHUB_APP_KEY_<NAME>
// (server/reconciliation/credentials.ts: envKeyForGithubAppKey -> prefix
// NUXT_GITHUB_APP_KEY_ + upper-cased, '-'→'_' credential_secret_name). The matching
// provider_enterprise.github_app_id (non-secret) is set via onboarding (the admin UI).
//
// CRITICAL — BASE64: the App private key is a MULTI-LINE PEM. Raw newlines do NOT survive
// the GH-secret → bicep → KV → container-env pipeline (every existing secret is
// single-line), so the GH secret value (GH_APP_KEY_<NAME>) MUST be the PEM BASE64-ENCODED
// (`base64 -w0 app.private-key.pem`). github-app-auth.ts base64-DECODES it before
// crypto.createPrivateKey. NO-OP UNTIL PROVIDED (the `if (!empty(...))` guard below).
@description('GitHub App private key (BASE64-encoded PEM) for the NFR/internal (partner-demo) enterprise — credential_secret_name "partner-demo", read as NUXT_GITHUB_APP_KEY_PARTNER_DEMO. Pair with provider_enterprise.github_app_id (set via onboarding). Empty = NO-OP.')
@secure()
param githubAppKeyPartnerDemo string = ''

@description('Entra OIDC client secret for nuxt-oidc-auth confidential flow.')
@secure()
param entraClientSecret string = ''

// ── nuxt-oidc-auth module encryption secrets ────────────────────────
// Without these, the module generates random per-boot values that
// invalidate OIDC sessions on every revision roll AND prevent our
// /api/v1/auth/me from decrypting the cookie set by /auth/entra/callback
// (different password = decrypt fails silently → SSR redirects to /login).
// Matches a sibling project's container-app.bicep:167-169 pattern.

// Length requirements live in @description, NOT @minLength — the
// safety contract (empty = NO-OP, don't clobber existing KV value)
// is incompatible with @minLength which would reject empty too.
// Operator script that constructs these values is responsible for
// length validation; an attempt to deploy with a too-short value
// surfaces as a runtime error on first cookie decrypt.

@description('nuxt-oidc-auth user-session cookie encryption secret (NUXT_OIDC_SESSION_SECRET). MUST be >= 48 chars. Stable across revisions or sessions invalidate.')
@secure()
param oidcSessionSecret string = ''

@description('nuxt-oidc-auth auth-flow session cookie encryption secret (NUXT_OIDC_AUTH_SESSION_SECRET). MUST be >= 48 chars. Carries the OAuth state + PKCE between /login and /callback.')
@secure()
param oidcAuthSessionSecret string = ''

@description('nuxt-oidc-auth refresh-token AES-256-GCM key (NUXT_OIDC_TOKEN_KEY). Base64-encoded 32 bytes (44 chars).')
@secure()
param oidcTokenKey string = ''

// ── Reference to existing Key Vault ─────────────────────────────────

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

// ── Constructed-secret guards ────────────────────────────────────────
// database-url and redis-url are constructed from multiple inputs.
// Write the secret only when EVERY component is present; otherwise the
// resulting URL would be a half-built string with `undefined`-shaped
// segments that crash the app on first connect.

var canBuildDatabaseUrl = !empty(pgAdminLogin) && !empty(pgAdminPassword) && !empty(pgServerFqdn)
var canBuildRedisUrl = !empty(redisHostName) && !empty(redisPrimaryKey)

// ── Secrets ─────────────────────────────────────────────────────────
// Each `if (...)` guard mirrors the SAFETY CONTRACT — never clobber an
// existing KV secret with an empty value on a partial-input run.

resource secretDatabaseUrl 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (canBuildDatabaseUrl) {
  parent: keyVault
  name: 'database-url'
  properties: {
    // uriComponent() escapes special chars in the admin login (e.g. `@`,
    // `:`) so the resulting URL parses cleanly. Password is escaped too
    // — common-passwords like `P@ssw0rd!` otherwise break the URL.
    value: 'postgresql://${uriComponent(pgAdminLogin)}:${uriComponent(pgAdminPassword)}@${pgServerFqdn}:5432/tokenscope?sslmode=require'
  }
}

resource secretRedisUrl 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (canBuildRedisUrl) {
  parent: keyVault
  name: 'redis-url'
  properties: {
    // rediss:// = TLS; Cache for Redis ssl port = 6380.
    value: 'rediss://:${redisPrimaryKey}@${redisHostName}:${redisSslPort}'
  }
}

resource secretSessionSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(sessionSecret)) {
  parent: keyVault
  name: 'session-secret'
  properties: {
    value: sessionSecret
  }
}

resource secretHmacSessionKey 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(hmacSessionKey)) {
  parent: keyVault
  name: 'hmac-session-key'
  properties: {
    value: hmacSessionKey
  }
}

resource secretInternalWorkerHmacKey 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(internalWorkerHmacKey)) {
  parent: keyVault
  name: 'internal-worker-hmac-key'
  properties: {
    value: internalWorkerHmacKey
  }
}

resource secretAnthropicApiKey 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(anthropicApiKey)) {
  parent: keyVault
  name: 'anthropic-admin-api-key'
  properties: {
    value: anthropicApiKey
  }
}

// GitHub Copilot reconciliation PATs (F2 — GATED OFF; empty = NO-OP, see param block).
resource secretGithubPatPartnerDemo 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(githubPatPartnerDemo)) {
  parent: keyVault
  name: 'github-pat-partner-demo'
  properties: {
    value: githubPatPartnerDemo
  }
}

resource secretGithubPatProduction 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(githubPatProduction)) {
  parent: keyVault
  // TEMPLATE name — rename to match the production provider_enterprise.credential_secret_name
  // (kv secret name convention: 'github-pat-<credential_secret_name>').
  name: 'github-pat-production'
  properties: {
    value: githubPatProduction
  }
}

resource secretGithubPatApacNfr 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(githubPatApacNfr)) {
  parent: keyVault
  name: 'github-pat-enterprise-nfr'
  properties: {
    value: githubPatApacNfr
  }
}

// GitHub App private key (App-credential path; base64 PEM). kv secret name convention:
// 'github-app-key-<credential_secret_name>'. Empty = NO-OP (never clobbers an existing value).
resource secretGithubAppKeyPartnerDemo 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(githubAppKeyPartnerDemo)) {
  parent: keyVault
  name: 'github-app-key-partner-demo'
  properties: {
    value: githubAppKeyPartnerDemo
  }
}

resource secretEntraClientSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(entraClientSecret)) {
  parent: keyVault
  name: 'entra-client-secret'
  properties: {
    value: entraClientSecret
  }
}

resource secretOidcSessionSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(oidcSessionSecret)) {
  parent: keyVault
  name: 'oidc-session-secret'
  properties: {
    value: oidcSessionSecret
  }
}

resource secretOidcAuthSessionSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(oidcAuthSessionSecret)) {
  parent: keyVault
  name: 'oidc-auth-session-secret'
  properties: {
    value: oidcAuthSessionSecret
  }
}

resource secretOidcTokenKey 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = if (!empty(oidcTokenKey)) {
  parent: keyVault
  name: 'oidc-token-key'
  properties: {
    value: oidcTokenKey
  }
}

// NO outputs — this module is writes-only. Anything that needs to read
// these secrets does so at runtime via the keyVaultUrl reference + the
// user-assigned MI's Key Vault Secrets User role.
