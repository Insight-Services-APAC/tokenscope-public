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

@description('Log Analytics workspace the app logs to. Empty disables the security-audit log alert (phase-1 applies before monitoring exists).')
param logAnalyticsId string = ''

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
// scheduled runs in every trailing hour. `Executions` / Microsoft.App/jobs:
// Count, PT1M grain, Total aggregation, dimension `state` = 'Succeeded' (the
// ARM JobExecution status enum). The dimension value AND the no-executions
// behaviour (the filtered series evaluates as 0, not no-data, so total
// dispatch silence fires too) were confirmed live on Dev 2026-08-20 —
// docs/design/ops-alerting.md §Validation plan.
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

// 4. Security-audit write failure — a LOG alert, not a metric one.
//
// `[SECURITY-AUDIT-WRITE-FAILED]` is emitted by the two paths that record a
// REFUSAL and then continue: report-scope's deny-audit, whose own comment calls
// it "the only record of a denied privilege-escalation attempt", and the
// named-person drill audit. The marker was described as something ops must be
// able to alert on, and a repo-wide grep found two emitters, one test asserting
// the STRING is present, and nothing consuming it (MDASH §3.1).
//
// WHY A LOG ALERT AND NOT A COUNTER IN OUR OWN DB: the marker fires when a
// DATABASE WRITE FAILED. Recording "the audit write failed" in the same database
// is unreliable in exactly the case that matters, so the signal has to leave the
// process by the path that does not depend on Postgres — the log pipeline.
//
// The known trigger (a client-supplied X-Forwarded-For that Postgres `inet`
// rejects) is fixed separately by validating the address with net.isIP, so this
// is defence in depth for the causes that remain: the database being down,
// permissions, a schema drift.
//
// NOT YET VALIDATED ON DEV, and the FIRST version of this rule is why that
// matters: it queried AppTraces, a table nothing in this deployment writes, so
// it would have deployed successfully and never fired. Like the dead-man rule
// above, this needs one post-deploy assertion — emit the marker on Dev, confirm
// the query returns the row and the rule evaluates — before it is trusted.
// Gated on the WORKSPACE only. Gating on actionGroupId as well would delete the
// rule whenever no notification email is configured, which contradicts this
// module's contract that alerts still EXIST in Azure Monitor without email — the
// other rules here follow that, and a rule you can see in the portal is worth
// having even when nothing is paged.
resource securityAuditWriteAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (!empty(logAnalyticsId)) {
  name: 'alert-security-audit-write-${name}'
  location: resourceGroup().location
  tags: tags
  properties: {
    displayName: 'Security audit write failed (${name})'
    description: 'A security-critical audit row could not be written; the action it recorded still happened.'
    severity: 1
    enabled: true
    scopes: [logAnalyticsId]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    // Deploy-time KQL validation resolves table references BEFORE `isfuzzy` gets
    // runtime semantics, and a freshly created workspace has materialised
    // neither console table — so validating this rule can fail the whole infra
    // deployment. Validation would not have caught either way this rule has
    // already been wrong (a table nothing writes; a term-based operator on a
    // punctuated marker), so the post-deploy assertion in
    // epic-mdash-remediation.md §3b is what settles whether it matches.
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          // NOT AppTraces. That table is populated by the Application Insights
          // Node SDK, which this app does not depend on or initialise — the
          // Container App ships stdout/stderr straight to Log Analytics
          // (container-app.bicep appLogsConfiguration destination: 'log-analytics'),
          // and consola writes there. Querying AppTraces would have deployed a
          // rule that reads an empty table forever: present, green, and mute.
          //
          // `contains`, NOT `has`. KQL's `has` matches whole TERMS, and this
          // marker is punctuated — the brackets and hyphens split it, so `has`
          // would not reliably match the literal inside a log line. That would
          // have been the SECOND way this rule could deploy green and stay mute.
          //
          // union isfuzzy=true because the console table has two schemas across
          // Azure generations (ContainerAppConsoleLogs_CL with Log_s, and
          // ContainerAppConsoleLogs with Log) and the workspace is behind AMPLS,
          // so which one this environment uses cannot be read from here. isfuzzy
          // tolerates the absent table instead of failing the whole query — and
          // the post-deploy assertion below is what settles which one is live.
          //
          // The empty datatable leg is NOT decoration. isfuzzy tolerates a
          // missing source only while at least one still RESOLVES; on a freshly
          // deployed workspace neither console table has been materialised yet,
          // and the query errors rather than returning zero rows — an alert rule
          // that errors is not an alert rule that is quiet. The literal leg
          // always resolves, so the first evaluation is a clean zero. Both real
          // legs project to one common column so the union has a single schema.
          query: 'union isfuzzy=true (datatable(Msg: string)[]), (ContainerAppConsoleLogs_CL | where Log_s contains "[SECURITY-AUDIT-WRITE-FAILED]" | project Msg = Log_s), (ContainerAppConsoleLogs | where Log contains "[SECURITY-AUDIT-WRITE-FAILED]" | project Msg = Log)'
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: 1
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: empty(actionGroupId) ? [] : [actionGroupId]
    }
  }
}
