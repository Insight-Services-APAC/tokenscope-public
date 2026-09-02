// ── Ops alerting — A4 platform metric alerts (docs/design/ops-alerting.md §A4) ──
//
// The watchman problem, three Azure-native legs: these alerts evaluate INSIDE
// Azure Monitor — no app, AMPLS or LA-query dependency — so they still page
// when the app-side alerting path (the ops-alert worker, §A2/§A3) is itself
// what died.
//
// WHY THIS IS ITS OWN LATE MODULE and not part of monitoring.bicep: monitoring
// is a PRODUCER for postgresql and container-app (logAnalyticsId /
// appInsightsConnectionString), so an alert rule in monitoring.bicep scoping
// those resources would need monitoring to consume its own consumers' outputs
// — a cycle the main.bicep deployment graph ("every consumer comes after its
// producer, no cycles") forbids. This module is the graph's last consumer: it
// takes the ACTION GROUP from monitoring (ar-M19 — reuse the existing group +
// notificationEmail wiring, never a second group) and the target resource ids
// from their producing modules. Alert-rule shape mirrors monitoring.bicep's
// existing rules (metricAlerts@2018-03-01, location global, static criteria).
//
// SCOPING NOTE: each rule is single-scope, so the metric-alert regional
// constraint (multi-resource rules must share region + subscription) does not
// bite; all targets live in this resource group anyway. `location` is
// 'global' for metric alerts regardless of target region.

@description('Resource name suffix (e.g. tokenscope-dev-wus3).')
param name string

@description('Action group resource ID from monitoring.outputs.actionGroupId. Empty = alerts fire (visible in Monitor) but no email goes out — the same contract as monitoring.bicep\'s own rules.')
param actionGroupId string = ''

@description('Container App resource ID (containerApp.outputs.appId) — scope of the Replicas alert (ar-H7).')
param containerAppId string

@description('PostgreSQL flexible server resource ID (postgresql.outputs.serverId) — scope of the is_db_alive alert (ar-H3).')
param postgresServerId string

@description('Resource ID of the caj-ts-ops-alert Container Apps Job — scope of the dead-man alert (ar-H4). Empty = the job is not deployed (phase-1 / workerBaseUrl unset) and the dead-man rule is elided: a metric alert cannot scope a resource that does not exist.')
param opsAlertJobId string = ''

@description('Tags applied to every resource in this module.')
param tags object = {}

// Same shape as monitoring.bicep: empty action group = alert without email.
var actionGroups = empty(actionGroupId) ? [] : [
  { actionGroupId: actionGroupId }
]

// Severity 1 ("Error"), ABOVE monitoring.bicep's Sev-2 page floor: all three
// legs mean the product — or its watchman — is DOWN, not merely erroring.

// 1. App down — Container App Replicas < 1 for 15 min (ar-H7).
// `Replicas` / Microsoft.App/containerapps verified against the Azure Monitor
// supported-metrics reference ("Replica Count", Count, PT1M grain, Maximum
// aggregation supported). ar-H7's reasoning: requests/failed needs TRAFFIC to
// fire; container-app.bicep pins minReplicas: 1, which makes this gauge an
// invariant. Maximum < 1 over the window = zero replicas existed at EVERY
// minute of the 15 — an app that is down, not one that is scaling.
resource appReplicasAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-app-replicas-${name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Container App replica count below 1 for 15 minutes — the app is DOWN (ops-alerting.md ar-H7; minReplicas=1 makes Replicas>=1 an invariant).'
    severity: 1
    enabled: true
    scopes: [ containerAppId ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'AppReplicasDown'
          metricName: 'Replicas'
          metricNamespace: 'Microsoft.App/containerapps'
          operator: 'LessThan'
          threshold: 1
          timeAggregation: 'Maximum'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: actionGroups
  }
}

// 2. Database down — PG flexible server is_db_alive < 1 (ar-H3: a PG outage
// silences the ENTIRE app-side alerting path, state machine included).
// `is_db_alive` / Microsoft.DBforPostgreSQL/flexibleServers verified against
// the supported-metrics reference ("Database Is Alive — indicates if the
// database is up or not", Count 0/1, PT1M grain, Maximum aggregation).
// WINDOW DEVIATION, stated: the design says 10 min, but metric-alert
// windowSize only allows PT1M/PT5M/PT15M/PT30M/PT1H/PT6H/PT12H/P1D — PT10M
// does not exist. PT15M is the nearest expressible window that never pages
// inside the 10-minute tolerance the design chose (an HA failover or
// maintenance restart the 10-min figure exists to damp), and it matches the
// design's stated one-cadence (≤15 min) detection SLA. Maximum < 1 over PT15M
// = the platform's own availability probe reported dead for the entire window.
resource pgAliveAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-pg-alive-${name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'PostgreSQL flexible server is_db_alive below 1 for 15 minutes — the database is DOWN and every app-side alert path is silenced with it (ops-alerting.md ar-H3; 15 min is the nearest expressible window to the design\'s 10 — PT10M is not a valid metric-alert windowSize).'
    severity: 1
    enabled: true
    scopes: [ postgresServerId ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'DatabaseNotAlive'
          metricName: 'is_db_alive'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          operator: 'LessThan'
          threshold: 1
          timeAggregation: 'Maximum'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: actionGroups
  }
}

// 3. Evaluator dead-man — successful caj-ts-ops-alert executions < 1 over 1 h
// (ar-H4: a bug that throws every run, or a dispatch wedge, pages even though
// ops-alert itself cannot). The job's cron (9,24,39,54 — ar-L22) puts 4
// scheduled runs in every trailing hour, so a healthy hour totals 4.
// `Executions` / Microsoft.App/jobs verified against the supported-metrics
// reference ("Job Executions — executions run by the Container Apps Job",
// Count, PT1M grain, Total aggregation, dimensions state/jobName/
// executionName). WHAT FIRES IT: Total(Executions, state=Succeeded) < 1 over
// the trailing hour. 'Succeeded' is the ARM JobExecution status enum spelling
// (Degraded/Failed/Processing/Running/Stopped/Succeeded/Unknown) — the
// dimension's values are not enumerated in the metrics reference, so the
// post-deploy Dev assertion in the design's validation plan (observe one
// fired probe / inspect the metric in the portal) MUST confirm the value
// before this leg is trusted. KNOWN RESIDUAL, stated rather than papered
// over: an hour with NO executions AT ALL (the dispatch-wedge case) only
// evaluates if the platform gap-fills the filtered series with zeros; if it
// reports no-data instead, this alert covers the throws-every-run case but
// not total dispatch silence. The same live Dev assertion settles which —
// and if it comes back no-data, the honest fix is dropping the state filter
// (any-execution dead-man) plus the worker-fleet predicate for failures.
resource opsAlertDeadmanAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (!empty(opsAlertJobId)) {
  name: 'alert-ops-alert-deadman-${name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'caj-ts-ops-alert had no successful execution in the trailing hour (4 expected) — the watchman is dead: whatever it would have paged about is going unreported (ops-alerting.md ar-H4).'
    severity: 1
    enabled: true
    scopes: [ opsAlertJobId ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'OpsAlertJobSilent'
          metricName: 'Executions'
          metricNamespace: 'Microsoft.App/jobs'
          operator: 'LessThan'
          threshold: 1
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'state'
              operator: 'Include'
              values: [ 'Succeeded' ]
            }
          ]
        }
      ]
    }
    actions: actionGroups
  }
}
