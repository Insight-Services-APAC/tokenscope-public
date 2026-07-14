// ── TokenScope — Fully VNet-integrated example parameters ────────────────
//
// Private endpoints on every data plane, internal container-app ingress,
// private Log Analytics query. Front your own ingress (a central WAF or Front
// Door). Copy, fill in your network values, and deploy (see docs/DEPLOY-AZURE.md).
//
// @secure() params are passed at APPLY time, never hardcoded:
//   az deployment group create -g <your-rg> -f infra/main.bicep \
//     -p infra/parameters/example-vnetted.bicepparam \
//     -p pgAdminLogin=... pgAdminPassword=... sessionSecret=... \
//        hmacSessionKey=... internalWorkerHmacKey=...

using '../main.bicep'

param env = 'production'
param location = 'westus3'          // your Azure region
param projectName = 'tokenscope'
param imageTag = 'latest'

// ── Required @secure() (placeholders; pass real values at apply time) ────
param pgAdminLogin = ''
param pgAdminPassword = ''
param sessionSecret = ''
param hmacSessionKey = ''
param internalWorkerHmacKey = ''

// ── Auth (Entra ID OIDC) ─────────────────────────────────────────────────
param entraIdTenantId = ''
param entraIdClientId = ''
param entraIdClientSecret = ''
param entraIdRedirectUri = ''       // https://<your-public-hostname>/auth/entra/callback
param bootstrapAdminEmail = ''
param allowPersonaOverride = false  // MUST be false in production

// ── Networking (the "fully vnetted" posture) ─────────────────────────────
param enablePrivateNetworking = true
param monitorQueryPrivateOnly = true          // private Log Analytics query

// Bring your own address space + subnets (adjust to your IPAM allocation):
param vnetName = 'vnet-tokenscope'
param vnetAddressSpace = '10.0.0.0/24'
param containerAppsSubnetPrefix = '10.0.0.0/27'
param privateEndpointsSubnetPrefix = '10.0.0.32/28'
param amplsSubnetPrefix = '10.0.0.48/28'

// If your central/hub DNS is in another subscription/RG, point at it and let
// that team own the private-DNS-zone group registration:
param centralDnsZonesSubscriptionId = ''      // e.g. your hub subscription GUID
param centralDnsZonesResourceGroup = ''       // e.g. rg-hub-network
param registerDnsZoneGroups = false           // false when central DNS owns registration

// Optional hub peering:
param hubVnetId = ''
param useRemoteGateways = false

// ── Front Door: usually off when a central WAF fronts you ────────────────
param enableFrontDoor = false

// ── External APIs — optional ─────────────────────────────────────────────
param anthropicApiKey = ''

param keyVaultCreateMode = 'default'
