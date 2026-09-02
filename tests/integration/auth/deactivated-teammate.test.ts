// @vitest-environment node
/*
 * `is_active` on the AUTHENTICATION path (audit round 2, finding #1).
 *
 * THE DEFECT: isRevoked() (server/utils/auth.ts) checked ONLY teammate.revoked_at.
 * The privileged-identity-cleanup worker's sole identity mutation is
 * `UPDATE teammate SET is_active = FALSE` (server/workers/privileged-identity-cleanup.ts)
 * — it never touches revoked_at — and resolveOrCreateTeammate's fast path
 * (server/auth/jit-teammate.ts) returns an existing row without consulting
 * is_active either. So a "cleaned" privileged/service account kept its live
 * cookie session AND could keep signing in indefinitely: the retirement worker
 * was cosmetic for access. The ASSIGNMENT side already gated on the same column
 * (ensure-real-identity.ts, provision-directory-teammate.ts); no AUTHENTICATION
 * path did.
 *
 * The two axes are deliberately different shapes, and both are asserted here:
 *   - revoked_at is a SESSION ANCHOR — overloaded (ADR-0005 §E2), so it only
 *     invalidates sessions minted BEFORE it. Re-signing-in works. Unchanged.
 *   - is_active=false is DEACTIVATION — a durable state. It denies every
 *     session, existing or new, with no timestamp comparison.
 *
 * THE REGRESSION THIS FILE EXISTS TO RULE OUT (§"retired provisional shadow"):
 * confirm-instance.ts:320-328 also sets is_active=false — on the provisional
 * SHADOW teammate it retires after a confirm-on-auth merge. If such a row could
 * hold a live session or a live emit credential at the moment it is retired,
 * consulting is_active in isRevoked() would break emission for confirming users.
 * The tests below establish, against a real DB and the real merge code, that it
 * cannot: the emit credential is re-bound to the real teammate BEFORE the
 * shadow is retired, and the shadow is only retired once it owns no instances.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let orgUnitId: string

/** The account the cleanup worker retires. Active at seed; each test sets state. */
let subjectId: string
const SUBJECT_OID = 'oid-deact-subject'
const SUBJECT_EMAIL = 'svc-admin@example.com'

/** An ordinary active teammate — the "nothing changed for a normal user" control. */
let controlId: string
const CONTROL_OID = 'oid-deact-control'
const CONTROL_EMAIL = 'ordinary.dev@example.com'

/** A DEMO_PERSONAS teammate — reaches the SECOND isRevoked() call site
 *  (resolveFromOverrideOnly, the dev-mode/persona path). */
let priyaId: string
const PRIYA_EMAIL = 'demo-priya.iyer@example.com'
const LENA_OID = 'oid-deact-lena'
let lenaId: string

beforeAll(async () => {
  process.env.NUXT_SESSION_SECRET = 'deactivated-teammate-test-secret-32-chars-plus'
  process.env.NUXT_HMAC_SESSION_KEY = 'deactivated-teammate-test-hmac-key-32-chars-plus'
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  vi.resetModules()

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'deact', displayName: 'Deact Region' })
    .returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'deact.svc',
      code: 'deact-svc',
      displayName: 'Deact Services',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  orgUnitId = bu!.id

  for (const seed of [
    { email: SUBJECT_EMAIL, oid: SUBJECT_OID, name: 'Service Admin', role: 'developer' },
    { email: CONTROL_EMAIL, oid: CONTROL_OID, name: 'Ordinary Dev', role: 'developer' },
    { email: PRIYA_EMAIL, oid: 'oid-deact-priya', name: 'Priya Iyer', role: 'developer' },
    { email: 'demo-lena.park@example.com', oid: LENA_OID, name: 'Lena Park', role: 'admin' },
  ]) {
    const [row] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: seed.oid,
        email: seed.email,
        displayName: seed.name,
        role: seed.role,
        regionId,
        orgUnitId,
      })
      .returning()
    if (seed.email === SUBJECT_EMAIL) subjectId = row!.id
    if (seed.email === CONTROL_EMAIL) controlId = row!.id
    if (seed.email === PRIYA_EMAIL) priyaId = row!.id
    if (seed.oid === LENA_OID) lenaId = row!.id
  }
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  delete process.env.NUXT_OIDC_AUTH_DEV_MODE
  delete process.env.NUXT_ALLOW_PERSONA_OVERRIDE
  delete process.env.NUXT_DEPLOY_ENV
  // Reset the subject to fully active between cases.
  await t.client`UPDATE teammate SET is_active = TRUE, revoked_at = NULL WHERE id = ${subjectId}::uuid`
})

// ── harness ──────────────────────────────────────────────────────────────────

function bareEvent() {
  const cookies = new Map<string, string>()
  return {
    context: {} as Record<string, unknown>,
    node: {
      req: {
        method: 'GET',
        url: '/api/v1/auth/me',
        get headers() {
          const cookie = Array.from(cookies.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; ')
          return { host: 'localhost:3450', cookie }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) {
          return this._headers[n.toLowerCase()]
        },
        setHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
          if (n.toLowerCase() === 'set-cookie') {
            for (const item of Array.isArray(v) ? v : [v]) {
              const [pair] = item.split(';')
              const eq = pair!.indexOf('=')
              cookies.set(pair!.slice(0, eq), pair!.slice(eq + 1))
            }
          }
        },
        removeHeader(n: string) {
          this._headers[n.toLowerCase()] = ''
        },
        appendHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        get headersSent() {
          return false
        },
      },
    },
  }
}

/**
 * Run `fn` with nuxt-oidc-auth's session reader mocked to return an OIDC
 * session — the ONLY way to reach resolveSession's "Normal path" and therefore
 * isRevoked(). `loggedInAtSec` is the session's mint time: the point of the
 * "existing session" case is that it is set BEFORE the deactivation.
 * (injectTestSession, which every other integration test uses, pre-populates
 * tryAuth's per-event cache and never reaches resolveSession at all.)
 */
async function withOidc<T>(
  claims: { oid: string; email: string; name?: string },
  loggedInAtSec: number,
  fn: (authModule: typeof import('../../../server/utils/auth')) => Promise<T>,
): Promise<T> {
  vi.doMock('nuxt-oidc-auth/runtime/server/utils/session.js', () => ({
    getUserSession: async () => ({
      loggedInAt: loggedInAtSec,
      claims: { oid: claims.oid, email: claims.email, name: claims.name },
    }),
  }))
  vi.resetModules()
  const authModule = await import('../../../server/utils/auth')
  try {
    return await fn(authModule)
  } finally {
    vi.doUnmock('nuxt-oidc-auth/runtime/server/utils/session.js')
    vi.resetModules()
  }
}

const nowSec = () => Math.floor(Date.now() / 1000)

// ── The defect ───────────────────────────────────────────────────────────────

describe('is_active is consulted on the authentication path', () => {
  it('CONTROL: an ordinary ACTIVE teammate still resolves a session', async () => {
    const session = await withOidc(
      { oid: CONTROL_OID, email: CONTROL_EMAIL, name: 'Ordinary Dev' },
      nowSec(),
      async ({ tryAuth }) => tryAuth(bareEvent() as never),
    )
    expect(session?.teammateId).toBe(controlId)
  })

  it('a deactivated teammate is refused a NEW sign-in (is_active=FALSE, revoked_at NULL)', async () => {
    // EXACTLY the cleanup worker's mutation — is_active only, revoked_at untouched.
    await t.client`UPDATE teammate SET is_active = FALSE WHERE id = ${subjectId}::uuid`
    const [row] = await t.client<{ revoked_at: string | null }[]>`
      SELECT revoked_at::text AS revoked_at FROM teammate WHERE id = ${subjectId}::uuid`
    expect(row!.revoked_at).toBeNull() // the worker really does not set it

    // A brand-new sign-in, minted right now — nothing for revoked_at to beat.
    const session = await withOidc(
      { oid: SUBJECT_OID, email: SUBJECT_EMAIL, name: 'Service Admin' },
      nowSec(),
      async ({ tryAuth }) => tryAuth(bareEvent() as never),
    )
    expect(session).toBeNull()
  })

  it("a deactivated teammate's EXISTING session stops resolving (minted long before deactivation)", async () => {
    // The live-cookie case: the session was minted an hour ago, the worker
    // deactivates now, and revoked_at is still NULL — so the revoked_at >
    // issuedAt comparison can never fire. Only is_active closes this.
    const issuedAnHourAgo = nowSec() - 3600
    await t.client`UPDATE teammate SET is_active = FALSE WHERE id = ${subjectId}::uuid`

    const session = await withOidc(
      { oid: SUBJECT_OID, email: SUBJECT_EMAIL, name: 'Service Admin' },
      issuedAnHourAgo,
      async ({ tryAuth }) => tryAuth(bareEvent() as never),
    )
    expect(session).toBeNull()
  })

  it('the same teammate resolves again the moment they are REACTIVATED (the gate is is_active, not a side effect)', async () => {
    await t.client`UPDATE teammate SET is_active = FALSE WHERE id = ${subjectId}::uuid`
    const denied = await withOidc(
      { oid: SUBJECT_OID, email: SUBJECT_EMAIL },
      nowSec(),
      async ({ tryAuth }) => tryAuth(bareEvent() as never),
    )
    expect(denied).toBeNull()

    await t.client`UPDATE teammate SET is_active = TRUE WHERE id = ${subjectId}::uuid`
    const allowed = await withOidc(
      { oid: SUBJECT_OID, email: SUBJECT_EMAIL },
      nowSec(),
      async ({ tryAuth }) => tryAuth(bareEvent() as never),
    )
    expect(allowed?.teammateId).toBe(subjectId)
  })

  it('revoked_at keeps its EXISTING semantics: it invalidates only sessions minted before it', async () => {
    // Guards against "fixed is_active by making revoked_at absolute". A benign
    // role/region change bumps revoked_at (ADR-0005 §E2); the user must still be
    // able to sign in again immediately.
    await t.client`UPDATE teammate SET revoked_at = now() WHERE id = ${subjectId}::uuid`

    const stale = await withOidc(
      { oid: SUBJECT_OID, email: SUBJECT_EMAIL },
      nowSec() - 3600,
      async ({ tryAuth }) => tryAuth(bareEvent() as never),
    )
    expect(stale).toBeNull() // minted before the bump → refused, as before

    const fresh = await withOidc(
      { oid: SUBJECT_OID, email: SUBJECT_EMAIL },
      nowSec() + 60,
      async ({ tryAuth }) => tryAuth(bareEvent() as never),
    )
    expect(fresh?.teammateId).toBe(subjectId) // minted after → still valid
  })

  it('the dev-mode / persona-override call site is gated too (resolveFromOverrideOnly)', async () => {
    // The SECOND isRevoked() call site. Demo-capable env + dev mode + override.
    process.env.NUXT_OIDC_AUTH_DEV_MODE = 'true'
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'

    async function personaSession() {
      vi.resetModules()
      const { setPersonaOverrideCookie } = await import(
        '../../../server/utils/persona-override-cookie'
      )
      const ev = bareEvent()
      setPersonaOverrideCookie(ev as unknown as Parameters<typeof setPersonaOverrideCookie>[0], {
        targetTeammateId: priyaId,
        issuedAt: new Date().toISOString(),
        impersonatorOid: LENA_OID,
        impersonatorEmail: 'demo-lena.park@example.com',
      })
      const { tryAuth } = await import('../../../server/utils/auth')
      return tryAuth(ev as never)
    }

    expect((await personaSession())?.teammateId).toBe(priyaId) // control

    await t.client`UPDATE teammate SET is_active = FALSE WHERE id = ${priyaId}::uuid`
    try {
      expect(await personaSession()).toBeNull()
    } finally {
      await t.client`UPDATE teammate SET is_active = TRUE WHERE id = ${priyaId}::uuid`
    }
  })

  it('a deactivated IMPERSONATOR cannot keep driving an impersonation session', async () => {
    process.env.NUXT_OIDC_AUTH_DEV_MODE = 'true'
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'

    async function personaSession() {
      vi.resetModules()
      const { setPersonaOverrideCookie } = await import(
        '../../../server/utils/persona-override-cookie'
      )
      const ev = bareEvent()
      setPersonaOverrideCookie(ev as unknown as Parameters<typeof setPersonaOverrideCookie>[0], {
        targetTeammateId: priyaId,
        issuedAt: new Date().toISOString(),
        impersonatorOid: LENA_OID,
        impersonatorEmail: 'demo-lena.park@example.com',
      })
      const { tryAuth } = await import('../../../server/utils/auth')
      return tryAuth(ev as never)
    }

    // The TARGET stays active throughout; only the admin behind the override is
    // retired. Without the impersonator leg this still resolves as priya.
    await t.client`UPDATE teammate SET is_active = FALSE WHERE id = ${lenaId}::uuid`
    try {
      expect(await personaSession()).toBeNull()
    } finally {
      await t.client`UPDATE teammate SET is_active = TRUE WHERE id = ${lenaId}::uuid`
    }
  })
})

// ── The in-process verdict (request-floor-performance.md F2) ─────────────────
//
// The NORMAL (non-override) session path no longer re-reads the teammate row:
// resolveOrCreateTeammate's fused query carries revoked_at/is_active and
// revocationDenies() judges them in-process. The tryAuth cases above pin the
// route-level behaviour (they run the real resolveSession normal path); this
// block pins the verdict function's four branches directly, because the
// row-missing branch is unreachable through tryAuth (the resolver always
// returns a row or throws).

describe('revocationDenies — semantics identical to isRevoked()', () => {
  const nowIso = () => new Date().toISOString()

  async function verdict() {
    vi.resetModules()
    const { revocationDenies } = await import('../../../server/utils/auth')
    return revocationDenies
  }

  it('teammate row gone denies (fail closed)', async () => {
    const revocationDenies = await verdict()
    expect(revocationDenies(null, nowIso())).toBe(true)
    expect(revocationDenies(undefined, nowIso())).toBe(true)
  })

  it('is_active !== true denies — false AND null (fail closed), regardless of revoked_at', async () => {
    const revocationDenies = await verdict()
    expect(revocationDenies({ revokedAt: null, isActive: false }, nowIso())).toBe(true)
    expect(revocationDenies({ revokedAt: null, isActive: null }, nowIso())).toBe(true)
  })

  it('revoked_at > issuedAt denies; revoked_at < issuedAt admits (session ANCHOR, not a flag)', async () => {
    const revocationDenies = await verdict()
    const issued = new Date('2026-08-01T12:00:00.000Z').toISOString()
    const after = new Date('2026-08-01T13:00:00.000Z')
    const before = new Date('2026-08-01T11:00:00.000Z')
    expect(revocationDenies({ revokedAt: after, isActive: true }, issued)).toBe(true)
    expect(revocationDenies({ revokedAt: before, isActive: true }, issued)).toBe(false)
    expect(revocationDenies({ revokedAt: null, isActive: true }, issued)).toBe(false)
  })

  it('an unparseable issuedAt sorts to EPOCH — any revoked_at ever stamped denies', async () => {
    const revocationDenies = await verdict()
    const anyRevoke = new Date('2020-01-01T00:00:00.000Z')
    expect(revocationDenies({ revokedAt: anyRevoke, isActive: true }, 'not-a-date')).toBe(true)
    expect(revocationDenies({ revokedAt: null, isActive: true }, 'not-a-date')).toBe(false)
  })
})

// ── The mandatory regression check: retired provisional shadows ──────────────

describe('a retired provisional shadow teammate keeps doing what it legitimately does', () => {
  /**
   * Build the pre-confirm state the enroll path produces — a provisional SHADOW
   * teammate (entra_oid 'provisional:<uuid>') owning one provisional instance,
   * with a live instance-bound emit credential — then run the REAL merge
   * (confirmProvisionalInstance) and inspect what the shadow is left holding.
   */
  async function enrolProvisional(claimedEmail: string) {
    const shadowOid = `provisional:${randomUUID()}`
    const [shadow] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: shadowOid,
        email: claimedEmail,
        displayName: claimedEmail,
        role: 'developer',
        regionId,
        orgUnitId,
        provisional: true,
      } as never)
      .returning()
    const instanceId = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId,
      principalOid: shadowOid,
      principalEmail: null,
      teammateId: shadow!.id,
      tool: 'claude-code',
      regionId,
      orgUnitId,
      attestationState: 'unassigned',
      identityState: 'provisional',
      claimedEmail,
    } as never)
    return { shadowId: shadow!.id as string, shadowOid, instanceId }
  }

  it('the live emit credential is re-bound to the real teammate BEFORE the shadow is retired — the shadow holds none at retirement', async () => {
    vi.resetModules()
    const { issueEmitCredential } = await import('../../../server/auth/emit-credential')
    const { issueInstanceEmitCredential } = await import('../../../server/auth/emit-provision')
    const { confirmProvisionalInstance } = await import('../../../server/auth/confirm-instance')

    const { shadowId, instanceId } = await enrolProvisional(SUBJECT_EMAIL)

    // Mint the durable emit credential exactly as the enroll path does: bound to
    // the instance, owned (for now) by the SHADOW.
    await issueInstanceEmitCredential(
      t.db as never,
      shadowId,
      instanceId,
      issueEmitCredential as never,
    )
    const before = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM oauth_token
       WHERE teammate_id = ${shadowId}::uuid AND scope = 'tokenscope.emit' AND revoked_at IS NULL`
    expect(Number(before[0]!.c)).toBe(1) // the shadow really does hold one pre-merge

    await confirmProvisionalInstance(t.db as never, {
      realTeammateId: subjectId,
      realTeammateEmail: SUBJECT_EMAIL,
      instanceId,
    })

    // THE EVIDENCE. At the moment is_active=false is stamped on the shadow:
    const shadowRow = await t.client<{ is_active: boolean; revoked_at: string | null }[]>`
      SELECT is_active, revoked_at::text AS revoked_at FROM teammate WHERE id = ${shadowId}::uuid`
    expect(shadowRow[0]!.is_active).toBe(false) // retired, as documented
    // ...it holds ZERO live emit credentials — step 2 of the merge re-bound them.
    const stranded = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM oauth_token
       WHERE teammate_id = ${shadowId}::uuid AND scope = 'tokenscope.emit' AND revoked_at IS NULL`
    expect(Number(stranded[0]!.c)).toBe(0)
    // ...and the credential now answers to the real, ACTIVE teammate.
    const rebound = await t.client<{ teammate_id: string }[]>`
      SELECT teammate_id::text AS teammate_id FROM oauth_token
       WHERE instance_id = ${instanceId}::uuid AND scope = 'tokenscope.emit' AND revoked_at IS NULL`
    expect(rebound.length).toBe(1)
    expect(rebound[0]!.teammate_id).toBe(subjectId)
  })

  it('emission for the confirming user still authenticates after the merge', async () => {
    // The direct answer to "does consulting is_active break emission for
    // confirming users". requireOAuthBearer now consults is_active too
    // (server/auth/oauth-bearer.ts — the OAuth half of this same finding), so
    // this is a live regression guard rather than a formality: it passes only
    // because the credential belongs to the real, ACTIVE teammate post-merge.
    // The shadow's retirement cannot reach it — confirm-instance.ts re-points
    // the credential (step 2) before retiring the shadow (step 4), in ONE
    // transaction, so there is no window in which a live emit credential is
    // owned by an is_active=false row.
    vi.resetModules()
    const { ensureEmitClient } = await import('../../../server/auth/emit-credential')
    const { issueTokens } = await import('../../../server/auth/oauth')
    const { hashSessionToken } = await import('../../../server/auth/hmac')
    const { requireOAuthBearer } = await import('../../../server/auth/oauth-bearer')
    const { confirmProvisionalInstance } = await import('../../../server/auth/confirm-instance')

    const { shadowId, instanceId } = await enrolProvisional(CONTROL_EMAIL)

    // Mint on the shadow and bind to the instance (what the enroll path does),
    // keeping the ACCESS token so the bearer path can actually be exercised.
    const clientId = await ensureEmitClient(t.db as never)
    const tokens = await issueTokens(t.db as never, {
      teammateId: shadowId,
      clientId,
      scope: 'tokenscope.emit',
    })
    await t.db.execute(sql`
      UPDATE oauth_token SET instance_id = ${instanceId}::uuid
       WHERE refresh_token_hash = ${hashSessionToken(tokens.refresh_token)}`)

    await confirmProvisionalInstance(t.db as never, {
      realTeammateId: controlId,
      realTeammateEmail: CONTROL_EMAIL,
      instanceId,
    })

    const shadowRow = await t.client<{ is_active: boolean }[]>`
      SELECT is_active FROM teammate WHERE id = ${shadowId}::uuid`
    expect(shadowRow[0]!.is_active).toBe(false) // shadow retired...

    // ...and the SAME access token the device already holds still works, now
    // resolving to the real teammate.
    const ev = bareEvent() as unknown as {
      node: { req: { headers: Record<string, string> } }
    }
    const withAuth = {
      ...ev,
      node: {
        ...ev.node,
        req: {
          ...ev.node.req,
          headers: { authorization: `Bearer ${tokens.access_token}` },
        },
      },
    }
    const bearer = await requireOAuthBearer(
      withAuth as never,
      'tokenscope.emit',
      t.db as never,
      instanceId,
    )
    expect(bearer.teammateId).toBe(controlId)
  })

  it('what actually keeps a shadow out of a platform session is the reserved oid NAMESPACE — not a provisional check, which does not exist', async () => {
    // Pinning the REAL mechanism, because the plausible-sounding version is
    // false and this test was written asserting it before being corrected.
    //
    // TRUE: a shadow's entra_oid is minted `provisional:<uuid>`
    // (server/auth/enroll-provision.ts), a reserved namespace no Entra id-token
    // `oid` claim can carry — Entra only ever issues GUIDs. That, plus
    // ensure-real-identity.ts refusing (422) to promote a `provisional:` row to
    // a real oid, is the entire protection.
    //
    // FALSE, and asserted here so nobody "simplifies" the reasoning back to it:
    // loadTeammateByOid (server/auth/jit-teammate.ts) does NOT filter on
    // `provisional`. If such an oid were ever presented, a LIVE shadow WOULD
    // resolve a session. The namespace is load-bearing, on its own.
    const { shadowId, shadowOid } = await enrolProvisional('nobody-else@example.com')
    expect(shadowOid.startsWith('provisional:')).toBe(true)

    const live = await withOidc(
      { oid: shadowOid, email: 'nobody-else@example.com' },
      nowSec(),
      async ({ tryAuth }) => tryAuth(bareEvent() as never),
    )
    expect(live?.teammateId).toBe(shadowId) // ← the code as it actually is

    // And the part this change adds: once the shadow is RETIRED exactly as
    // confirm-instance.ts:320-328 leaves it, that same lookup is refused. The
    // fix strictly SHRINKS what a shadow row can do; it takes nothing away that
    // the merge had not already ended.
    await t.client`
      UPDATE teammate SET revoked_at = now(), ended_at = now(), is_active = false
       WHERE id = ${shadowId}::uuid AND provisional = true`
    const retired = await withOidc(
      { oid: shadowOid, email: 'nobody-else@example.com' },
      nowSec(),
      async ({ tryAuth }) => tryAuth(bareEvent() as never),
    )
    expect(retired).toBeNull()
  })
})
