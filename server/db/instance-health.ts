/*
 * Instance emit-health signals (instance_attestation_health).
 *
 * `bearer-auth-failed` is the DISASTER signal ADR-0005 decision 4 is actually
 * about: a live instance's durable OAuth emit credential was REJECTED at
 * /bearer (expired / revoked / invalid), so the OTLP exporter silently stopped
 * — while the dev is still trying to use it. Unlike "telemetry went quiet"
 * (indistinguishable from idle), a 401 at /bearer is unambiguous: the credential
 * failed. The went-silent worker alerts on THIS, not on mere absence.
 *
 * Lifecycle: an unresolved (resolved_at IS NULL) row = the credential is
 * currently failing. A successful /bearer mint resolves it (the credential works
 * again). One open row per instance per failure episode.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type AnyDb = PostgresJsDatabase<Record<string, unknown>>

export const BEARER_AUTH_FAILED = 'bearer-auth-failed'

/**
 * Record that this instance's emit credential was rejected at /bearer. Idempotent
 * per failure episode: at most one open row per instance. The INSERT … WHERE NOT
 * EXISTS alone was NOT atomic under concurrency (two transactions both pass NOT
 * EXISTS and both insert — CORE-5); the partial UNIQUE index (migration 0043)
 * plus ON CONFLICT DO NOTHING makes the race a clean no-op.
 */
export async function recordBearerAuthFailed(db: AnyDb, instanceId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO instance_attestation_health (instance_id, status, payload)
    SELECT ${instanceId}::uuid, ${BEARER_AUTH_FAILED}, '{"detectedBy":"bearer-endpoint"}'::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM instance_attestation_health
        WHERE instance_id = ${instanceId}::uuid
          AND status = ${BEARER_AUTH_FAILED}
          AND resolved_at IS NULL
     )
    ON CONFLICT DO NOTHING
  `)
}

/**
 * The credential works again (a /bearer mint succeeded) — resolve any open
 * bearer-auth-failed signal for this instance. Cheap no-op when none is open.
 */
export async function resolveBearerAuthFailed(db: AnyDb, instanceId: string): Promise<void> {
  await db.execute(sql`
    UPDATE instance_attestation_health
       SET resolved_at = now()
     WHERE instance_id = ${instanceId}::uuid
       AND status = ${BEARER_AUTH_FAILED}
       AND resolved_at IS NULL
  `)
}
