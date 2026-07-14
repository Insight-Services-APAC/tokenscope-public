// ── PostgreSQL Flexible Server ─────────────────────────────────────
//
// TokenScope schema requires `btree_gist`, `ltree`, `pgcrypto` per
// docs/design/data-model.md. The allow-listed extensions are configured
// via the `azure.extensions` server param; the Drizzle migrations issue
// `CREATE EXTENSION` once they're allow-listed.

@description('Resource name suffix (e.g. tokenscope-sandbox-aue).')
param name string

@description('Azure region.')
param location string

@description('Environment name (drives SKU + HA shape).')
@allowed(['sandbox', 'dev', 'staging', 'production'])
param environment string

@description('Administrator login.')
@secure()
param adminLogin string

@description('Administrator password.')
@secure()
param adminPassword string

// ── Private Endpoint params (Wave-III; off in sandbox) ───────────────

@description('Enable private endpoint.')
param enablePrivateEndpoint bool = false

@description('Subnet ID for the private endpoint NIC.')
param privateEndpointSubnetId string = ''

@description('Private DNS zone ID for `privatelink.postgres.database.azure.com`.')
param privateDnsZoneId string = ''

@description('Log Analytics workspace resource ID for diagnostic settings. Empty = no diagnostic settings (PG audit logs disappear). Set to monitoring.outputs.logAnalyticsId for production-shape retention. Note PG audit logs ALSO require the server parameter `log_min_messages` set to `WARNING` or lower; the diagnostic settings only export what PG produces.')
param logAnalyticsId string = ''

@description('Tags applied to every resource.')
param tags object = {}

// Sandbox = burstable B1ms (cheap, sufficient for a single developer);
// production = D2ds_v4 with geo-redundant backup + ZoneRedundant HA.
var skuName = environment == 'production' ? 'Standard_D2ds_v4' : 'Standard_B1ms'
var skuTier = environment == 'production' ? 'GeneralPurpose' : 'Burstable'
var storageSizeGB = environment == 'production' ? 128 : 32

// PG flex server name max 63 chars; defensive truncation in case a
// future projectName change pushes the suffix past that limit.
var pgServerName = take('pg-${name}', 63)

resource postgresql 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: pgServerName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: '16'
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: storageSizeGB
    }
    backup: {
      backupRetentionDays: environment == 'production' ? 35 : 7
      geoRedundantBackup: environment == 'production' ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      mode: environment == 'production' ? 'ZoneRedundant' : 'Disabled'
    }
    // network: {} when public; `publicNetworkAccess: Disabled` when PE on.
    // Empty object {} is the documented Bicep idiom for "no networking
    // overrides", and matches PSR's pattern.
    network: enablePrivateEndpoint ? {
      publicNetworkAccess: 'Disabled'
    } : {}
  }
}

// ── Extensions allow-list ───────────────────────────────────────────
// `azure.extensions` is a dynamic param — no server restart required.
// This allow-lists; migrations issue `CREATE EXTENSION` to materialise.

resource allowedExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgresql
  name: 'azure.extensions'
  properties: {
    value: 'BTREE_GIST,LTREE,PGCRYPTO'
    source: 'user-override'
  }
}

// ── Database ────────────────────────────────────────────────────────

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgresql
  name: 'tokenscope'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Allow Azure-services traffic when NOT using a private endpoint — this is
// what lets the Container App connect to PG over the Azure backbone in
// sandbox + staging. The `0.0.0.0` start/end pair is Azure's documented
// idiom for the AllowAllAzureServicesAndResourcesWithinAzureIps switch.
resource firewallAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (!enablePrivateEndpoint) {
  parent: postgresql
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ── Private Endpoint (Wave-III) ──────────────────────────────────────

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = if (enablePrivateEndpoint) {
  name: 'pe-pg-${name}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'pe-pg-${name}'
        properties: {
          privateLinkServiceId: postgresql.id
          groupIds: [
            'postgresqlServer'
          ]
        }
      }
    ]
  }
}

// Zone group only when a zone ID was supplied — '' means IT registers
// the A record on their side (see key-vault.bicep for the rationale).
resource dnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = if (enablePrivateEndpoint && !empty(privateDnsZoneId)) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'postgresql'
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

// ── Diagnostic Settings ────────────────────────────────────────────
// Routes PG diagnostics to LAW. PG flex server emits log categories:
// PostgreSQLLogs, PostgreSQLFlexSessions, PostgreSQLFlexQueryStoreRuntime,
// PostgreSQLFlexQueryStoreWaitStats. `allLogs` exports them all.

resource pgDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: 'diag-${pgServerName}'
  scope: postgresql
  properties: {
    workspaceId: logAnalyticsId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

@description('Server fully qualified domain name.')
output serverFqdn string = postgresql.properties.fullyQualifiedDomainName

@description('Server resource name.')
output serverName string = postgresql.name
