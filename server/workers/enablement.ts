/*
 * worker-enablement — the admin-owned on/off switch for scheduled workers.
 *
 * Activation used to be an infra decision: the only way to stop a misbehaving
 * scheduled worker was to edit worker-jobs.bicep and redeploy. That is slow, it
 * needs someone with deploy rights, and it means a worker whose real-world
 * behaviour is unproven can only be evaluated by shipping it hot. This makes it a
 * runtime, audited, product-surface decision instead.
 *
 * CONTRACT (mig 0090): an ABSENT row means ENABLED. That is the inverse of a
 * feature flag and it is deliberate — on upgrade every existing worker behaves
 * exactly as before, a dropped table degrades to "everything runs" rather than an
 * outage, and turning something OFF is always an explicit attributable act.
 *
 * The cron still fires for a disabled worker; dispatchWorker short-circuits and
 * records a SKIPPED worker_run, so the ledger shows why nothing happened. A silent
 * gap would be indistinguishable from the never-scheduled trap this epic closed.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'

type AnyDb = PostgresJsDatabase<typeof schema> | PostgresJsDatabase<Record<string, unknown>>

export interface WorkerEnablement {
  workerName: string
  enabled: boolean
  reason: string | null
  updatedBy: string | null
  updatedAt: string | null
}

/**
 * Is this worker allowed to run? Absent row ⇒ true (see the contract above).
 *
 * FAIL-OPEN on error: if the lookup itself fails (table missing mid-migration, a
 * transient DB blip), we let the worker RUN. A check whose failure silently stops
 * the fleet would be a worse outage than the one it guards against — and "worker
 * quietly stopped running" is precisely the failure class this codebase keeps
 * getting burned by.
 */
export async function isWorkerEnabled(db: AnyDb, workerName: string): Promise<boolean> {
  try {
    const rows = await db.execute<{ enabled: boolean }>(sql`
      SELECT enabled FROM worker_enablement WHERE worker_name = ${workerName} LIMIT 1
    `)
    const row = [...rows][0]
    return row ? row.enabled === true : true
  } catch {
    return true
  }
}

/** Every explicit enablement row (absent workers are enabled and simply not listed). */
export async function listWorkerEnablement(db: AnyDb): Promise<WorkerEnablement[]> {
  const rows = await db.execute<{
    worker_name: string
    enabled: boolean
    reason: string | null
    updated_by: string | null
    updated_at: string | null
  }>(sql`
    SELECT worker_name, enabled, reason, updated_by::text AS updated_by, updated_at::text AS updated_at
      FROM worker_enablement
     ORDER BY worker_name
  `)
  return [...rows].map((r) => ({
    workerName: r.worker_name,
    enabled: r.enabled,
    reason: r.reason,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  }))
}

/**
 * Set a worker's enablement. Upsert keyed on worker_name, stamping who and when.
 * Re-enabling clears the reason (it described why it was OFF).
 */
export async function setWorkerEnabled(
  db: AnyDb,
  opts: { workerName: string; enabled: boolean; reason?: string | null; updatedBy: string },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO worker_enablement (worker_name, enabled, reason, updated_by, updated_at)
    VALUES (
      ${opts.workerName},
      ${opts.enabled},
      ${opts.enabled ? null : (opts.reason ?? null)},
      ${opts.updatedBy}::uuid,
      now()
    )
    ON CONFLICT (worker_name) DO UPDATE SET
      enabled    = EXCLUDED.enabled,
      reason     = EXCLUDED.reason,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at
  `)
}
