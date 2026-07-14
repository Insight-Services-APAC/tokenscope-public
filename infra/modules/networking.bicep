// ── Networking — VNet, subnets, private DNS zones ──────────────────
//
// Wave III deliverable. Only emitted when `enablePrivateNetworking =
// true` (conditional in main.bicep). Sandbox stays public + RBAC and
// never references this module's outputs; dev / staging / production
// turn it on once this module is validated end-to-end.
//
// VNet layout (default — overridable per env via main.bicep params):
//   addressSpace          10.0.0.0/16
//   snet-container-apps   10.0.0.0/23  ← Container Apps env delegation
//   snet-private-endpoints 10.0.2.0/24 ← PE NICs for KV/PG/Redis
//
// Subnet minimums (this env is a WORKLOAD-PROFILES Container Apps env —
// see container-app.bicep `workloadProfiles`):
//   snet-container-apps    >= /27  (workload-profiles minimum per MS
//                          Learn; /23 is the LEGACY Consumption-only
//                          minimum and does not apply here).
//   snet-private-endpoints   sized to the PE count. KV+PG+Redis = 3
//                          (a /29's 3 usable); +ACR when ACR is private
//                          = 4, so dev uses a **/28** (11 usable) for
//                          headroom. Azure reserves 5 IPs of every subnet.
// The defaults above are deliberately generous for staging/production
// headroom; dev tightens to /26 VNet · /27 CA · /28 PE in dev.bicepparam.
// Do not shrink the CA subnet below /27 — the env provisions will fail.
//
// Wave-VII* (corporate Dev rollout) — IT-actionable params: each VNet
// range + the optional hub-peering target are parameterised so Insight
// IT can plug their IPAM-assigned range + central hub VNet without
// touching this module. Sandbox/staging/production keep the defaults.
//
// Private DNS zones (one per data-plane resource type):
//   privatelink.vaultcore.azure.net          ← Key Vault
//   privatelink.postgres.database.azure.com  ← PG Flex Server
//   privatelink.redis.cache.windows.net      ← Redis
//   privatelink.azurecr.io                   ← ACR (Premium when private)
//
// Two DNS ownership modes:
//   self-owned (default) — this module creates the four zones + links
//     them to the VNet. Correct for standalone environments (sandbox,
//     and staging/production until they move into an IT zone).
//   central (IT zone)    — `centralDnsZonesSubscriptionId` +
//     `centralDnsZonesResourceGroup` set → zones/links are NOT created;
//     outputs compose resource IDs of IT's existing central zones, and
//     IT creates the VNet links. Dev uses this (your-subscription /
//     rg-hub-network-example per IT network team, 2026-06-11).

@description('Resource name suffix (e.g. tokenscope-staging-aue).')
param name string

@description('Azure region for the VNet + subnets.')
param location string

@description('VNet resource name override. Empty = derive `vnet-<name suffix>` (sandbox/staging/production convention). IT-zone environments (dev) must use the name issued by the network team — e.g. vnet-tokenscope-example — because IT scripts the hub peerings + DNS VNet links against that exact name.')
param vnetName string = ''

// ── Central private-DNS mode (IT-zone environments) ─────────────────
// When IT manages the privatelink zones centrally (one zone per service
// in a hub networking RG, linked to spoke VNets by IT automation), this
// module must NOT create its own zones or links — duplicated zones on
// the spoke VNet would shadow the central ones and break resolution
// from peered networks. Set BOTH params to flip into consume-existing
// mode: zone create + VNet-link resources are elided and the outputs
// compose cross-subscription resource IDs pointing at the central
// zones. The PE dnsZoneGroups in the data-plane modules then register
// their A records into IT's zones — which requires the deploying SP to
// hold Private DNS Zone Contributor (or at least join + record write)
// on those zones. IT creates the VNet links (VNLs) on its side.

@description('Subscription ID hosting the IT-central privatelink DNS zones (e.g. your-subscription). Empty = self-owned zones (sandbox/staging/production).')
param centralDnsZonesSubscriptionId string = ''

@description('Resource group hosting the IT-central privatelink DNS zones (e.g. rg-hub-network-example). Empty = self-owned zones.')
param centralDnsZonesResourceGroup string = ''

@description('VNet address space CIDR. Default 10.0.0.0/16 matches sandbox-validated PSR layout. Insight IT typically assigns an IPAM-coordinated range for corporate Dev — override via dev.bicepparam.')
param vnetAddressSpace string = '10.0.0.0/16'

@description('Container Apps subnet CIDR. MUST be >= /27 for this workload-profiles env (/23 is the legacy Consumption-only minimum). Delegated to Microsoft.App/environments. Default 10.0.0.0/23 fits inside the default /16; dev tightens to /27.')
param containerAppsSubnetPrefix string = '10.0.0.0/23'

@description('Private-endpoint subnet CIDR. One NIC per data-plane PE: KV + PG + Redis (+ ACR when ACR is private) = up to 4. dev uses /28 (11 usable, headroom); default 10.0.2.0/24 has more. /29 only fits 3 (pre-ACR-private).')
param privateEndpointsSubnetPrefix string = '10.0.2.0/24'

@description('Optional dedicated subnet CIDR for the Azure Monitor Private Link Scope (AMPLS) private endpoint. The `azuremonitor` PE allocates several IPs (one per Monitor data-plane endpoint), more than fit alongside the data-plane PEs in the main PE subnet — so it gets its own subnet. Empty = no AMPLS subnet (the monitoring module then provisions no AMPLS PE). Set per-env where monitorQueryPrivateOnly is on (dev: 10.0.0.48/28).')
param amplsSubnetPrefix string = ''

@description('Optional hub VNet resource ID for peering. Empty = no peering (default — sandbox/staging/production). Set in dev.bicepparam when Insight IT requires peering to a central hub VNet for on-prem connectivity. The peering is one-way (this VNet → hub); IT establishes the reverse peering on the hub side.')
param hubVnetId string = ''

@description('Use the hub VNet\'s gateway for on-prem connectivity (typical enterprise hub-spoke pattern with ExpressRoute / VPN). Default false stays safe when the hub has no gateway. Set true via dev.bicepparam when IT confirms the hub has a gateway AND has set allowGatewayTransit=true on the reverse peering. Ignored when hubVnetId is empty.')
param useRemoteGateways bool = false

@description('Tags applied to every resource in this module.')
param tags object = {}

// Both central-DNS params must be set together. Half-set is always a
// misconfiguration (the zone-ID outputs would compose malformed
// cross-subscription resource IDs like /subscriptions//resourceGroups/…),
// so fail LOUDLY at deploy time instead of letting it surface four
// resources deep as an opaque InvalidResourceId on a PE zone group.
var centralDnsParamsConsistent = empty(centralDnsZonesSubscriptionId) == empty(centralDnsZonesResourceGroup)
var useCentralDnsZones = centralDnsParamsConsistent
  ? !empty(centralDnsZonesSubscriptionId)
  : fail('centralDnsZonesSubscriptionId and centralDnsZonesResourceGroup must be set together — exactly one of them is empty.')

// ── VNet + Subnets ──────────────────────────────────────────────────

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: empty(vnetName) ? 'vnet-${name}' : vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressSpace
      ]
    }
    subnets: concat([
      {
        name: 'snet-container-apps'
        properties: {
          addressPrefix: containerAppsSubnetPrefix
          // Container Apps env requires the subnet delegated to
          // Microsoft.App/environments. Without this, the env's
          // managed-environment creation fails with a "subnet not
          // delegated" error.
          delegations: [
            {
              name: 'Microsoft.App.environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: privateEndpointsSubnetPrefix
          // Private endpoint subnets must have
          // privateEndpointNetworkPolicies=Disabled (legacy default
          // for some regions). New deployments default correctly but
          // setting it explicitly avoids surprise.
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ], empty(amplsSubnetPrefix) ? [] : [
      {
        // Dedicated subnet for the Azure Monitor Private Link Scope PE: the
        // `azuremonitor` PE wants several IPs (one per Monitor endpoint), which
        // overflow the shared PE subnet (SubnetIsFull). Inside our own VNet
        // address space, so no cross-VNet conflict.
        name: 'snet-ampls'
        properties: {
          addressPrefix: amplsSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ])
  }
}

// ── Hub VNet peering (optional, IT-driven) ──────────────────────────
// Emitted only when `hubVnetId` is non-empty. The reverse peering
// (hub → this VNet) MUST be created by IT on the hub side; without it
// traffic flows one-way. Insight central tooling typically orchestrates
// the pair via a hub-spoke automation; this module just creates our
// spoke side.

resource peeringToHub 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-01-01' = if (!empty(hubVnetId)) {
  parent: vnet
  name: 'peer-to-hub'
  properties: {
    remoteVirtualNetwork: {
      id: hubVnetId
    }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: true
    // This VNet is a spoke — never lets others traverse via us (we have
    // no gateway). useRemoteGateways defers to IT's call on whether the
    // hub's gateway routes our on-prem traffic; default false stays safe.
    allowGatewayTransit: false
    useRemoteGateways: useRemoteGateways
  }
}

// ── Private DNS Zones ───────────────────────────────────────────────
// Each private endpoint's name resolution requires a matching DNS zone
// linked to the VNet. The zones live at `global` location (they are
// not regional resources).
//
// CONFIRMED 2026-06-11 (Tricia, IT network team): on the IT-hosted dev
// instance the four privatelink zones are CENTRAL — they live in
// your-subscription / rg-hub-network-example and IT creates the VNet
// links. dev.bicepparam sets the central-DNS params, flipping this
// module into consume-existing mode: nothing below is created, and the
// outputs point at IT's zones. Sandbox/staging/production keep the
// self-owned shape (params empty → resources emitted as before).

// Zone names are shared between create-mode (resource names below) and
// central-mode (composed into cross-sub resource IDs in the outputs).
var zoneNameKeyVault = 'privatelink.vaultcore.azure.net'
var zoneNamePostgresql = 'privatelink.postgres.database.azure.com'
var zoneNameRedis = 'privatelink.redis.cache.windows.net'
var zoneNameAcr = 'privatelink.azurecr.io'

resource dnsKeyVault 'Microsoft.Network/privateDnsZones@2024-06-01' = if (!useCentralDnsZones) {
  name: zoneNameKeyVault
  location: 'global'
  tags: tags
}

resource dnsPostgresql 'Microsoft.Network/privateDnsZones@2024-06-01' = if (!useCentralDnsZones) {
  name: zoneNamePostgresql
  location: 'global'
  tags: tags
}

resource dnsRedis 'Microsoft.Network/privateDnsZones@2024-06-01' = if (!useCentralDnsZones) {
  name: zoneNameRedis
  location: 'global'
  tags: tags
}

resource dnsAcr 'Microsoft.Network/privateDnsZones@2024-06-01' = if (!useCentralDnsZones) {
  name: zoneNameAcr
  location: 'global'
  tags: tags
}

// ── DNS Zone VNet Links ─────────────────────────────────────────────
// Without these the private endpoint NICs get IPs but the DNS A
// records aren't resolvable from inside the VNet — the container app
// would still try to reach `kv-...vault.azure.net` over the public IP
// and the network ACL would block it.
//
// Central-DNS mode: SKIPPED — IT links its central zones to this VNet
// from their side (we hand them the VNet name; they create the VNLs).
// We could not create them anyway: the link is a child of the zone,
// which lives in IT's subscription.

resource linkKeyVault 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (!useCentralDnsZones) {
  parent: dnsKeyVault
  name: 'link-${name}'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}

resource linkPostgresql 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (!useCentralDnsZones) {
  parent: dnsPostgresql
  name: 'link-${name}'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}

resource linkRedis 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (!useCentralDnsZones) {
  parent: dnsRedis
  name: 'link-${name}'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}

resource linkAcr 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (!useCentralDnsZones) {
  parent: dnsAcr
  name: 'link-${name}'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}

// ── Outputs ──────────────────────────────────────────────────────────

@description('VNet resource ID. Consumed by data-plane modules when wiring private endpoints.')
output vnetId string = vnet.id

@description('Container Apps subnet resource ID. Passed to container-app.bicep `containerAppsSubnetId` when private networking is on.')
output containerAppsSubnetId string = '${vnet.id}/subnets/snet-container-apps'

@description('Private-endpoint subnet resource ID. Passed to each data-plane module `privateEndpointSubnetId` param.')
output privateEndpointSubnetId string = '${vnet.id}/subnets/snet-private-endpoints'

@description('Dedicated AMPLS-PE subnet resource ID, or empty when amplsSubnetPrefix is unset. Passed to the monitoring module for the Azure Monitor Private Link Scope private endpoint.')
output amplsSubnetId string = empty(amplsSubnetPrefix) ? '' : '${vnet.id}/subnets/snet-ampls'

@description('VNet resource name — handed to IT so they can create the hub peerings + central-zone VNet links against it.')
output vnetName string = vnet.name

// Zone-ID outputs: central mode composes cross-subscription resource
// IDs pointing at IT's zones; self-owned mode returns our own. The PE
// dnsZoneGroup resources downstream accept either — registering records
// into a cross-sub zone just needs the SP to hold join/record rights
// on it (Private DNS Zone Contributor on IT's networking RG).

@description('Key Vault private DNS zone resource ID.')
output dnsZoneKeyVaultId string = useCentralDnsZones
  ? resourceId(centralDnsZonesSubscriptionId, centralDnsZonesResourceGroup, 'Microsoft.Network/privateDnsZones', zoneNameKeyVault)
  : dnsKeyVault.id

@description('PostgreSQL private DNS zone resource ID.')
output dnsZonePostgresqlId string = useCentralDnsZones
  ? resourceId(centralDnsZonesSubscriptionId, centralDnsZonesResourceGroup, 'Microsoft.Network/privateDnsZones', zoneNamePostgresql)
  : dnsPostgresql.id

@description('Redis private DNS zone resource ID.')
output dnsZoneRedisId string = useCentralDnsZones
  ? resourceId(centralDnsZonesSubscriptionId, centralDnsZonesResourceGroup, 'Microsoft.Network/privateDnsZones', zoneNameRedis)
  : dnsRedis.id

@description('ACR private DNS zone resource ID (privatelink.azurecr.io). Consumed by container-registry.bicep when ACR is private.')
output dnsZoneAcrId string = useCentralDnsZones
  ? resourceId(centralDnsZonesSubscriptionId, centralDnsZonesResourceGroup, 'Microsoft.Network/privateDnsZones', zoneNameAcr)
  : dnsAcr.id
