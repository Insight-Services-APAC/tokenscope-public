import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from '../notifications/dispatch'
import type { CoverageState } from './coverage'
// The title and the drawer body share one wording (#587).
import { coverageOrgGapSubject } from '../../shared/inbox/coverage-states'
import type { PersistedEnterpriseCoverage } from './coverage-store'
import type { CoverageEnterpriseRow, EnterpriseCoverageResult } from './github-coverage'

type Db = PostgresJsDatabase<typeof schema>

const CATEGORY = 'github-coverage-gap' as const

export interface CoverageTransitionResult {
  nonConnectedOrgs: number
  newAlerts: number
  autoResolved: number
}

async function autoResolveOrgAlert(db: Db, enterpriseId: string, org: string, nowIso: string): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE inbox_item
       SET ack_state = 'resolved', ack_at = ${nowIso}::timestamptz
     WHERE category = ${CATEGORY}
       AND related_entity_kind = 'provider-enterprise'
       AND related_entity_id = ${enterpriseId}::uuid
       AND ack_state IN ('unread', 'read', 'acknowledged')
       AND body ->> 'org' = ${org}
    RETURNING id::text AS id
  `)
  return rows.length
}

async function autoResolveCapabilityAlert(db: Db, enterpriseId: string, nowIso: string): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE inbox_item
       SET ack_state = 'resolved', ack_at = ${nowIso}::timestamptz
     WHERE category = ${CATEGORY}
       AND related_entity_kind = 'provider-enterprise'
       AND related_entity_id = ${enterpriseId}::uuid
       AND ack_state IN ('unread', 'read', 'acknowledged')
       AND body ->> 'kind' = 'capability-loss'
    RETURNING id::text AS id
  `)
  return rows.length
}

async function dispatchOrgGapAlert(
  db: Db,
  ent: CoverageEnterpriseRow,
  org: string,
  state: CoverageState,
  now: Date,
): Promise<number> {
  const dispatched = await dispatchInbox(db, {
    category: CATEGORY,
    severity: 'attention',
    subject: coverageOrgGapSubject(org, ent.externalId, state),
    body: {
      kind: 'org-gap',
      enterpriseId: ent.enterpriseId,
      enterpriseExternalId: ent.externalId,
      org,
      state,
      detectedAt: now.toISOString(),
      hint: 'Admin, Reconciliation, Providers, Coverage column: edit, discover, delete or recheck the organisation there.',
    },
    relatedEntityKind: 'provider-enterprise',
    relatedEntityId: ent.enterpriseId,
  })
  return dispatched.length > 0 ? 1 : 0
}

async function dispatchCapabilityLossAlert(
  db: Db,
  ent: CoverageEnterpriseRow,
  result: EnterpriseCoverageResult,
  now: Date,
): Promise<number> {
  const dispatched = await dispatchInbox(db, {
    category: CATEGORY,
    severity: 'urgent',
    subject: `GitHub enterprise-org coverage for '${ent.externalId}' can no longer be determined (${result.census.reason ?? 'unknown'})`,
    body: {
      kind: 'capability-loss',
      enterpriseId: ent.enterpriseId,
      enterpriseExternalId: ent.externalId,
      reason: result.census.reason,
      detectedAt: now.toISOString(),
      hint: 'Grant the reconciliation App "Enterprise organization installations: read", or check its App key, then Recheck from Admin, Reconciliation, Providers.',
    },
    relatedEntityKind: 'provider-enterprise',
    relatedEntityId: ent.enterpriseId,
  })
  return dispatched.length > 0 ? 1 : 0
}

/**
 * Apply prior-to-current coverage transitions to inbox alerts. Call this in
 * the same transaction as persistEnterpriseCoverage so a manual recheck cannot
 * overwrite the prior state and strand an alert that still needs resolving.
 */
export async function reconcileCoverageTransitions(
  db: Db,
  ent: CoverageEnterpriseRow,
  prior: PersistedEnterpriseCoverage,
  current: EnterpriseCoverageResult,
  now: Date,
): Promise<CoverageTransitionResult> {
  const priorStates = new Map(prior.orgs.map((o) => [o.org, o.lastObservedState]))
  const priorCensusAvailable = prior.census.available && !prior.census.stale
  const nowIso = now.toISOString()
  let nonConnectedOrgs = 0
  let newAlerts = 0
  let autoResolved = 0

  if (priorCensusAvailable && !current.census.available) {
    newAlerts += await dispatchCapabilityLossAlert(db, ent, current, now)
  } else if (!priorCensusAvailable && current.census.available) {
    autoResolved += await autoResolveCapabilityAlert(db, ent.enterpriseId, nowIso)
  }

  for (const org of current.orgs) {
    const priorState = priorStates.get(org.org)
    if (org.state !== 'connected') nonConnectedOrgs += 1
    if (org.state === 'connected') {
      if (priorState !== undefined && priorState !== 'connected') {
        autoResolved += await autoResolveOrgAlert(db, ent.enterpriseId, org.org, nowIso)
      }
    } else if (priorState !== org.state) {
      newAlerts += await dispatchOrgGapAlert(db, ent, org.org, org.state, now)
    }
  }

  return { nonConnectedOrgs, newAlerts, autoResolved }
}
