/*
 * governance-key-backfill — bounded, resumable worker resolving
 * (provider_org_id, provider_enterprise_id) on historical actual_spend /
 * reconciliation_record / pending_placement rows the ingest-time writers
 * could not stamp (predates this PR's writer changes, or the org/enterprise
 * was not yet registered at write time). Design §8.4: "Governance-key and
 * dimension-snapshot backfills operate in fixed-size batches, expose progress
 * in worker_run, and leave unresolvable rows in explicit operator buckets.
 * Creating or linking an org triggers a targeted re-sweep; exception buckets
 * are states to resolve, not permanent sinks."
 *
 * TWO ENTRY POINTS:
 *   - runGovernanceKeyBackfill — the registered worker (cron/HMAC-only, like
 *     reconciliation-backfill and other money-adjacent workers — NOT in
 *     UI_TRIGGERABLE_WORKER_NAMES). Sweeps rows with governance_key_status
 *     IS NULL (never attempted) in bounded batches; parks a row it truly
 *     cannot resolve as 'unresolved' so it is not rescanned every run.
 *   - resweepProviderOrgReferences — a TARGETED resweep scoped to one
 *     newly-created/linked provider_org's external id, called INLINE (not via
 *     the worker) by the org create/patch admin endpoints, so linking an org
 *     immediately un-parks any matching previously-unresolved rows rather than
 *     waiting for the next cron tick.
 *
 * Both share the SAME per-table resolution SQL (a deterministic join against
 * the source-string convention — server/reconciliation/source-org-ref.ts) so
 * the "how do we resolve a historical row" logic exists in exactly one place.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { ANTHROPIC_SOURCE_PREFIX, GITHUB_SEAT_SOURCE_PREFIX } from '../reconciliation/source-org-ref'

type Db = PostgresJsDatabase<typeof schema>
type SqlRunner = Pick<Db, 'execute'>

export const GOVERNANCE_KEY_BACKFILL_BATCH = 2000

export interface GovernanceKeyBackfillResult extends Record<string, unknown> {
  actualSpend: { resolved: number; parkedUnresolved: number }
  reconciliationRecord: { resolved: number; parkedUnresolved: number }
  pendingPlacement: { resolved: number }
  hasMore: boolean
}

/**
 * One bounded pass over all three tables' `governance_key_status IS NULL`
 * backlog. A row this pass cannot resolve is stamped 'unresolved' (parked —
 * skipped by future sweeps until an explicit recheck, never rescanned
 * forever). Resumable: the next call naturally continues because resolved AND
 * parked rows both drop out of the `IS NULL` filter.
 */
export async function runGovernanceKeyBackfill(
  db: SqlRunner,
  opts?: { batchSize?: number },
): Promise<GovernanceKeyBackfillResult> {
  const limit = opts?.batchSize ?? GOVERNANCE_KEY_BACKFILL_BATCH

  // ONE fixed candidate batch per table, selected ONCE — every subsequent
  // statement in this call operates on exactly this set. Re-selecting
  // `IS NULL ORDER BY id LIMIT` after the resolve pass would pick up a
  // DIFFERENT window (rows the resolve pass never attempted, because they
  // fell outside its batch) and wrongly park them as unresolved before they
  // ever got a chance to resolve on a later call — the exact bug a bounded/
  // resumable sweep must not have.
  const actualSpendCandidates = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM actual_spend WHERE governance_key_status IS NULL ORDER BY id LIMIT ${limit}
  `)
  const actualSpendCandidateIds = actualSpendCandidates.map((r) => r.id)

  let actualSpendResolved: { id: string }[] = []
  let actualSpendParked: { id: string }[] = []
  if (actualSpendCandidateIds.length > 0) {
    const idList = sql.join(actualSpendCandidateIds.map((id) => sql`${id}::uuid`), sql`, `)
    actualSpendResolved = await db.execute<{ id: string }>(sql`
      UPDATE actual_spend a
      SET provider_org_id = po.id, provider_enterprise_id = po.provider_enterprise_id, governance_key_status = 'resolved'
      FROM provider_org po
      WHERE a.id IN (${idList})
        AND (
          (po.provider = 'anthropic' AND a.source LIKE ${ANTHROPIC_SOURCE_PREFIX + ':%'}
            AND lower(po.external_org_id) = lower(split_part(a.source, ':', 2)))
          OR
          (po.provider = 'github' AND a.source LIKE ${GITHUB_SEAT_SOURCE_PREFIX + ':%'}
            AND a.source <> ${GITHUB_SEAT_SOURCE_PREFIX + ':unknown'}
            AND lower(po.external_org_id) = lower(split_part(a.source, ':', 2)))
        )
      RETURNING a.id::text AS id
    `)
    // Park only whatever from THIS SAME candidate set is still unresolved —
    // never a fresh scan (see the comment above).
    actualSpendParked = await db.execute<{ id: string }>(sql`
      UPDATE actual_spend
      SET governance_key_status = 'unresolved'
      WHERE id IN (${idList}) AND governance_key_status IS NULL
      RETURNING id::text AS id
    `)
  }

  const reconRecordCandidates = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM reconciliation_record WHERE governance_key_status IS NULL ORDER BY id LIMIT ${limit}
  `)
  const reconRecordCandidateIds = reconRecordCandidates.map((r) => r.id)

  let reconRecordResolvedCount = 0
  let reconRecordParked: { id: string }[] = []
  if (reconRecordCandidateIds.length > 0) {
    const reconIdList = sql.join(reconRecordCandidateIds.map((id) => sql`${id}::uuid`), sql`, `)
    const reconRecordEnterpriseResolved = await db.execute<{ id: string }>(sql`
      UPDATE reconciliation_record r
      SET provider_enterprise_id = pe.id
      FROM provider_enterprise pe
      WHERE r.id IN (${reconIdList})
        AND pe.provider = 'github' AND r.provider = 'github' AND lower(pe.external_id) = lower(r.enterprise_ref)
      RETURNING r.id::text AS id
    `)
    await db.execute(sql`
      UPDATE reconciliation_record r
      SET provider_org_id = po.id
      FROM provider_org po
      WHERE r.id IN (${reconIdList})
        AND r.provider = 'github' AND r.provider_enterprise_id IS NOT NULL AND r.provider_org_id IS NULL
        AND r.license_org IS NOT NULL AND po.provider_enterprise_id = r.provider_enterprise_id
        AND (lower(po.external_org_id) = lower(r.license_org) OR lower(po.display_name) = lower(r.license_org))
    `)
    const reconRecordOrgResolved = await db.execute<{ id: string }>(sql`
      UPDATE reconciliation_record r
      SET provider_org_id = po.id, governance_key_status = 'resolved'
      FROM provider_org po
      WHERE r.id IN (${reconIdList})
        AND po.provider = 'anthropic' AND r.provider = 'anthropic' AND lower(po.external_org_id) = lower(r.enterprise_ref)
      RETURNING r.id::text AS id
    `)
    const reconRecordGithubMarked = await db.execute<{ id: string }>(sql`
      UPDATE reconciliation_record
      SET governance_key_status = 'resolved'
      WHERE id IN (${reconIdList}) AND provider = 'github' AND provider_enterprise_id IS NOT NULL
      RETURNING id::text AS id
    `)
    reconRecordResolvedCount = reconRecordEnterpriseResolved.length + reconRecordOrgResolved.length + reconRecordGithubMarked.length
    reconRecordParked = await db.execute<{ id: string }>(sql`
      UPDATE reconciliation_record
      SET governance_key_status = 'unresolved'
      WHERE id IN (${reconIdList}) AND governance_key_status IS NULL
      RETURNING id::text AS id
    `)
  }

  // pending_placement has no governance_key_status column (it is a small,
  // transient queue drained by placement-sync — see mig 0103's comment); a
  // best-effort resolve on the still-unplaced rows is enough, no parking needed.
  const pendingPlacementResolved = await db.execute<{ id: string }>(sql`
    UPDATE pending_placement p
    SET provider_org_id = po.id, provider_enterprise_id = po.provider_enterprise_id
    FROM provider_org po
    WHERE p.placed_at IS NULL AND p.provider_org_id IS NULL
      AND (
        (po.provider = 'anthropic' AND p.provider = 'anthropic' AND lower(po.external_org_id) = lower(split_part(p.actual_source, ':', 2)))
        OR
        (po.provider = 'github' AND p.provider = 'github' AND lower(po.external_org_id) = lower(split_part(p.actual_source, ':', 2)))
      )
    RETURNING p.id::text AS id
  `)

  return {
    actualSpend: { resolved: actualSpendResolved.length, parkedUnresolved: actualSpendParked.length },
    reconciliationRecord: {
      resolved: reconRecordResolvedCount,
      parkedUnresolved: reconRecordParked.length,
    },
    pendingPlacement: { resolved: pendingPlacementResolved.length },
    hasMore: actualSpendCandidateIds.length === limit || reconRecordCandidateIds.length === limit,
  }
}

/**
 * Targeted resweep for ONE newly-created/linked provider_org — un-parks any
 * 'unresolved' rows whose source string matches this org, so linking an org
 * takes effect immediately rather than waiting for the next cron tick.
 * Bounded (single org's backlog is realistically small); safe to call inline
 * from an admin request.
 */
export async function resweepProviderOrgReferences(
  db: SqlRunner,
  args: { providerOrgId: string; provider: 'anthropic' | 'github'; externalOrgId: string; providerEnterpriseId: string | null },
): Promise<{ actualSpendResolved: number; reconciliationRecordResolved: number }> {
  const sourcePrefix = args.provider === 'anthropic' ? ANTHROPIC_SOURCE_PREFIX : GITHUB_SEAT_SOURCE_PREFIX
  const actualSpendResolved = await db.execute<{ id: string }>(sql`
    UPDATE actual_spend
    SET provider_org_id = ${args.providerOrgId}::uuid, provider_enterprise_id = ${args.providerEnterpriseId}::uuid,
        governance_key_status = 'resolved'
    WHERE governance_key_status IS DISTINCT FROM 'resolved'
      AND source = ${sourcePrefix + ':' + args.externalOrgId.toLowerCase()}
    RETURNING id::text AS id
  `)
  const reconciliationRecordResolved = await db.execute<{ id: string }>(sql`
    UPDATE reconciliation_record
    SET provider_org_id = ${args.providerOrgId}::uuid,
        provider_enterprise_id = COALESCE(provider_enterprise_id, ${args.providerEnterpriseId}::uuid),
        governance_key_status = 'resolved'
    WHERE provider = ${args.provider} AND governance_key_status IS DISTINCT FROM 'resolved'
      AND (
        (provider = 'anthropic' AND lower(enterprise_ref) = lower(${args.externalOrgId}))
        OR (provider = 'github' AND lower(license_org) = lower(${args.externalOrgId}))
      )
    RETURNING id::text AS id
  `)
  return { actualSpendResolved: actualSpendResolved.length, reconciliationRecordResolved: reconciliationRecordResolved.length }
}

/**
 * Targeted resweep for a newly-linked/created provider_enterprise (github) —
 * un-parks reconciliation_record rows keyed by its enterprise_ref slug.
 */
export async function resweepProviderEnterpriseReferences(
  db: SqlRunner,
  args: { providerEnterpriseId: string; externalId: string },
): Promise<{ reconciliationRecordResolved: number }> {
  const reconciliationRecordResolved = await db.execute<{ id: string }>(sql`
    UPDATE reconciliation_record
    SET provider_enterprise_id = ${args.providerEnterpriseId}::uuid,
        governance_key_status = 'resolved'
    WHERE provider = 'github' AND governance_key_status IS DISTINCT FROM 'resolved'
      AND lower(enterprise_ref) = lower(${args.externalId})
    RETURNING id::text AS id
  `)
  return { reconciliationRecordResolved: reconciliationRecordResolved.length }
}
