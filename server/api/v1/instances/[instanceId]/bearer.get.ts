/*
 * GET /api/v1/instances/{instanceId}/bearer — refresh Azure Monitor Bearer.
 *
 * Per api-and-connector-interfaces.md §1.2. Auth-only (NOT the cookie); emission
 * stays direct-to-Azure (ADR-0003). OAUTH-ONLY: the presented Bearer must be an
 * OAuth `tokenscope.emit` access token (ADR-0005 — the durable, auto-refreshing
 * credential). The legacy per-instance 12h session token (the dead-end credential
 * superseded by OAuth) has been removed entirely — there is no Path A.
 *
 * Validated via requireOAuthBearer; the bound teammate must OWN this instance
 * (instance_attestation.teammate_id) and the instance must not be ended/revoked.
 *
 * OBO is mocked locally (server/auth/obo.ts); Epic 10 swaps in the real
 * @azure/identity flow.
 */
import { createError, defineEventHandler, getRouterParam, getRequestHeaders } from 'h3'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb, schema } from '../../../../db'
import { requireOAuthBearer, presentedTokenInfo } from '../../../../auth/oauth-bearer'
import { mintAzureMonitorBearer } from '../../../../auth/obo'
import { recordBearerAuthFailed, resolveBearerAuthFailed } from '../../../../db/instance-health'
import { readClientVersionHeaders } from '../../../../utils/client-version'

const SidSchema = z.string().uuid()

/** True when the 401's silence would be EXPECTED (lifecycle), not the disaster. */
function instanceLifecycleSilent(row: InstanceRow): boolean {
  if (row.tsActualEnd) return true
  return Boolean(
    row.teammateRevokedAt && row.tsStart && row.teammateRevokedAt.getTime() > row.tsStart.getTime(),
  )
}

interface InstanceRow {
  instanceId: string
  principalOid: string
  teammateId: string | null
  tsActualEnd: Date | null
  tsStart: Date | null
  teammateRevokedAt: Date | null
}

/** The instance + its owner's revocation state (one row or null). */
async function loadInstance(db: ReturnType<typeof getDb>, sid: string): Promise<InstanceRow | null> {
  const [row] = await db
    .select({
      instanceId: schema.instanceAttestation.instanceId,
      principalOid: schema.instanceAttestation.principalOid,
      teammateId: schema.instanceAttestation.teammateId,
      tsActualEnd: schema.instanceAttestation.tsActualEnd,
      tsStart: schema.instanceAttestation.tsStart,
      // E2 (ADR-0005): the emit-path analogue of isRevoked().
      teammateRevokedAt: schema.teammate.revokedAt,
    })
    .from(schema.instanceAttestation)
    .leftJoin(schema.teammate, eq(schema.teammate.id, schema.instanceAttestation.teammateId))
    .where(eq(schema.instanceAttestation.instanceId, sid))
    .limit(1)
  return row ?? null
}

/** Shared lifecycle gate (ts_actual_end + E2 teammate.revoked_at). */
function assertInstanceLive(row: InstanceRow): void {
  if (row.tsActualEnd) {
    throw createError({ statusCode: 401, statusMessage: 'Session ended' })
  }
  // E2: a teammate revoked AFTER this instance was enrolled (revoked_at >
  // ts_start) must stop emitting immediately — offboarding / force-revoke /
  // re-scope. An instance enrolled AFTER a revocation (re-enrol) is fine.
  if (row.teammateRevokedAt && row.tsStart && row.teammateRevokedAt.getTime() > row.tsStart.getTime()) {
    throw createError({ statusCode: 401, statusMessage: 'Session revoked' })
  }
}

export default defineEventHandler(async (event) => {
  // safeParse → 400 (AUTH-7): a bare .parse throws a raw ZodError, which h3
  // surfaces as a 500.
  const parsed = SidSchema.safeParse(getRouterParam(event, 'instanceId'))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid instance id' })
  }
  const sid = parsed.data

  const db = getDb()

  // ── OAuth emit-scoped access token — BEFORE any instance lookup ───────────
  // Authenticating first kills the unauthenticated existence oracle (AUTH-7):
  // an unauthenticated caller gets 401 for existing AND non-existing ids alike.
  //
  // Validate the token (signature/expiry/revocation + E2 teammate.revoked_at vs
  // issuance) and require the tokenscope.emit scope. requireOAuthBearer throws a
  // 401 on any failure (incl. "not recognised" / missing header).
  //
  // A 401 here is the went-silent DISASTER signal (ADR-0005 d4): the durable emit
  // credential was REJECTED, so OTLP export silently stops. Record it as an
  // instance-health signal — but ONLY when (a) the instance is LIVE (a 401 on an
  // ended / E2-revoked instance is EXPECTED, not an anomaly), (b) the rejected
  // token genuinely belongs to THIS instance's owner, AND (c) it actually carries
  // tokenscope.emit and (when bound) is bound to THIS instance (AUTH-6 — a
  // rejected read/tag token is a misconfigured helper, not the emission disaster,
  // and must not open a false "your emit credential failed" alert). The
  // owner-check is the abuse guard: without it, anyone could POST a garbage token
  // to /bearer/{anyId} and forge a "your credential failed" alert to that
  // instance's teammate. A token hash that matches a stored oauth_token row for
  // the owner is un-forgeable proof it's the owner's real (now-failing)
  // credential — not a probe.
  let teammate
  try {
    // Pass `sid` so requireOAuthBearer's per-DEVICE binding check applies: an
    // emit credential minted for a DIFFERENT instance now 401s here instead
    // of silently degrading to a per-teammate check (the ADR-0008 §2 fix).
    teammate = await requireOAuthBearer(event, 'tokenscope.emit', db as never, sid)
  } catch (err: unknown) {
    if ((err as { statusCode?: number })?.statusCode === 401) {
      const row = await loadInstance(db, sid)
      if (row && !instanceLifecycleSilent(row)) {
        const token = await presentedTokenInfo(event, db as never)
        const isOwner = Boolean(token && token.teammateId === row.teammateId)
        const isEmit = Boolean(token?.scope.split(' ').includes('tokenscope.emit'))
        const boundHere = token?.instanceId === null || token?.instanceId === sid
        if (isOwner && isEmit && boundHere) {
          await recordBearerAuthFailed(db, sid)
        }
      }
    }
    throw err
  }

  const row = await loadInstance(db, sid)
  // Not-found AND not-owned collapse to the SAME 404 (mirrors
  // me/instances/[instanceId]/revoke.post.ts's "don't leak a peer's instance
  // existence with a 403" rule) — an unknown id and a peer's real instance
  // are now indistinguishable. The requireOAuthBearer binding check above
  // already turned a WRONG-instance credential into a 401 before we ever get
  // here; this 404 is reached only for a credential correctly bound to (or
  // permissively unbound from) `sid` whose TEAMMATE still doesn't own it.
  if (!row || !row.teammateId || row.teammateId !== teammate.teammateId) {
    throw createError({ statusCode: 404, statusMessage: 'Instance not found' })
  }

  // The OWNER's credential is valid → clear any prior bearer-auth-failed signal
  // (recovery). After the ownership check, so a stranger's valid token can't
  // resolve someone else's open failure (the mirror of the record abuse guard).
  await resolveBearerAuthFailed(db, sid)

  // Lifecycle gate (ended / E2-revoked). ts_expected_end is NOT enforced for
  // OAuth — durability is the whole point; revocation is the gate.
  assertInstanceLive(row)

  // Heartbeat (0030): a successful mint proves this LIVE, OWNED instance held a
  // valid emit credential now — the authenticated signal heartbeat-coverage uses
  // to verify emitted spend. Best-effort; never fail the mint over the stamp.
  //
  // CLIENT VERSION (mig 0092) rides the SAME write. The client states its plugin
  // and CLI versions in request headers, so capturing them costs one extra
  // `.set()` on a statement that already runs ~every 29 minutes per live device —
  // no new endpoint, no new client traffic, and the value recorded is the version
  // of the code that ACTUALLY minted this bearer.
  //
  // The values are CLIENT-ASSERTED and are stored as diagnostic hints ONLY. Note
  // where this write sits: AFTER requireOAuthBearer, AFTER the ownership check.
  // That is deliberate — an unauthenticated or non-owning caller must not be able
  // to write a version claim onto someone else's instance row (the same abuse
  // guard the bearer-auth-failed signal above carries). It is still not a trust
  // upgrade: the OWNER can claim any version. Nothing may gate on these.
  //
  // Each field is written ONLY when that field was reported, and nothing is ever
  // nulled by a mint:
  //   - reports nothing (an old build predating the headers) → both columns keep
  //     whatever they held. Nulling would erase a previous reading the moment a
  //     device downgraded, collapsing "was on 0.1.27, stopped reporting" into
  //     "never reported" — different diagnoses. client_version_at is what tells
  //     them apart.
  //   - reports one field only (e.g. a Copilot CLI client, or a launch where the
  //     CLI version is not discoverable from the environment) → that field is
  //     updated and the other is preserved rather than blanked.
  // Consequence to know when reading the data: client_version_at is "when a
  // version claim was last recorded", not a per-column timestamp, so on a
  // partially-reporting client the un-updated column may be older than the stamp.
  const claim = readClientVersionHeaders(getRequestHeaders(event))
  try {
    await db
      .update(schema.instanceAttestation)
      .set({
        lastBearerAt: new Date(),
        ...(claim.pluginVersion !== null ? { clientPluginVersion: claim.pluginVersion } : {}),
        ...(claim.cliVersion !== null ? { clientCliVersion: claim.cliVersion } : {}),
        ...(claim.reported ? { clientVersionAt: new Date() } : {}),
      })
      .where(eq(schema.instanceAttestation.instanceId, sid))
  } catch {
    /* heartbeat stamp is advisory */
  }

  return mintFor(row)
})

async function mintFor(row: InstanceRow) {
  const obo = await mintAzureMonitorBearer({
    principalOid: row.principalOid,
    sessionId: row.instanceId,
  })
  return { Authorization: `Bearer ${obo.bearer}` }
}
