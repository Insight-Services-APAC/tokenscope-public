// ── Container App — TokenScope Nuxt application ───────────────────────
//
// Includes the Container Apps managed environment as well as the app
// itself — PSR pattern. The user-assigned MI (created at root scope in
// main.bicep) is passed in via identityId + identityClientId and is the
// identity used for BOTH ACR pull AND KV-reference resolution.

@description('Resource name suffix (e.g. tokenscope-sandbox-aue).')
param name string

@description('Azure region.')
param location string

@description('Environment name (drives resources + replica counts).')
@allowed(['sandbox', 'dev', 'staging', 'production'])
param environment string

@description('Container image tag (e.g. sandbox-abc1234). The full image is composed inside this module from acrLoginServer + tag.')
param imageTag string

@description('ACR login server FQDN (e.g. crtokenscopesandbox.azurecr.io).')
param acrLoginServer string

@description('User-assigned MI resource ID — for ACR pull + KV secret access.')
param identityId string

@description('User-assigned MI client ID — for DefaultAzureCredential / Workload-Identity-style auth from the app.')
param identityClientId string

@description('Application Insights connection string. Wires APPLICATIONINSIGHTS_CONNECTION_STRING.')
param appInsightsConnectionString string

@description('Key Vault URI (e.g. https://kv-tokenscope-sandbox-aue.vault.azure.net/).')
param keyVaultUri string

@description('Entra ID tenant ID for nuxt-oidc-auth.')
param entraTenantId string = ''

@description('Entra ID client ID for nuxt-oidc-auth.')
param entraClientId string = ''

@description('Entra ID redirect URI for nuxt-oidc-auth (public callback URL).')
param entraRedirectUri string = ''

@description('Optional pinned PUBLIC origin (scheme://host) when an upstream WAF/proxy fronts the app under a fixed hostname (e.g. the IT dev zone https://tokenscope.example.com). Empty = derive the public origin from Front Door / the request Host. See server/utils/public-url.ts.')
param appPublicOrigin string = ''

@description('Whether admin users can override their session into a demo persona via /api/v1/auth/dev-login. Production MUST be false.')
param allowPersonaOverride bool = false

@description('Bootstrap admin email — the first Entra sign-in matching this address gets `admin` role on JIT teammate creation.')
param bootstrapAdminEmail string = ''

// ── VNet Integration (Wave-III) ─────────────────────────────────────

@description('Subnet ID for Container App Environment VNet integration. Empty = no VNet.')
param containerAppsSubnetId string = ''

@description('Make the Container Apps environment INTERNAL — a private VIP on the VNet, no public endpoint. The deployment zone (IT central WAF/firewall) is then the only public entrypoint, routing inbound to the internal VIP over the VNet/hub. Wired from main.bicep `enablePrivateNetworking`. Requires containerAppsSubnetId.')
param internalIngress bool = false

// ── Log Analytics (for Container App Environment app-logs) ──────────

@description('Log Analytics workspace customer ID (workspace GUID).')
param logAnalyticsCustomerId string = ''

@description('Log Analytics workspace name. Container app references it as `existing` and calls `listKeys()` to read the shared key inline, so the secret never appears as a cross-module output.')
param logAnalyticsName string = ''

@description('Full Azure Monitor OTLP logs ingest URL (DCE logs endpoint + DCR immutable id + Microsoft-OTLP-Logs stream), composed in main.bicep. Empty = phase-1 bring-up before the DCE/DCR exist → the telemetry reader env is omitted and the read joiner stays off.')
param azureMonitorLogsEndpoint string = ''

// ── Optional secret-presence flags ──────────────────────────────────
// These flags mirror the if-guards in keyvault-secrets.bicep. The
// container app must NOT reference a KV secret that doesn't exist —
// ACA rejects KV refs to missing secrets and the deploy fails.

@description('Whether the anthropic-admin-api-key KV secret exists (the Anthropic admin key for the analytics poller, read as NUXT_ANTHROPIC_KEY_MAIN). Set true once IT has placed it in Key Vault.')
param hasAnthropicKey bool = false

// ── GitHub Copilot reconciliation PAT presence flags (F2 — GATED OFF) ──
// TEMPLATE. The reconciliation worker runs IN THIS web-app process (the cron job
// just HMAC-pings /api/v1/internal/run-worker/<name>), so the PAT env vars belong
// HERE, not on worker-jobs.bicep. Read at runtime as NUXT_GITHUB_PAT_<NAME> by
// server/reconciliation/credentials.ts. Default false = no KV ref emitted (ACA
// rejects a ref to a missing secret), so this is a clean no-op until a PAT is
// provided + the matching provider_enterprise row is seeded.
@description('Whether the github-pat-partner-demo KV secret was created (F2 NFR/internal enterprise). Default false — F2 stays gated off.')
param hasGithubPatPartnerDemo bool = false

@description('Whether the github-pat-production KV secret was created (F2 production enterprise). Default false. Rename to match the production credential_secret_name once known.')
param hasGithubPatProduction bool = false

@description('Whether the github-pat-enterprise-nfr KV secret exists (the APAC GitHub NFR/internal enterprise Copilot reconciliation PAT, read as NUXT_GITHUB_PAT_ENTERPRISE_NFR; credential_secret_name "enterprise-nfr"). Default false; flip true ONLY after the PAT is placed in Key Vault as github-pat-enterprise-nfr (ACA rejects a KV ref to a missing secret).')
param hasGithubPatApacNfr bool = false

@description('Whether the github-app-key-partner-demo KV secret was created (the GitHub App PRIVATE KEY, base64 PEM, for the partner-demo enterprise App-credential path; read as NUXT_GITHUB_APP_KEY_PARTNER_DEMO; credential_secret_name "partner-demo"). Default false = no KV ref emitted; flip true ONLY after the key is in Key Vault (ACA rejects a ref to a missing secret).')
param hasGithubAppKeyPartnerDemo bool = false

@description('Whether the entra-client-secret KV secret was created.')
param hasEntraClientSecret bool = false

@description('Whether the three nuxt-oidc-auth module encryption KV secrets were created. When true, the OIDC module uses stable secrets across revisions (sessions survive rolls); when false, the module generates random per-boot values and sessions break across redeploys.')
param hasOidcModuleSecrets bool = false

@description('Azure AI Foundry endpoint URL (empty = not used; Anthropic direct).')
param aiFoundryEndpoint string = ''

@description('Azure Front Door instance ID (Wave-II). Default empty — Wave-I deploys do not gate on FD presence.')
param azureFrontDoorId string = ''

@description('Git commit SHA at deploy time. Empty = use the build-time baked value (Dockerfile ARG GIT_COMMIT_SHA). The /admin/settings → build.commitSha read reflects whichever wins.')
param gitCommitSha string = ''

@description('Anthropic analytics API base URL (NUXT_ANTHROPIC_API_ENDPOINT). Empty = reconciliation + analytics-poller no-op. Set to https://api.anthropic.com on envs with a reconciled Anthropic org. Non-secret config.')
param anthropicApiEndpoint string = ''

@description('Tags applied to every resource.')
param tags object = {}

// ── Container App Environment ──────────────────────────────────────
// PSR's pattern — the managed env lives inside this module so it's
// always co-versioned with the app revision.

// Reference the LAW as `existing` so the shared key resolves inline
// via listKeys() — keeps the key out of every cross-module boundary.
// The lookup is unconditional (Bicep's `existing` is a symbolic compile
// -time reference; ARM only resolves it when listKeys() is invoked,
// which the appLogsConfiguration ternary below guards on the same
// `!empty(logAnalyticsName)` predicate). When logAnalyticsName is
// empty, the deploy is a Wave-I config-only test and the LAW isn't
// expected to exist — listKeys() is never called.
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: empty(logAnalyticsName) ? 'placeholder-never-used' : logAnalyticsName
}

resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${name}'
  location: location
  tags: tags
  properties: {
    zoneRedundant: false
    vnetConfiguration: !empty(containerAppsSubnetId) ? {
      infrastructureSubnetId: containerAppsSubnetId
      // Internal = private VIP only (no public endpoint); the IT zone WAF
      // fronts it. External otherwise (standalone public ingress).
      internal: internalIngress
    } : null
    appLogsConfiguration: !empty(logAnalyticsCustomerId) && !empty(logAnalyticsName) ? {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    } : null
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

// ── Secrets (Key Vault references) ──────────────────────────────────
// `identity` is the user-assigned MI's resource ID. ACA uses it to
// resolve the keyVaultUrl-referenced secret at runtime — the MI must
// have Key Vault Secrets User on the vault (granted by key-vault.bicep
// when deployRbac=true) AND the secrets must already exist (kvSecrets
// runs before this module via main.bicep dependsOn).

var requiredSecrets = [
  {
    name: 'database-url'
    keyVaultUrl: '${keyVaultUri}secrets/database-url'
    identity: identityId
  }
  {
    name: 'redis-url'
    keyVaultUrl: '${keyVaultUri}secrets/redis-url'
    identity: identityId
  }
  {
    name: 'session-secret'
    keyVaultUrl: '${keyVaultUri}secrets/session-secret'
    identity: identityId
  }
  {
    name: 'hmac-session-key'
    keyVaultUrl: '${keyVaultUri}secrets/hmac-session-key'
    identity: identityId
  }
  {
    name: 'internal-worker-hmac-key'
    keyVaultUrl: '${keyVaultUri}secrets/internal-worker-hmac-key'
    identity: identityId
  }
]

// Conditional secrets — guards mirror keyvault-secrets.bicep's if-clauses.
var anthropicSecrets = hasAnthropicKey ? [
  {
    name: 'anthropic-admin-api-key'
    keyVaultUrl: '${keyVaultUri}secrets/anthropic-admin-api-key'
    identity: identityId
  }
] : []

// GitHub Copilot reconciliation PATs (F2 — GATED OFF; empty flags = no ref emitted).
var githubPatSecrets = concat(
  hasGithubPatPartnerDemo ? [
    {
      name: 'github-pat-partner-demo'
      keyVaultUrl: '${keyVaultUri}secrets/github-pat-partner-demo'
      identity: identityId
    }
  ] : [],
  hasGithubPatProduction ? [
    {
      name: 'github-pat-production'
      keyVaultUrl: '${keyVaultUri}secrets/github-pat-production'
      identity: identityId
    }
  ] : [],
  hasGithubPatApacNfr ? [
    {
      name: 'github-pat-enterprise-nfr'
      keyVaultUrl: '${keyVaultUri}secrets/github-pat-enterprise-nfr'
      identity: identityId
    }
  ] : [],
  // GitHub App private key (App-credential path; base64 PEM).
  hasGithubAppKeyPartnerDemo ? [
    {
      name: 'github-app-key-partner-demo'
      keyVaultUrl: '${keyVaultUri}secrets/github-app-key-partner-demo'
      identity: identityId
    }
  ] : []
)

var entraSecrets = hasEntraClientSecret ? [
  {
    name: 'entra-client-secret'
    keyVaultUrl: '${keyVaultUri}secrets/entra-client-secret'
    identity: identityId
  }
] : []

// Three KV secrets backing the nuxt-oidc-auth module's encryption keys.
// All three are required for stable OIDC sessions across revisions.
var oidcModuleSecrets = hasOidcModuleSecrets ? [
  {
    name: 'oidc-session-secret'
    keyVaultUrl: '${keyVaultUri}secrets/oidc-session-secret'
    identity: identityId
  }
  {
    name: 'oidc-auth-session-secret'
    keyVaultUrl: '${keyVaultUri}secrets/oidc-auth-session-secret'
    identity: identityId
  }
  {
    name: 'oidc-token-key'
    keyVaultUrl: '${keyVaultUri}secrets/oidc-token-key'
    identity: identityId
  }
] : []

var allSecrets = concat(requiredSecrets, anthropicSecrets, githubPatSecrets, entraSecrets, oidcModuleSecrets)

// ── Environment Variables ───────────────────────────────────────────

var baseEnvVars = [
  // NODE_ENV is Nuxt's build-mode signal — stays 'production' on every
  // deployed container so Nuxt's production optimisations engage (SSR
  // chunking, minified output, telemetry off). It is NOT a "what env
  // am I in" signal; that role belongs to NUXT_DEPLOY_ENV below.
  { name: 'NODE_ENV', value: 'production' }
  // NUXT_DEPLOY_ENV — the deployed environment's identity. The persona-override
  // gate + the env classifier (shared/env/deploy-env.ts) read this through an
  // ALLOWLIST: only {local, sandbox} are demo-capable; dev / staging / production
  // / unknown refuse impersonation structurally regardless of any flag. Decouples
  // deploy identity from Nuxt build mode.
  { name: 'NUXT_DEPLOY_ENV', value: environment }
  // Client mirror of the deploy env — set from the SAME `environment` param so the
  // browser-side gate (useDemoFeatures) cannot drift from the server. Used only to
  // hide persona/demo UI off demo-capable envs (cosmetic; server is authoritative).
  { name: 'NUXT_PUBLIC_DEPLOY_ENV', value: environment }
  // Anthropic analytics API base (reconciliation + poller). Empty => unset => clean
  // no-op (adapter/poller return early). Real api.anthropic.com where a reconciled
  // Anthropic org exists. Non-secret config.
  { name: 'NUXT_ANTHROPIC_API_ENDPOINT', value: anthropicApiEndpoint }
  // Entra directory people-picker (Region Leaders / Add-teammate): 'graph' = real
  // Microsoft Graph (User.Read.All, app-only via the OIDC app reg); unset/other =
  // the 6-person mock roster. ALL deployed envs use real Graph — the mock is for
  // local dev / tests only (off-Azure). See server/azure/directory.ts isRealGraph().
  { name: 'NUXT_GRAPH_DIRECTORY_MODE', value: 'graph' }
  // ── Database + Redis (from KV) ──
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'REDIS_URL', secretRef: 'redis-url' }
  // ── Session secrets (from KV) ──
  { name: 'NUXT_SESSION_SECRET', secretRef: 'session-secret' }
  { name: 'NUXT_HMAC_SESSION_KEY', secretRef: 'hmac-session-key' }
  { name: 'NUXT_INTERNAL_WORKER_HMAC_KEY', secretRef: 'internal-worker-hmac-key' }
  // ── OIDC (real Entra; not dev-mode) ──
  // Env var NAMES MUST match Nuxt's runtimeConfig.oidc.providers.entra.*
  // overlay path. `NUXT_OIDC_PROVIDERS_ENTRA_<FIELD>` overrides the
  // build-baked placeholder in nuxt.config.ts at container boot.
  //
  // Authorization + token URLs are built here from the tenant ID so the
  // runtime container has fully-formed values; nuxt.config.ts can't
  // derive them (process.env reads there happen at build time and are
  // empty inside az acr build). Compose only if tenant ID is non-empty
  // — empty = phase-1 bring-up before app reg exists.
  { name: 'NUXT_OIDC_AUTH_DEV_MODE', value: 'false' }
  { name: 'NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID', value: entraClientId }
  { name: 'NUXT_OIDC_PROVIDERS_ENTRA_REDIRECT_URI', value: entraRedirectUri }
  {
    name: 'NUXT_OIDC_PROVIDERS_ENTRA_AUTHORIZATION_URL'
    value: empty(entraTenantId) ? '' : 'https://login.microsoftonline.com/${entraTenantId}/oauth2/v2.0/authorize'
  }
  {
    name: 'NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL'
    value: empty(entraTenantId) ? '' : 'https://login.microsoftonline.com/${entraTenantId}/oauth2/v2.0/token'
  }
  // ── Federated logout (end_session_endpoint) ──
  // LOGOUT_URL: Entra's v2.0 end_session_endpoint, composed from tenant.
  // LOGOUT_REDIRECT_URI: post_logout_redirect_uri Entra bounces back to;
  //   derived from the callback URI (…/auth/entra/callback → …/login) so a
  //   single entraRedirectUri param drives both. MUST be registered as a
  //   redirect URI on the app registration or Entra rejects the redirect.
  // Without LOGOUT_URL the module redirects logout at the request Host,
  // which AFD rewrites to the origin FQDN → require-front-door 500.
  {
    name: 'NUXT_OIDC_PROVIDERS_ENTRA_LOGOUT_URL'
    value: empty(entraTenantId) ? '' : 'https://login.microsoftonline.com/${entraTenantId}/oauth2/v2.0/logout'
  }
  {
    name: 'NUXT_OIDC_PROVIDERS_ENTRA_LOGOUT_REDIRECT_URI'
    value: empty(entraRedirectUri) ? '' : replace(entraRedirectUri, '/auth/entra/callback', '/login')
  }
  // ── Wave-V persona override + JIT bootstrap ──
  // Bicep's string(true) returns 'True' (capital T, .NET-style), NOT
  // 'true'. The triple-gate in dev-login.post.ts compares against the
  // literal lowercase 'true' — so string(bool) silently breaks the
  // override on every deploy. Use a ternary to emit a canonical
  // lowercase token.
  { name: 'NUXT_ALLOW_PERSONA_OVERRIDE', value: allowPersonaOverride ? 'true' : 'false' }
  { name: 'NUXT_BOOTSTRAP_ADMIN_EMAIL', value: bootstrapAdminEmail }
  // ── Monitoring ──
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
  // ── App / runtime config ──
  { name: 'NITRO_PORT', value: '3000' }
  { name: 'AZURE_CLIENT_ID', value: identityClientId }
  { name: 'AZURE_KEYVAULT_URL', value: keyVaultUri }
  // ── Wave-II Front Door hook ──
  // The require-front-door middleware is a Wave-II deliverable. For
  // Wave-I, the variable is plumbed but defaults to empty string,
  // making the middleware a no-op until Wave-II flips it on.
  { name: 'AZURE_FRONT_DOOR_ID', value: azureFrontDoorId }
  // Pinned public origin for a proxy-fronted custom hostname (IT dev zone).
  // Empty everywhere else → public origin derives from AFD / the request Host.
  { name: 'APP_PUBLIC_ORIGIN', value: appPublicOrigin }
  // ── Rate-limiter trustworthy IP source (CORE-4) ──
  // nuxt-security's limiter defaults to the first X-Forwarded-For hop, which
  // AFD only APPENDS to (so it is client-controlled → spoofable). When AFD
  // fronts the app, key the limiter on AFD's authoritative X-Azure-ClientIP
  // instead; with AFD off, the empty value keeps the single-origin default.
  // Set in lockstep with AZURE_FRONT_DOOR_ID above — the nuxt.config
  // `ipHeader: ''` slot only becomes trustworthy once this overlay binds it.
  { name: 'NUXT_SECURITY_RATE_LIMITER_IP_HEADER', value: empty(azureFrontDoorId) ? '' : 'x-azure-clientip' }
]

// ── Wave-VII build provenance (R1 F2) ──
// CONDITIONAL emit. Container Apps semantics: an explicit empty env value
// OVERRIDES the image's baked ENV. To preserve the Dockerfile-baked
// fallback when Bicep doesn't carry a SHA (e.g., a `latest`-tag re-apply
// with no pipeline-supplied SHA), only emit the env var when non-empty.
// Empty `gitCommitSha` → no env var → container reads the bake.
var gitCommitShaEnvVars = !empty(gitCommitSha) ? [
  { name: 'GIT_COMMIT_SHA', value: gitCommitSha }
] : []

// ── Conditional env vars (only when corresponding KV secret exists) ──
// The analytics poller reads the org admin key as NUXT_ANTHROPIC_KEY_<credential_secret_name>
// (server/workers/analytics-poller.ts::resolveOrgApiKey). credential_secret_name 'insight'
// -> NUXT_ANTHROPIC_KEY_MAIN. The KV secret name (anthropic-admin-api-key) is decoupled
// from the env var; this secretRef is what links them. (Replaces the dead ANTHROPIC_API_KEY,
// which nothing read.)
var anthropicEnvVars = hasAnthropicKey ? [
  { name: 'NUXT_ANTHROPIC_KEY_MAIN', secretRef: 'anthropic-admin-api-key' }
] : []
// GitHub Copilot reconciliation PATs (F2 — GATED OFF). Env var name MUST equal
// envKeyForSecret('github', credential_secret_name) = NUXT_GITHUB_PAT_ + upper,
// '-'→'_' (credentials.ts). NUXT_GITHUB_PAT_PARTNER_DEMO <- credential_secret_name
// 'partner-demo'. Emitted only when the corresponding KV secret exists.
var githubPatEnvVars = concat(
  hasGithubPatPartnerDemo ? [
    { name: 'NUXT_GITHUB_PAT_PARTNER_DEMO', secretRef: 'github-pat-partner-demo' }
  ] : [],
  hasGithubPatProduction ? [
    // TEMPLATE: rename PRODUCTION to match the production credential_secret_name
    // (upper-cased, '-'→'_'), and the secretRef to its kv secret name.
    { name: 'NUXT_GITHUB_PAT_PRODUCTION', secretRef: 'github-pat-production' }
  ] : [],
  hasGithubPatApacNfr ? [
    // APAC NFR/internal enterprise — credential_secret_name 'enterprise-nfr'.
    { name: 'NUXT_GITHUB_PAT_ENTERPRISE_NFR', secretRef: 'github-pat-enterprise-nfr' }
  ] : []
)
// GitHub App private keys (App-credential path). Env var name MUST equal
// envKeyForGithubAppKey(credential_secret_name) = NUXT_GITHUB_APP_KEY_ + upper, '-'→'_'
// (credentials.ts). NUXT_GITHUB_APP_KEY_PARTNER_DEMO <- credential_secret_name
// 'partner-demo'. The value is the base64 PEM (github-app-auth.ts base64-decodes it).
var githubAppKeyEnvVars = concat(
  hasGithubAppKeyPartnerDemo ? [
    { name: 'NUXT_GITHUB_APP_KEY_PARTNER_DEMO', secretRef: 'github-app-key-partner-demo' }
  ] : []
)
var entraEnvVars = hasEntraClientSecret ? [
  { name: 'NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET', secretRef: 'entra-client-secret' }
] : []

// nuxt-oidc-auth module's encryption-key env vars. Without these the
// module generates random per-boot values (every revision roll =
// every active session invalidated AND /api/v1/auth/me can't decrypt
// the cookie set by /auth/entra/callback).
var oidcModuleEnvVars = hasOidcModuleSecrets ? [
  { name: 'NUXT_OIDC_SESSION_SECRET', secretRef: 'oidc-session-secret' }
  { name: 'NUXT_OIDC_AUTH_SESSION_SECRET', secretRef: 'oidc-auth-session-secret' }
  { name: 'NUXT_OIDC_TOKEN_KEY', secretRef: 'oidc-token-key' }
] : []
var aiFoundryEnvVars = !empty(aiFoundryEndpoint) ? [
  { name: 'ANTHROPIC_BASE_URL', value: aiFoundryEndpoint }
] : []

// ── Telemetry reader (Path B — Claude → Azure Monitor → Log Analytics) ──
// Emitted only once the DCE/DCR exist (azureMonitorLogsEndpoint non-empty).
// Flips the app to the LogAnalyticsReader + the real MI bearer mint:
//   - NUXT_TELEMETRY_READER=log-analytics → server/azure/reader.ts queries the
//     LAW via @azure/monitor-query (MI auth) instead of the local collector.
//   - NUXT_AZURE_MONITOR_AUTH=mi → server/auth/obo.ts mints the Azure Monitor
//     bearer via the user-assigned MI over IMDS (the real path; no static/mock).
//   - NUXT_AZURE_MONITOR_LOGS_ENDPOINT is the DCR logs URL the attest endpoint
//     hands the plugin as OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.
// See docs/development/sandbox-realclaude-journey.md.
var telemetryReaderEnvVars = !empty(azureMonitorLogsEndpoint) ? [
  { name: 'NUXT_TELEMETRY_READER', value: 'log-analytics' }
  { name: 'NUXT_LOG_ANALYTICS_WORKSPACE_ID', value: logAnalyticsCustomerId }
  { name: 'NUXT_AZURE_MI_CLIENT_ID', value: identityClientId }
  { name: 'NUXT_AZURE_MONITOR_AUTH', value: 'mi' }
  { name: 'NUXT_AZURE_MONITOR_LOGS_ENDPOINT', value: azureMonitorLogsEndpoint }
] : []

// ── Container App ──────────────────────────────────────────────────

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${name}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      secrets: allSecrets
    }
    template: {
      containers: [
        {
          name: 'tokenscope'
          image: '${acrLoginServer}/tokenscope:${imageTag}'
          resources: {
            cpu: json(environment == 'production' ? '1.0' : '0.5')
            memory: environment == 'production' ? '2Gi' : '1Gi'
          }
          env: concat(baseEnvVars, anthropicEnvVars, githubPatEnvVars, githubAppKeyEnvVars, entraEnvVars, oidcModuleEnvVars, aiFoundryEnvVars, gitCommitShaEnvVars, telemetryReaderEnvVars)
          probes: [
            // Startup probe: gives the Nuxt server time to bind and run
            // any first-touch DB / Redis warmups. 5s initial delay +
            // 24 × 5s = 125s startup window.
            {
              type: 'Startup'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 5
              failureThreshold: 24
              timeoutSeconds: 5
            }
            // Liveness probe: process-only check; MUST NOT touch deps.
            // A transient PG/Redis blip into liveness would loop-restart.
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              periodSeconds: 30
              failureThreshold: 3
              timeoutSeconds: 5
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 3
              timeoutSeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: environment == 'production' ? 5 : 3
      }
    }
  }
}

@description('Container App FQDN (e.g. ca-tokenscope-sandbox-aue.greenfield-xxx.australiaeast.azurecontainerapps.io).')
output fqdn string = containerApp.properties.configuration.ingress.fqdn

@description('Container App resource name.')
output appName string = containerApp.name

@description('Container App Environment resource ID (for future co-deployed apps in the same env).')
output environmentId string = containerAppEnv.id

@description('ACA environment default domain (e.g. happyhill-0a1b2c3d.westus3.azurecontainerapps.io). For an INTERNAL env this is the private DNS zone name IT must create centrally — surfaced to them via scripts/ci/it-dev-handoff.sh.')
output defaultDomain string = containerAppEnv.properties.defaultDomain

@description('ACA environment static IP. Internal env → the private VIP on snet-container-apps that the private DNS A records must point at. External env → the public inbound IP.')
output staticIp string = containerAppEnv.properties.staticIp

@description('Latest revision name — handy for rollback wiring in deploy workflows.')
output revisionName string = containerApp.properties.latestRevisionName
