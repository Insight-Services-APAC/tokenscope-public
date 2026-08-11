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
import { advisoryGlobalCapLock, advisoryXactLock } from '../db/advisory-lock'
import { REFRESH_TOKEN_TTL_MS } from './oauth'
import type { EmitTool } from './emit-provision'
import { resolveDefaultRegionId, unplacedOrgUnitIdForRegion } from './placement-home'

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
 * authenticated identity at enroll time, so we resolve the SAME
 * lexicographic-first region jit-teammate.ts does (server/auth/placement-home.ts's
 * resolveDefaultRegionId — one shared implementation so the two lanes can never
 * pick a DIFFERENT default region), then home on that region's `__UNPLACED__`
 * holding node — a real, least-privilege RLS scope that grants nothing even
 * though the human hasn't been explicitly placed. A confirm-on-auth merge
 * re-points later.
 *
 * S3: this used to pick "the first org_unit ORDER BY path" for the SAME region
 * in one combined query — ltree sorts a region's root before its children, so it
 * landed every enrolled instance on the region ROOT, whose subtree is the whole
 * region. unplacedOrgUnitIdForRegion needs a region passed in and never invents
 * one itself (a helper that defaults the region internally would be the next
 * silent cross-region placement) — so the region is resolved FIRST, explicitly.
 */
async function defaultPlacement(db: Db): Promise<{ regionId: string; orgUnitId: string }> {
  const regionId = await resolveDefaultRegionId(db)
  if (!regionId) {
    throw new Error(
      'enroll: no region rows — seed the DB (npm run db:seed) before emit-on-install enroll',
    )
  }
  const orgUnitId = await unplacedOrgUnitIdForRegion(db, regionId)
  return { regionId, orgUnitId }
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
  // the SAME (claimed_email, device-hash, tool) triple the dedup matches on — the
  // lock key MUST track the dedup key, or the TOCTOU protection stops covering it.
  // REQUIRES the endpoint's surrounding transaction (the docstring already mandates it).
  // Namespaced (server/db/advisory-lock.ts) so a dedup-key hash can never collide
  // with the email key taken below: in one flat key space those two could be
  // acquired in opposite order by two transactions and deadlock.
  await db.execute(
    advisoryXactLock('instance', `${claimedEmail.toLowerCase()}:${deviceHash}:${tool}`),
  )

  // Idempotent reuse — a LIVE provisional instance for this (claimed_email,
  // device_binding-hash, tool). Matched off the instance row (NOT a teammate-by-email
  // lookup), so reusing its teammate is not an existence oracle.
  //
  // `tool` is part of the dedup key, and must be: an instance is bound to ONE emit
  // tool, and the caller (/setup/enroll) rotates the reused instance's emit
  // credential via issueInstanceEmitCredentialTx. Matching on (email, device) ALONE
  // meant a copilot-cli enrol reused a claude-code host's provisional instance and
  // revoked its live credential, silently breaking the OTHER CLI's emitting — the
  // very failure the cross-tool guard in emit-provision.ts refuses, reached through
  // this second and unauthenticated door. The `tool` parameter was already accepted
  // and stamped on the create branch below; only the reuse predicate ignored it.
  //
  // Partitioned rather than refused with a 409, deliberately. Here the dedup key is
  // IMPLICIT (the client never asserts an instance id, unlike provision_emit), so
  // two tools on one host legitimately want two instances and minting the second is
  // correct behaviour, not an error. It also avoids turning the guard into an
  // enrolled-email oracle on a route that authenticates nobody. The caps below still
  // apply to the create branch, so this cannot be used to mint unboundedly.
  const existing = await db.execute<{ instance_id: string; teammate_id: string }>(sql`
    SELECT instance_id::text AS instance_id, teammate_id::text AS teammate_id
      FROM instance_attestation
     WHERE identity_state = 'provisional'
       AND claimed_email = ${claimedEmail}
       AND ts_actual_end IS NULL
       AND notes->>'device_binding_hash' = ${deviceHash}
       AND tool = ${tool}
     ORDER BY ts_start DESC
     LIMIT 1
  `)
  const found = [...existing][0]
  if (found) {
    return { instanceId: found.instance_id, teammateId: found.teammate_id, reused: true }
  }

  // We are committed to the CREATE branch, and the lock at the top of this
  // function does not bound it. That lock keys on (email, device-hash, tool),
  // which is the DEDUP key; the caps below are per-EMAIL and GLOBAL. So two
  // enrols for the same email from different devices, or from the same device
  // for different tools, take DIFFERENT locks, read the same pre-insert counts,
  // and both insert. Partitioning on tool widened that window (it added a second
  // way for one email to hold two distinct dedup keys), so it is fixed here
  // rather than left as a pre-existing race the partition made easier to reach.
  //
  // Lock the email before counting. pg_advisory_xact_lock is re-entrant within a
  // transaction, and this key is in a distinct namespace from the dedup key
  // above, so the two locks compose rather than conflict. Ordering is ascending
  // by namespace everywhere (instance, principal, globalCap), which is what
  // keeps this from deadlocking.
  await db.execute(advisoryXactLock('principal', claimedEmail.toLowerCase()))

  // The global backstop below counts EVERY provisional instance, so an
  // email-scoped lock cannot serialise it: concurrent enrols for N different
  // emails hold N different principal locks, all read the same pre-insert
  // total, and all insert past the cap. That defeats the DoS backstop for the
  // exact caller it exists to stop, since the attacker chooses the email. A
  // fixed global key is the only thing that bounds a whole-table count.
  await db.execute(advisoryGlobalCapLock('provisional'))

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
  //
  // ONE SHADOW PER INSTANCE, deliberately kept. Partitioning the instance dedup
  // key by `tool` (above) means one human on one host using both CLIs now gets
  // two provisional shadow identities rather than one, so their pre-confirmation
  // spend renders as two rows until they confirm.
  //
  // Sharing one shadow across the two instances was tried and reverted. It is
  // the nicer end state, but "enroll mints a fresh shadow per (email, device)"
  // is an invariant the surrounding code and its tests already encode (see
  // tests/integration/setup/confirm-instance.test.ts, which asserts the shadow
  // is retired on the FIRST confirm), and changing it turns a scoped credential
  // fix into a change of the provisional identity model. The cost of not sharing
  // is bounded and self-healing: both identities carry the same claimed_email,
  // the provisional-instance list is keyed on that email rather than on the
  // teammate, the spend is pre-bill throughout, and confirming each instance
  // re-points its own history onto the one real teammate. Worth revisiting as
  // its own change.
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
