// ── TokenScope — Sandbox example parameters ──────────────────────────────
//
// Public networking + optional Azure Front Door. Fast to stand up for a pilot.
// Copy this file, fill in your values, and deploy (see docs/DEPLOY-AZURE.md).
//
// @secure() params (passwords, keys, OIDC secrets) are passed at APPLY time,
// never hardcoded here:
//   az deployment group create -g <your-rg> -f infra/main.bicep \
//     -p infra/parameters/example-sandbox.bicepparam \
//     -p pgAdminLogin=... pgAdminPassword=... sessionSecret=... \
//        hmacSessionKey=... internalWorkerHmacKey=...

using '../main.bicep'

param env = 'sandbox'
param location = 'australiaeast'   // your Azure region
param projectName = 'tokenscope'
param imageTag = 'latest'          // your CD overrides this per roll

// ── Required @secure() (placeholders; pass real values at apply time) ────
param pgAdminLogin = ''
param pgAdminPassword = ''
param sessionSecret = ''
param hmacSessionKey = ''
param internalWorkerHmacKey = ''

// ── Auth (Entra ID OIDC) — optional for first bring-up ───────────────────
// The app boots without OIDC and serves the dev-mode UI. Once you create the
// app registration, set these (redirectUri = https://<fqdn>/auth/entra/callback,
// known only after the container app provisions — pass empty first, then re-apply).
param entraIdTenantId = ''
param entraIdClientId = ''
param entraIdClientSecret = ''
param entraIdRedirectUri = ''

// First Entra sign-in matching this email is JIT-created as `admin`.
param bootstrapAdminEmail = ''

// Demo persona override — handy on a sandbox, NEVER in production.
param allowPersonaOverride = true

// ── External APIs — optional (empty = pollers no-op) ─────────────────────
param anthropicApiKey = ''

// ── Networking / Front Door ──────────────────────────────────────────────
param enablePrivateNetworking = false   // sandbox stays public + RBAC
param enableFrontDoor = false           // flip true via the 3-phase apply (docs/DEPLOY-AZURE.md)

param keyVaultCreateMode = 'default'
