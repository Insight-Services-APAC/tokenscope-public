// Scheduled worker jobs (Container Apps Jobs, Schedule trigger).
//
// Each job runs `node scripts/cron-trigger.mjs` with WORKER_NAME=<key>, which
// calls the internal /api/v1/internal/run-worker/<name> endpoint (HMAC-authed)
// on the web app. The worker keys + intended cadence are the source of truth in
// server/workers/registry.ts (recommendedCron); this module materialises the
// subset that should run on the deployed env.
//
// History: the original 6 jobs were created ad-hoc via `az` (outside IaC). This
// module captures them PLUS the two ADR-0005 observability workers
// (went-silent, reconciliation-gap), so the cron surface is finally codified.
// On a sandbox with no GitHub deploy workflow, mirror with `az containerapp job
// create` (see the deploy runbook).
//
// RECONCILE BEFORE A FULL APPLY — NOT a safe no-op for the existing six.
// A full `az deployment group` apply CONVERGES the 6 ad-hoc-created jobs to the
// values DECLARED here (cron, replicaTimeout: 240, retry limit, resources, env).
// If a live job's config drifted from these declarations (e.g. someone bumped a
// live `replicaTimeout` away from 240), the apply OVERWRITES it back to the
// declared value — it does not no-op. So either reconcile the live jobs to match
// this module first, or scope the first apply to ONLY the two new jobs
// (went-silent, reconciliation-gap) and leave the six untouched until their live
// config is confirmed to match.
//
// NOT every registered worker is scheduled on this env (intentional). The
// registry (server/workers/registry.ts) also defines a `recommendedCron` for
// three workers that are DELIBERATELY left unscheduled here:
//   - velocity-watch     (weekly per-teammate velocity report)
//   - connector-health   (sync-conflict emission)
//   - budget-alert       (over-budget inbox items)
// They are omitted on purpose for this env, not by oversight; add them to the
// `workers` array below if/when they should run scheduled. The list is therefore
// the SCHEDULED subset, not the complete registry.

@description('Resource group location.')
param location string = resourceGroup().location

@description('Container Apps managed environment resource id (containerApp.outputs.environmentId).')
param environmentId string

@description('User-assigned managed identity resource id (registry pull + KV secret access).')
param userAssignedIdentityId string

@description('ACR login server, e.g. crtokenscopesandboxaue.azurecr.io')
param acrLoginServer string

@description('Container image (registry/repo:tag) — same image as the web app.')
param image string

@description('Public base URL the worker calls (Front Door host, NOT the CA FQDN).')
param tokenscopeBaseUrl string

@description('Key Vault URL of the internal-worker HMAC key secret.')
param internalWorkerHmacKeyVaultUrl string

// name = the registry worker key (WORKER_NAME); cron = registry recommendedCron.
var workers = [
  { name: 'analytics-poll', cron: '*/15 * * * *' }
  { name: 'azure-monitor-read', cron: '*/5 * * * *' }
  { name: 'mitigation-query', cron: '*/30 * * * *' }
  { name: 'reconciliation', cron: '0 */1 * * *' }
  { name: 'session-gc', cron: '0 2 * * *' }
  { name: 'soft-purge', cron: '0 3 * * *' }
  // ADR-0005 §4 observability safety nets (the two new jobs):
  { name: 'went-silent', cron: '0 */1 * * *' }
  { name: 'reconciliation-gap', cron: '0 */6 * * *' }
  // Reconciliation engine (Phase 0 foundation). Clean no-op until adapters register
  // (no reconciled provider scope / no resolver) — safe to schedule now.
  { name: 'reconciliation-sync', cron: '0 */1 * * *' }
  { name: 'identity-sync', cron: '0 3 * * *' }
  // §A usage completeness: per-(teammate, day) API-vs-OTel reconciliation (unaccounted +
  // over-emission). See docs/design/provider-billing-attribution-model.md §A.
  { name: 'usage-reconciliation', cron: '0 */2 * * *' }
  // On-demand backfill queue (mig 0074): drain admin-requested historical pulls, one per tick.
  { name: 'reconciliation-backfill', cron: '*/15 * * * *' }
  // Reporting-consolidation Wave 0: read the enterprise billing usage report → write the POOLED
  // Copilot chargeback (copilot_pool_bill), homed org→CoU. A reader, not a calculator
  // (provider-billing-attribution-model.md §B). Month-grain + slow-settling → daily. WITHOUT
  // this scheduled, the Copilot chargeback lane is empty and the Finance Σ=bill check has no
  // Copilot term (the silent-no-op trap).
  { name: 'copilot-pool-bill', cron: '0 5 * * *' }
  // Consumption-dashboard read path (night sprint): materialises
  // attribution_aggregate; self-bootstraps a 90-day backfill on first run.
  { name: 'aggregate-rollup', cron: '*/15 * * * *' }
  // Read-path outage detector (ADR-0005 safety-net sibling of went-silent):
  // scans the worker_run ledger and inbox-alerts platform-admins when the
  // azure-monitor-read gatherer is silently failing (rows not landing while
  // emissions still arrive). went-silent catches emit/WRITE silence; this
  // catches READ-path failure — the gap behind the 2026-06 ~5.5-day outage.
  { name: 'read-path-health', cron: '*/15 * * * *' }
  // Bill-driven placement pipeline (ADR-0010 rule 1 — "a user in a provider bill is
  // provisioned, not skipped"). analytics-poll ENQUEUES owed bills for provider-billed
  // users who have no teammate yet → placement-sync DRAINS pending_placement, mints
  // source='bill' teammates (provisionAndPlace; falls back to __unassigned__ if directory
  // is unwired) + replays into actual_spend → region-reenrichment homes them by
  // directory/cost-centre → pending-placement-gc prunes the drained queue. WITHOUT
  // placement-sync scheduled, the queue never drains, NO bill teammates are minted, and
  // reconciliation-sync records ONLY pre-existing teammates (the Dev "only Phil" defect).
  { name: 'placement-sync', cron: '*/30 * * * *' }
  { name: 'region-reenrichment', cron: '0 */6 * * *' }
  { name: 'pending-placement-gc', cron: '0 4 * * *' }
]

resource jobs 'Microsoft.App/jobs@2024-03-01' = [
  for w in workers: {
    name: 'caj-ts-${w.name}'
    location: location
    identity: {
      type: 'UserAssigned'
      userAssignedIdentities: {
        '${userAssignedIdentityId}': {}
      }
    }
    properties: {
      environmentId: environmentId
      configuration: {
        triggerType: 'Schedule'
        replicaTimeout: 240
        replicaRetryLimit: 1
        scheduleTriggerConfig: {
          cronExpression: w.cron
          parallelism: 1
          replicaCompletionCount: 1
        }
        registries: [
          {
            server: acrLoginServer
            identity: userAssignedIdentityId
          }
        ]
        secrets: [
          {
            name: 'internal-worker-hmac-key'
            keyVaultUrl: internalWorkerHmacKeyVaultUrl
            identity: userAssignedIdentityId
          }
        ]
      }
      template: {
        containers: [
          {
            name: 'worker'
            image: image
            command: [ 'node' ]
            args: [ 'scripts/cron-trigger.mjs' ]
            resources: {
              cpu: json('0.25')
              memory: '0.5Gi'
            }
            env: [
              { name: 'WORKER_NAME', value: w.name }
              { name: 'TOKENSCOPE_BASE_URL', value: tokenscopeBaseUrl }
              { name: 'NUXT_INTERNAL_WORKER_HMAC_KEY', secretRef: 'internal-worker-hmac-key' }
            ]
          }
        ]
      }
    }
  }
]
