/*
 * Emit-on-install enroll orchestration (slice 3 — the no-login enroll path).
 *
 * docs/design/emit-on-install-provisional-attribution.md §Flows 1. The Insight
 * plugin is distributed privately; on install it calls POST /api/v1/setup/enroll
 * with a BUNDLED enrollment secret, a CLAIMED email, and a device-binding hint.
 * The distribution channel + the bundled secret ARE the gate — there is no login.
 *
 * This module is the server-side machinery the endpoint reuses:
 *
 *   - verifyEnrollmentSecret — hash the presented secret and accept iff it
 *     matches the env bootstrap secret OR a live, non-revoked enrollment_secret
 *     row. This is the ONLY externally-distinguishable outcome of the endpoint
 *     (a failure here is the endpoint's only 401).
 *   - locateOrCreateProvisionalInstance — locate-or-create a PROVISIONAL shadow
 *     teammate + a SERVER-CHOSEN instance_attestation, idempotent on the
 *     (claimed_email, device_binding) dedup hint. NEVER touches a real
 *     (provisional=false) teammate and NEVER looks one up by email (that would be
 *     an existence oracle + a laundering bridge — forbidden by the threat model).
 *
 * The durable emit credential itself is minted by the endpoint via
 * issueInstanceEmitCredentialTx(issueEmitCredential) — scope tokenscope.emit ONLY,
 * exactly the redeem path; this module never issues credentials or threads scope.
 */
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashSessionToken, constantTimeEqualHex } from './hmac'
import { REFRESH_TOKEN_TTL_MS } from './oauth'
import type { EmitTool } from './emit-provision'

type Db = PostgresJsDatabase<Record<string, unknown>>

/**
 * Global cap on provisional instance_attestation rows — a coarse DoS backstop on
 * the (gated but login-less) enroll endpoint, mirroring MAX_OAUTH_CLIENTS on the
 * unauthenticated /oauth/register. Generous: real enrolments number in the low
 * thousands. Env-overridable via MAX_PROVISIONAL_INSTANCES.
 */
export const DEFAULT_MAX_PROVISIONAL_INSTANCES = 100_000
/**
 * Per-claimed_email cap — bounds how many provisional instances any single
 * claimed identity can accrue (an insider can't fabricate unbounded shadow
 * devices against one coworker). Env-overridable via MAX_PROVISIONAL_INSTANCES_PER_EMAIL.
 */
export const DEFAULT_MAX_PROVISIONAL_INSTANCES_PER_EMAIL = 50

export function maxProvisionalInstances(): number {
  const raw = Number(process.env.MAX_PROVISIONAL_INSTANCES)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PROVISIONAL_INSTANCES
}
export function maxProvisionalInstancesPerEmail(): number {
  const raw = Number(process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PROVISIONAL_INSTANCES_PER_EMAIL
}

/**
 * Validate a presented bundled secret. Accept iff it matches the env bootstrap
 * secret OR a LIVE (now within [not_before, not_after), not revoked)
 * enrollment_secret row. Both comparisons are over the HMAC hash; the bootstrap
 * comparison is constant-time, and the table lookup is an indexed exact-hash
 * match. Returns false for everything else — the endpoint maps that to its only
 * 401, the sole externally-distinguishable outcome.
 */
export async function verifyEnrollmentSecret(db: Db, rawSecret: string): Promise<boolean> {
  const hash = hashSessionToken(rawSecret)

  // 1. Bootstrap env secret (dev / pre-seed). Compared constant-time over hashes.
  const bootstrap = process.env.NUXT_ENROLLMENT_SECRET
  if (bootstrap && constantTimeEqualHex(hash, hashSessionToken(bootstrap))) return true

  // 2. Durable accept-list: a live, non-revoked row whose rotation window is open.
  const rows = await db.execute<{ ok: number }>(sql`
    SELECT 1 AS ok
      FROM enrollment_secret
     WHERE secret_hash = ${hash}
       AND revoked_at IS NULL
       AND (not_before IS NULL OR not_before <= now())
       AND (not_after  IS NULL OR not_after  > now())
     LIMIT 1
  `)
  return [...rows].length > 0
}

export interface EnrolledInstance {
  instanceId: string
  teammateId: string
  reused: boolean
}

/** Returned (instead of an EnrolledInstance) when a provisional cap is hit → 429. */
export interface CapExceeded {
  capExceeded: true
}

/**
 * Default region + org_unit placement for a provisional teammate. There is no
 * authenticated identity at enroll time, so we use the same lexicographic-first
 * region + its first org_unit fallback as JIT teammate creation
 * (server/auth/jit-teammate.ts) — a valid RLS scope even though the human hasn't
 * been explicitly placed. A confirm-on-auth merge re-points later.
 */
async function defaultPlacement(db: Db): Promise<{ regionId: string; orgUnitId: string }> {
  const rows = await db.execute<{ region_id: string; org_unit_id: string }>(sql`
    SELECT r.id::text AS region_id, ou.id::text AS org_unit_id
      FROM region r
      JOIN org_unit ou ON ou.region_id = r.id
     ORDER BY r.code ASC, ou.path ASC
     LIMIT 1
  `)
  const row = [...rows][0]
  if (!row) {
    throw new Error(
      'enroll: no region/org_unit rows — seed the DB (npm run db:seed) before emit-on-install enroll',
    )
  }
  return { regionId: row.region_id, orgUnitId: row.org_unit_id }
}

/**
 * Locate-or-create the provisional teammate + instance for an enroll request.
 *
 * Idempotency: keyed on (claimed_email, device_binding) — a re-enroll / replay
 * from the same device reuses the same provisional teammate + instance instead of
 * minting new rows. device_binding is a DEDUP HINT only: it is HMAC-hashed at rest
 * and matched on the hash, and is NEVER an authentication factor (the secret gate
 * is the only auth). A miss falls through to a fresh mint.
 *
 * On the create branch: a global + per-email cap returns CapExceeded (→ 429). The
 * provisional teammate uses the reserved entra_oid='provisional:'||uuid namespace
 * (excluded from the real-email partial-unique index, mig 0057), provisional=true,
 * email=claimed_email — it NEVER links to or looks up a real (provisional=false)
 * teammate. The instance id is SERVER-CHOSEN (randomUUID), identity_state
 * 'provisional', claimed_email set, attestation_state 'unassigned' (untagged).
 *
 * `tool` stamps which emitting client this enrolment is for (instance_attestation.tool)
 * so the device's spend groups correctly — it mirrors the discriminator
 * provision_emit threads via locateOrCreateInstance. It is set ONLY on the create
 * branch; an idempotent reuse returns the row as-is (a re-enrol never re-labels an
 * existing device). Defaults to 'claude-code' for callers that don't pass one.
 *
 * MUST be called inside the endpoint's transaction (the caller mints the emit
 * credential + audits in the same tx so a mid-sequence failure rolls back cleanly).
 */
export async function locateOrCreateProvisionalInstance(
  db: Db,
  claimedEmail: string,
  deviceBinding: string,
  tool: EmitTool = 'claude-code',
): Promise<EnrolledInstance | CapExceeded> {
  const deviceHash = hashSessionToken(deviceBinding)

  // TOCTOU GUARD (PR #87 FIX 4): the SELECT-then-INSERT dedup below races — two
  // concurrent enrolls for the SAME (claimed_email, device) both miss the SELECT
  // and each mint a duplicate shadow teammate + instance + credential. Serialize
  // per dedup key with a transaction-scoped advisory lock (auto-released at
  // commit/rollback): the second enroll blocks until the first commits, then its
  // SELECT sees the freshly-minted row and reuses it (true idempotency). Keyed on
  // the SAME (claimed_email, device-hash) pair the dedup matches on. REQUIRES the
  // endpoint's surrounding transaction (the docstring already mandates it).
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(hashtext(lower(${claimedEmail}) || ':' || ${deviceHash})::bigint)
  `)

  // Idempotent reuse — a LIVE provisional instance for this (claimed_email,
  // device_binding-hash). Matched off the instance row (NOT a teammate-by-email
  // lookup), so reusing its teammate is not an existence oracle.
  const existing = await db.execute<{ instance_id: string; teammate_id: string }>(sql`
    SELECT instance_id::text AS instance_id, teammate_id::text AS teammate_id
      FROM instance_attestation
     WHERE identity_state = 'provisional'
       AND claimed_email = ${claimedEmail}
       AND ts_actual_end IS NULL
       AND notes->>'device_binding_hash' = ${deviceHash}
     ORDER BY ts_start DESC
     LIMIT 1
  `)
  const found = [...existing][0]
  if (found) {
    return { instanceId: found.instance_id, teammateId: found.teammate_id, reused: true }
  }

  // Caps apply ONLY to the create branch — idempotent reuse above never consumes
  // quota. Global DoS backstop first, then the per-claimed_email bound.
  const globalRows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM instance_attestation WHERE identity_state = 'provisional'
  `)
  if (Number([...globalRows][0]?.count ?? 0) >= maxProvisionalInstances()) {
    return { capExceeded: true }
  }
  const emailRows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM instance_attestation
     WHERE identity_state = 'provisional' AND claimed_email = ${claimedEmail}
  `)
  if (Number([...emailRows][0]?.count ?? 0) >= maxProvisionalInstancesPerEmail()) {
    return { capExceeded: true }
  }

  const { regionId, orgUnitId } = await defaultPlacement(db)

  // Provisional shadow teammate — reserved namespace, NEVER a real teammate.
  const provisionalOid = `provisional:${randomUUID()}`
  const teammateRows = await db.execute<{ id: string }>(sql`
    INSERT INTO teammate (entra_oid, email, display_name, role, region_id, org_unit_id, provisional)
    VALUES (${provisionalOid}, ${claimedEmail}, ${claimedEmail}, 'developer',
            ${regionId}::uuid, ${orgUnitId}::uuid, true)
    RETURNING id::text AS id
  `)
  const teammateId = [...teammateRows][0]!.id

  // Server-chosen instance id (randomUUID) — NEVER created on a client-supplied id.
  // principal_email is NULL (claimed_email carries the unverified email for
  // provisional rows, per the instance_attestation schema note). notes holds the
  // hashed device-binding dedup hint.
  const instanceId = randomUUID()
  const tsExpectedEnd = new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
  await db.execute(sql`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, tool,
       ts_expected_end, region_id, org_unit_id, attestation_state,
       identity_state, claimed_email, notes)
    VALUES (${instanceId}::uuid, ${provisionalOid}, NULL, ${teammateId}::uuid, ${tool},
            ${tsExpectedEnd.toISOString()}::timestamptz, ${regionId}::uuid, ${orgUnitId}::uuid,
            'unassigned', 'provisional', ${claimedEmail},
            ${JSON.stringify({ device_binding_hash: deviceHash })}::jsonb)
  `)
  return { instanceId, teammateId, reused: false }
}
