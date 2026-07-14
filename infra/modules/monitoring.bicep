// ── Monitoring — Log Analytics + App Insights + AMW + alert rules ───
//
// TokenScope adopts the PSR pattern (psr/infra/modules/monitoring.bicep)
// and adds Azure Monitor Workspace for OTLP-preview metric ingestion
// from the developer plugin's per-session emit.
//
// Outputs consumed by:
//   - container-app.bicep (AppInsights connection string + LAW
//     customer ID/key for the ACA env's LogAnalytics destination)
//   - main.bicep (AMW ingestion endpoint forwarded to the container
//     app env var NUXT_AZURE_MONITOR_ENDPOINT)
//
// AVM note: avm/res/operational-insights/workspace and
// avm/res/insights/component cover the LAW + AppInsights resources
// individually. We use native resources here to match PSR's shape and
// keep the alert-rule wiring + AMW addition in one auditable place.
// Migration to AVM is a follow-up; revisit when the AppInsights AVM
// module supports the WorkspaceResourceId field consistently across
// versions.

@description('Resource name suffix (e.g. tokenscope-sandbox-aue).')
param name string

@description('Azure region.')
param location string

@description('Environment name — drives retention + alert severity defaults.')
@allowed(['sandbox', 'dev', 'staging', 'production'])
param environment string

@description('Daily ingestion cap in GB for Log Analytics (cost guard).')
@minValue(1)
param dailyIngestionCapGb int = 2

@description('Optional notification email for the alert action group. Empty = alerts fire but no email goes out (still visible in Monitor).')
param notificationEmail string = ''

@description('Tags applied to every resource in this module.')
param tags object = {}

@description('Principal ID of the user-assigned MI to grant OTLP-ingest publish + LAW read. Empty = no role assignments regardless of deployRbac.')
param identityPrincipalId string = ''

@description('Gate RBAC role assignments (the OIDC SP applying has Owner, so deployRbac=true is the normal sandbox apply).')
param deployRbac bool = false

@description('Deploy the Azure Monitor Workspace (Prometheus-shape OTLP metrics, preview). NOTHING consumes its outputs today — the token-usage path is LOGS via DCE/DCR. Set FALSE where the Microsoft.Monitor resource provider is not registered and the SP cannot register it (dev: your-subscription has it NotRegistered, registration is an IT-level action). Re-enable if/when the metrics path ships AND IT registers the provider.')
param deployAzureMonitorWorkspace bool = true

@description('Make the Log Analytics QUERY path private: publicNetworkAccessForQuery=Disabled + an Azure Monitor Private Link Scope (AMPLS, query=PrivateOnly / ingest=Open) + a private endpoint, so the corpus is queryable ONLY from inside the VNet. INGESTION stays public (clients emit OTLP from outside the zone). See docs/design/telemetry-query-network-posture.md. Empty privateEndpointSubnetId disables the PE regardless. Default false. Live on dev (2026-06-19): IT has linked the five Azure-Monitor privatelink zones to the VNet, so DNS is in place; the query path resolves over the AMPLS private endpoint. VERIFIED dev 2026-07-01: api.loganalytics.io (the reader SDK default) resolves to that private endpoint (same 10.0.0.x as api.monitor.azure.com) and queries succeed, so NUXT_AZURE_MONITOR_QUERY_ENDPOINT is left EMPTY — do NOT set api.monitor.azure.com (it 404s the LA query path). The 2026-06 outage was a stale app revision caching the pre-cutover public DNS; a fresh revision re-resolves private. #84 resolved.')
param enableQueryPrivateLink bool = false

@description('PE subnet resource id for the AMPLS private endpoint (from the networking module). Empty = no PE (AMPLS still scopes the workspace).')
param privateEndpointSubnetId string = ''

// ── Log Analytics Workspace ─────────────────────────────────────────

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${name}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: environment == 'production' ? 90 : 30
    workspaceCapping: {
      dailyQuotaGb: dailyIngestionCapGb
    }
    // INGESTION stays public — developer clients emit OTLP to the DCE from
    // outside the restricted zone (ADR-0003 Option H). QUERY goes private
    // when enableQueryPrivateLink: only the in-VNet app MI (Log Analytics
    // Reader) can then query, shrinking the exfiltration surface of a stolen
    // Reader credential. See docs/design/telemetry-query-network-posture.md.
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: enableQueryPrivateLink ? 'Disabled' : 'Enabled'
  }
}

// ── Azure Monitor Private Link Scope (private QUERY, public INGEST) ──
// ingestionAccessMode=Open keeps the DCE/ingest path public; queryAccessMode=
// PrivateOnly forces scoped-resource queries through the AMPLS private
// endpoint. Scoped resource = the Log Analytics workspace (the query target
// the read-joiner uses). The PE carries no DNS zone group in central-DNS
// envs (registerDnsZoneGroups=false) — IT registers the A records in the
// Azure-Monitor privatelink zones from the infra.yml handoff (privatelink.
// {monitor.azure.com, oms/ods.opinsights.azure.com, agentsvc.azure-automation.net,
// blob.core.windows.net}). Gated entirely on enableQueryPrivateLink.

resource ampls 'Microsoft.Insights/privateLinkScopes@2021-07-01-preview' = if (enableQueryPrivateLink) {
  name: 'ampls-${name}'
  location: 'global'
  tags: tags
  properties: {
    accessModeSettings: {
      ingestionAccessMode: 'Open'
      queryAccessMode: 'PrivateOnly'
    }
  }
}

resource amplsScopedLaw 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-07-01-preview' = if (enableQueryPrivateLink) {
  parent: ampls
  name: 'scoped-law'
  properties: {
    linkedResourceId: logAnalytics.id
  }
}

resource amplsPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = if (enableQueryPrivateLink && !empty(privateEndpointSubnetId)) {
  name: 'pe-ampls-${name}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'pe-ampls-${name}'
        properties: {
          privateLinkServiceId: ampls.id
          groupIds: [
            'azuremonitor'
          ]
        }
      }
    ]
  }
}

// ── Application Insights ────────────────────────────────────────────

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${name}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    SamplingPercentage: 100
  }
}

// ── Azure Monitor Workspace (OTLP-preview metric ingestion) ─────────
// Receives Prometheus-shape metrics from the OTel Collector / plugin
// per docs/design/architecture.md §1.5. Not used by the app itself —
// the developer plugin emits here.

resource azureMonitorWorkspace 'Microsoft.Monitor/accounts@2023-04-03' = if (deployAzureMonitorWorkspace) {
  name: 'amw-${name}'
  location: location
  tags: tags
}

// ── OTLP ingestion (preview): DCE + DCR + MI RBAC ───────────────────
// ADR-0003 Shape A: Claude Code posts OTLP/HTTP DIRECT to the DCE with an
// Entra bearer the TokenScope app mints via its MI (server/auth/obo.ts,
// audience https://monitor.azure.com/.default). The app's MI needs
// `Monitoring Metrics Publisher` to write and `Log Analytics Reader` to
// run the read-joiner's KQL.
//
// VERIFIED on the live sandbox 2026-06-01 (see the "Verified OTLP → Azure
// Monitor ingestion recipe" in docs/development/claude-code-telemetry-contract.md),
// closing the prior [VERIFY at sandbox]:
//   (a) Wiring is DCE + DCR + stream. The OTLP ingest URL is
//         https://<logs-dce-domain>/dataCollectionRules/<dcrImmutableId>/streams/Microsoft-OTLP-Logs/otlp/v1/logs
//       where Microsoft-OTLP-Logs is a SERVICE-MANAGED built-in stream (the
//       DCR needs no streamDeclarations for it). Events land in OTelLogs.
//   (b) The POST needs: Authorization: Bearer <monitor.azure.com/.default
//       token>, Content-Type: application/x-protobuf (JSON → HTTP 415), and
//       an explicit Content-Length (chunked → HTTP 400 MissingContentLengthHeader).
//       Our injected resource attrs land in OTelLogs.ResourceAttributes and
//       per-event token fields in OTelLogs.Attributes (see server/azure/reader.ts).

resource dataCollectionEndpoint 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = {
  name: 'dce-${name}'
  location: location
  tags: tags
  properties: {
    networkAcls: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// VERIFIED against the live working sandbox DCR (read at api-version 2024-03-11,
// 2026-06-18): direct OTLP ingestion to the DCE is only accepted when the DCR
// declares `directDataSources.otelLogs` (the "sent directly with OTel Collector"
// path per Microsoft's OTLP-ingestion doc). A plain logs DCR (dataFlows only)
// returns HTTP 400 InvalidStream for POSTs to .../streams/Microsoft-OTLP-Logs/...
// — which is exactly why dev's bicep-built DCR never ingested while sandbox's
// (hand-created from Microsoft's OTLP_DCE_DCR ARM template) did. We add the
// `dataSources` + `directDataSources` + `references` sections the doc requires,
// at api-version 2024-03-11 (the version that expresses `directDataSources`).
//
// Logs + traces only: `otelMetrics` is intentionally omitted because it must
// route to an Azure Monitor Workspace `monitoringAccounts` destination, and envs
// with `deployAzureMonitorWorkspace = false` (dev: Microsoft.Monitor NotRegistered)
// have none — including it would fail the apply. Token usage is logs. The change
// is additive (the prior DCR had no data sources), so no env loses metrics.
//
// Stream-name note: the direct-OTLP ingest URL uses the service-managed
// 'Microsoft-OTLP-Logs' segment, while the DCR-internal stream id (in
// dataSources/directDataSources/dataFlows) is 'Microsoft-OTel-Logs'. The names
// differ by design — verified verbatim against the working sandbox DCR.
resource dataCollectionRule 'Microsoft.Insights/dataCollectionRules@2024-03-11' = {
  name: 'dcr-${name}-otlp'
  location: location
  tags: tags
  properties: {
    dataCollectionEndpointId: dataCollectionEndpoint.id
    references: {
      applicationInsights: [
        {
          name: 'applicationInsightsResource'
          resourceId: appInsights.id
        }
      ]
    }
    dataSources: {
      otelLogs: [
        {
          name: 'otelLogsDataSource'
          streams: [ 'Microsoft-OTel-Logs' ]
          enrichWithReference: 'applicationInsightsResource'
          enrichWithResourceAttributes: [ '*' ]
          replaceResourceIdWithReference: true
        }
      ]
      otelTraces: [
        {
          name: 'otelTracesDataSource'
          streams: [
            'Microsoft-OTel-Traces-Spans'
            'Microsoft-OTel-Traces-Events'
            'Microsoft-OTel-Traces-Resources'
          ]
          enrichWithReference: 'applicationInsightsResource'
          enrichWithResourceAttributes: [ '*' ]
          replaceResourceIdWithReference: true
        }
      ]
    }
    directDataSources: {
      otelLogs: [
        {
          name: 'otelLogsDataSourceDirect'
          streams: [ 'Microsoft-OTel-Logs' ]
          enrichWithReference: 'applicationInsightsResource'
          enrichWithResourceAttributes: [ '*' ]
          replaceResourceIdWithReference: true
        }
      ]
      otelTraces: [
        {
          name: 'otelTracesDataSourceDirect'
          streams: [
            'Microsoft-OTel-Traces-Spans'
            'Microsoft-OTel-Traces-Events'
            'Microsoft-OTel-Traces-Resources'
          ]
          enrichWithReference: 'applicationInsightsResource'
          enrichWithResourceAttributes: [ '*' ]
          replaceResourceIdWithReference: true
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          workspaceResourceId: logAnalytics.id
          name: 'la-dest'
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-OTel-Logs'
          'Microsoft-OTel-Traces-Spans'
          'Microsoft-OTel-Traces-Events'
          'Microsoft-OTel-Traces-Resources'
        ]
        destinations: [ 'la-dest' ]
      }
    ]
  }
}

var monitoringMetricsPublisherRoleId = '3913510d-42f4-4e42-8a64-420c390055eb' // Monitoring Metrics Publisher
var logAnalyticsReaderRoleId = '73c42c96-874c-492b-b04d-ab87d138a893' // Log Analytics Reader

resource publisherOnDcr 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRbac && !empty(identityPrincipalId)) {
  name: guid(dataCollectionRule.id, identityPrincipalId, monitoringMetricsPublisherRoleId)
  scope: dataCollectionRule
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringMetricsPublisherRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource readerOnLaw 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRbac && !empty(identityPrincipalId)) {
  name: guid(logAnalytics.id, identityPrincipalId, logAnalyticsReaderRoleId)
  scope: logAnalytics
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', logAnalyticsReaderRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ── Action Group ────────────────────────────────────────────────────
// Empty notificationEmail = no group provisioned, alerts still fire
// (visible in Monitor) but no email/Teams ping. PSR's pattern.

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (!empty(notificationEmail)) {
  name: 'ag-${name}'
  location: 'global'
  tags: tags
  properties: {
    // `groupShortName` max length is 12 chars (ARM constraint). It shows
    // up in email subjects + SMS. PSR's `take(replace(name,'-',''),12)`
    // collapses to the same 'tokenscopesa' across all envs, making
    // on-call routing ambiguous. Map env name → short tag explicitly:
    //   sandbox    → ts-sand    (8)
    //   dev        → ts-dev     (7)
    //   staging    → ts-stage   (9)
    //   production → ts-prod    (8)
    // All under 12; all env-distinguishable.
    groupShortName: 'ts-${environment == 'production' ? 'prod' : environment == 'staging' ? 'stage' : environment == 'dev' ? 'dev' : 'sand'}'
    enabled: true
    emailReceivers: [
      {
        name: 'ops-email'
        emailAddress: notificationEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

var actionGroups = empty(notificationEmail) ? [] : [
  { actionGroupId: actionGroup.id }
]

// ── Alert Rules ────────────────────────────────────────────────────
// Sev 2 = page; Sev 3 = noise floor. Sandbox keeps all alerts on for
// validation; production may want to tune thresholds upward as load
// grows.

// 1. Server Error Rate (5xx) — Sev 2
resource errorRateAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-error-rate-${name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Failed request count (5xx) exceeds 5 over a 5-minute window.'
    severity: 2
    enabled: true
    scopes: [ appInsights.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ServerErrorRate'
          metricName: 'requests/failed'
          metricNamespace: 'microsoft.insights/components'
          operator: 'GreaterThan'
          threshold: 5
          timeAggregation: 'Count'
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'request/resultCode'
              operator: 'Include'
              values: ['500', '501', '502', '503', '504']
            }
          ]
        }
      ]
    }
    actions: actionGroups
  }
}

// 2. Response Time — Sev 3
resource responseTimeAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-response-time-${name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Average response time exceeds 3 seconds over a 5-minute window.'
    severity: 3
    enabled: true
    scopes: [ appInsights.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'HighResponseTime'
          metricName: 'requests/duration'
          metricNamespace: 'microsoft.insights/components'
          operator: 'GreaterThan'
          threshold: 3000
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: actionGroups
  }
}

// 3. Exception Rate — Sev 2
resource exceptionRateAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-exception-rate-${name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Exception count exceeds 10 in 5 minutes.'
    severity: 2
    enabled: true
    scopes: [ appInsights.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ExceptionSpike'
          metricName: 'exceptions/count'
          metricNamespace: 'microsoft.insights/components'
          operator: 'GreaterThan'
          threshold: 10
          timeAggregation: 'Count'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: actionGroups
  }
}

// 4. Dependency Failure Rate — Sev 2
// Catches PG / Redis / Anthropic API failures the app reports as
// dependency failures via AppInsights auto-instrumentation.
resource dependencyFailureAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-dependency-failures-${name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Dependency failure count exceeds 5 in 5 minutes — check PG / Redis / Anthropic API.'
    severity: 2
    enabled: true
    scopes: [ appInsights.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'DependencyFailures'
          metricName: 'dependencies/failed'
          metricNamespace: 'microsoft.insights/components'
          operator: 'GreaterThan'
          threshold: 5
          timeAggregation: 'Count'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: actionGroups
  }
}

// ── Outputs ──────────────────────────────────────────────────────────

@description('Log Analytics workspace resource ID.')
output logAnalyticsId string = logAnalytics.id

@description('Log Analytics workspace customer ID (workspace GUID).')
output logAnalyticsCustomerId string = logAnalytics.properties.customerId

@description('Log Analytics workspace name. Consumers needing the shared key reference the workspace as `existing` + call `listKeys()` themselves — the key never crosses a module-output boundary, which keeps it out of the ARM deployment template entirely.')
output logAnalyticsName string = logAnalytics.name

@description('Application Insights connection string — wire into container app env as APPLICATIONINSIGHTS_CONNECTION_STRING.')
output appInsightsConnectionString string = appInsights.properties.ConnectionString

@description('Application Insights resource name.')
output appInsightsName string = appInsights.name

@description('Azure Monitor Workspace resource ID. The per-region OTLP ingest endpoint is reached via a Data Collection Endpoint + Data Collection Rule pair (not provisioned here yet — see Wave-N follow-up). For Wave-I deploys, the container app reads NUXT_AZURE_MONITOR_ENDPOINT from a Key Vault secret seeded externally, NOT derived from this output.')
output amwResourceId string = deployAzureMonitorWorkspace ? azureMonitorWorkspace!.id : ''

@description('Azure Monitor Workspace name — used by future DCE/DCR provisioning.')
output amwName string = deployAzureMonitorWorkspace ? azureMonitorWorkspace!.name : ''

@description('DCE logs-ingestion endpoint (host base). VERIFIED full OTLP logs URL: <this>/dataCollectionRules/<dcrImmutableId>/streams/Microsoft-OTLP-Logs/otlp/v1/logs — the plugin sets this as OTEL_EXPORTER_OTLP_LOGS_ENDPOINT and Claude POSTs application/x-protobuf with an explicit Content-Length.')
output dceLogsIngestionEndpoint string = dataCollectionEndpoint.properties.logsIngestion.endpoint

@description('DCR immutable id — required path segment in the OTLP ingest URL (…/dataCollectionRules/<this>/streams/Microsoft-OTLP-Logs/otlp/v1/logs).')
output dcrImmutableId string = dataCollectionRule.properties.immutableId

@description('DCR name.')
output dcrName string = dataCollectionRule.name
