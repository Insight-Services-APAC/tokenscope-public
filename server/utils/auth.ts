/*
 * server/utils/auth.ts — the platform-session surface.
 *
 * Single accessor pattern (modelled on a sibling project's server/utils/auth.ts):
 *
 *   const session = await tryAuth(event)        // null if unauthenticated
 *   const session = await requireAuth(event)    // throws 401 if no session
 *
 * Identity flow (production / sandbox with real Entra):
 *   1. nuxt-oidc-auth's encrypted cookie carries the OIDC identity.
 *   2. tryAuth() decrypts it (via requireUserSession), looks up the
 *      teammate by entra_oid, JIT-creates on first sign-in, and returns
 *      the enriched Session.
 *   3. If NUXT_ALLOW_PERSONA_OVERRIDE=true AND the sandbox override
 *      sidecar cookie is set, the returned session is the PERSONA's
 *      identity stamped with the real admin's impersonator fields.
 *
 * Identity flow (local dev with NUXT_OIDC_AUTH_DEV_MODE=true):
 *   - No OIDC cookie; the sidecar cookie is the primary identity.
 *   - Same revocation check (DB lookup by teammate id).
 *
 * Why one cookie (OIDC) for the normal path: see
 * docs/design/auth-session-cookie-architecture.md. a sibling project / PSR
 * pattern. No ts_session bridge, no h3 setCookie/getCookie race, no
 * SSR-internal-fetch propagation gap.
 *
 * Per-event caching: tryAuth stores the resolved Session in
 * event.context.__tokenscope_session so multiple calls in the same
 * request handler (e.g. validate-session middleware → withRequestRls
 * → route handler) share a single DB lookup.
 */
import { createError, setCookie, type H3Event } from 'h3'
import { eq, sql } from 'drizzle-orm'
import { consola } from 'consola'
// `.js` suffix required for Nitro's package-exports resolution.
import { getUserSession } from 'nuxt-oidc-auth/runtime/server/utils/session.js'
import { DEMO_PERSONAS, type Role } from '../../shared/auth/roles'
import { resolveOrCreateTeammate, type OidcClaims } from '../auth/jit-teammate'
import { readPersonaOverrideCookie } from './persona-override-cookie'
import { currentServerDeployEnv, isDemoCapableEnv } from '../../shared/env/deploy-env'
import { getDb, schema } from '../db'

/**
 * Single source of truth for the persona-override env-flag check.
 * Tolerates accidental capitalization (Bicep's `string(true)` returns
 * `'True'`; canonical wire format is `'true'`). Imported by every
 * site that needs to decide whether the override layer is active.
 */
export function isPersonaOverrideAllowed(): boolean {
  return (process.env.NUXT_ALLOW_PERSONA_OVERRIDE ?? '').toLowerCase() === 'true'
}

export interface Session {
  teammateId: string
  email: string
  displayName: string
  role: Role
  regionId: string
  orgPath: string
  /** Real Entra OID of the admin currently impersonating (sandbox only). */
  impersonatorOid?: string
  /** Real admin email — shown in the header as "Acting as …". */
  impersonatorEmail?: string
  /** ISO timestamp the override started. */
  impersonatedAt?: string
  /**
   * ISO timestamp this session was minted (for revocation comparison).
   * Derived from OIDC `loggedInAt` or override cookie's `impersonatedAt`.
   */
  issuedAt: string
}

interface OidcUserSessionLike {
  loggedInAt?: number | string
  userName?: string
  claims?: Record<string, unknown>
  userInfo?: Record<string, unknown>
}

const SESSION_CTX_KEY = '__tokenscope_session'
const NEGATIVE_CTX_KEY = '__tokenscope_session_negative'

/**
 * Lazy session resolution. Returns null when the request is
 * unauthenticated OR enrichment fails (revoked teammate, missing
 * region, etc.). Cached per-event.
 */
export async function tryAuth(event: H3Event): Promise<Session | null> {
  // Per-event cache — multiple calls in the same handler share work.
  // Defensive context init: h3 always provides context in production,
  // but test mocks may omit it.
  if (!event.context) {
    event.context = {} as H3Event['context']
  }
  const cached = event.context[SESSION_CTX_KEY] as Session | undefined
  if (cached) return cached
  if (event.context[NEGATIVE_CTX_KEY]) return null

  const session = await resolveSession(event)
  if (session) {
    // Freeze the cached session so a later caller in the same request
    // can't mutate it and elevate themselves silently. tryAuth returns
    // the SAME object to every caller in the request (per-event cache);
    // shared-by-reference + a future "elevate temporarily" footgun is
    // closed by making the object immutable at cache time.
    Object.freeze(session)
    event.context[SESSION_CTX_KEY] = session
  } else {
    event.context[NEGATIVE_CTX_KEY] = true
  }
  return session
}

/**
 * Strict auth gate. Use in route handlers that require a session.
 * Throws 401 with the standard problem+json shape.
 */
export async function requireAuth(event: H3Event): Promise<Session> {
  const session = await tryAuth(event)
  if (!session) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthenticated',
      data: {
        type: 'https://tokenscope.example.com/errors/unauthenticated',
        title: 'Unauthenticated',
        status: 401,
        detail: 'Sign in to access this resource.',
      },
    })
  }
  return session
}

// ── Internal resolution ───────────────────────────────────────────────

async function resolveSession(event: H3Event): Promise<Session | null> {
  // ALLOWLIST floor: the persona/dev-mode cookie is only minted or READ on a
  // demo-capable env ({local, sandbox}; shared/env/deploy-env.ts). AND-ing
  // demoCapable here is the second, independent enforcement point (dev-login is
  // the mint side): even if NUXT_OIDC_AUTH_DEV_MODE / NUXT_ALLOW_PERSONA_OVERRIDE
  // drift true on dev/staging/prod/unknown, the signed cookie is never read.
  // The per-request flag reads are preserved (flip-to-false still disables
  // instantly without restart; a stale signed cookie stays inert).
  const demoCapable = isDemoCapableEnv(currentServerDeployEnv())
  const devMode = demoCapable && process.env.NUXT_OIDC_AUTH_DEV_MODE === 'true'
  const allowOverride = demoCapable && isPersonaOverrideAllowed()

  // Dev-mode path: no OIDC; the override cookie IS the primary
  // identity. Local dev only — sandbox / staging / prod are devMode=false.
  if (devMode) {
    return resolveFromOverrideOnly(event, allowOverride)
  }

  // Normal path: OIDC cookie is required. If absent, the request is
  // genuinely unauthenticated.
  const oidcSession = await readOidcSession(event)
  if (!oidcSession) return null

  const claims = extractClaims(oidcSession)
  if (!claims) return null

  const db = getDb()
  let session: Session
  try {
    const resolved = await resolveOrCreateTeammate(db, claims)
    session = {
      teammateId: resolved.teammateId,
      email: resolved.email,
      displayName: resolved.displayName,
      role: resolved.role,
      regionId: resolved.regionId,
      orgPath: resolved.orgPath,
      issuedAt: oidcLoggedInAtIso(oidcSession),
    }
  } catch (err) {
    // A DELIBERATE policy refusal (an excluded privileged/service account, #121)
    // is not an enrichment failure. resolveSession must still return null (its
    // callers — /auth/me, logout — promise "always 200 / never throws", so we
    // must NOT re-throw), but we drop the operator-visible reason into the
    // `auth-jit-error` cookie that login.vue reads + displays, so the user gets
    // a clear "use your standard account" message instead of a silent bounce.
    const excludedDetail = excludedIdentityDetail(err)
    if (excludedDetail) {
      setCookie(event, 'auth-jit-error', excludedDetail, {
        httpOnly: false, // login.vue reads it client-side, then clears it
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 120,
      })
      consola.info('[auth] excluded identity refused at JIT', excludedDetail)
      return null
    }
    consola.warn('[auth] OIDC enrichment failed', err instanceof Error ? err.message : err)
    return null
  }

  // Sandbox-only persona override layer. Production binary never
  // reads the cookie because the env-flag check is the first thing
  // and `allowOverride` is false.
  if (allowOverride) {
    const overridden = await applyPersonaOverride(event, session, db)
    if (overridden) session = overridden
  }

  // Revocation traversal — covers both the primary identity and
  // (when impersonating) the real admin behind the override.
  if (await isRevoked(db, session)) return null

  return session
}

async function resolveFromOverrideOnly(
  event: H3Event,
  allowOverride: boolean,
): Promise<Session | null> {
  if (!allowOverride) {
    // Dev mode without override flag is a deliberate "anonymous
    // local-dev" state; tests can still get a session by setting
    // the cookie themselves.
    return null
  }
  const override = readPersonaOverrideCookie(event)
  if (!override) return null

  const db = getDb()
  const [tm] = await db
    .select({
      id: schema.teammate.id,
      email: schema.teammate.email,
      displayName: schema.teammate.displayName,
      role: schema.teammate.role,
      regionId: schema.teammate.regionId,
      orgUnitId: schema.teammate.orgUnitId,
    })
    .from(schema.teammate)
    .where(eq(schema.teammate.id, override.targetTeammateId))
    .limit(1)
  if (!tm) return null

  const [unit] = await db
    .select({ path: schema.orgUnit.path })
    .from(schema.orgUnit)
    .where(eq(schema.orgUnit.id, tm.orgUnitId))
    .limit(1)
  if (!unit) return null

  const session: Session = {
    teammateId: tm.id,
    email: tm.email,
    displayName: tm.displayName ?? tm.email,
    role: tm.role as Role,
    regionId: tm.regionId,
    orgPath: unit.path,
    issuedAt: override.issuedAt,
    ...(override.impersonatorOid ? { impersonatorOid: override.impersonatorOid } : {}),
    ...(override.impersonatorEmail ? { impersonatorEmail: override.impersonatorEmail } : {}),
    ...(override.impersonatorOid ? { impersonatedAt: override.issuedAt } : {}),
  }

  if (await isRevoked(db, session)) return null
  return session
}

async function applyPersonaOverride(
  event: H3Event,
  baseSession: Session,
  db: ReturnType<typeof getDb>,
): Promise<Session | null> {
  const override = readPersonaOverrideCookie(event)
  if (!override) return null

  // Only honor an override whose impersonator OID matches the live
  // OIDC identity — prevents a stale cookie from another admin's
  // session from elevating a different user.
  // We compare the override's impersonatorOid against the entra_oid
  // of the base session's teammate.
  if (!override.impersonatorOid) return null
  const [callerOid] = await db
    .select({ entraOid: schema.teammate.entraOid })
    .from(schema.teammate)
    .where(eq(schema.teammate.id, baseSession.teammateId))
    .limit(1)
  if (!callerOid || callerOid.entraOid !== override.impersonatorOid) return null

  // Resolve the persona target.
  const [tm] = await db
    .select({
      id: schema.teammate.id,
      email: schema.teammate.email,
      displayName: schema.teammate.displayName,
      role: schema.teammate.role,
      regionId: schema.teammate.regionId,
      orgUnitId: schema.teammate.orgUnitId,
    })
    .from(schema.teammate)
    .where(eq(schema.teammate.id, override.targetTeammateId))
    .limit(1)
  if (!tm) return null

  // Defence in depth: the override cookie can only have been minted by
  // /api/v1/auth/dev-login.post.ts which routes through getPersona() and
  // therefore only accepts DEMO_PERSONAS targets. If the HMAC secret were
  // ever exfiltrated, OR if a future code path mints an override with an
  // arbitrary target, this gate refuses to impersonate a non-demo teammate.
  const targetIsDemo = DEMO_PERSONAS.some(
    (p) => p.email.toLowerCase() === tm.email.toLowerCase(),
  )
  if (!targetIsDemo) return null

  const [unit] = await db
    .select({ path: schema.orgUnit.path })
    .from(schema.orgUnit)
    .where(eq(schema.orgUnit.id, tm.orgUnitId))
    .limit(1)
  if (!unit) return null

  return {
    teammateId: tm.id,
    email: tm.email,
    displayName: tm.displayName ?? tm.email,
    role: tm.role as Role,
    regionId: tm.regionId,
    orgPath: unit.path,
    impersonatorOid: override.impersonatorOid,
    impersonatorEmail: override.impersonatorEmail,
    impersonatedAt: override.issuedAt,
    issuedAt: override.issuedAt,
  }
}

/**
 * Read the encrypted OIDC session via the module. Returns null on any
 * failure (decryption, missing cookie). Does NOT throw.
 */
async function readOidcSession(event: H3Event): Promise<OidcUserSessionLike | null> {
  try {
    const raw = (await getUserSession(event)) as OidcUserSessionLike | null
    if (!raw || typeof raw !== 'object') return null
    if (Object.keys(raw).length === 0) return null
    return raw
  } catch {
    return null
  }
}

function extractClaims(oidcSession: OidcUserSessionLike): OidcClaims | null {
  const claims = oidcSession.claims ?? {}
  const userInfo = oidcSession.userInfo ?? {}
  const oid = (claims as Record<string, unknown>).oid as string | undefined
  const email =
    ((claims as Record<string, unknown>).email as string | undefined) ??
    oidcSession.userName ??
    ((userInfo as Record<string, unknown>).email as string | undefined)
  const name =
    ((claims as Record<string, unknown>).name as string | undefined) ??
    ((userInfo as Record<string, unknown>).name as string | undefined)
  // The UPN (Entra `preferred_username`; `upn` as a fallback) — the axis the
  // directory-exclusion policy matches on (#121). Lowercased to match the
  // matcher's normalisation. Absent → the JIT guard fails open.
  const upnRaw =
    ((claims as Record<string, unknown>).preferred_username as string | undefined) ??
    ((claims as Record<string, unknown>).upn as string | undefined) ??
    ((userInfo as Record<string, unknown>).preferred_username as string | undefined)
  const upn = upnRaw?.toLowerCase()
  if (!oid || !email) return null
  return { oid, email, name, upn }
}

/** If `err` is the excluded-identity refusal thrown by resolveOrCreateTeammate
 *  (#121) — a 403 with the excluded-identity problem type — return its
 *  human-readable detail for the login screen; else null (a genuine enrichment
 *  failure, handled as before). */
function excludedIdentityDetail(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { statusCode?: number; statusMessage?: string; data?: { type?: string; detail?: string } }
  if (e.statusCode === 403 && e.data?.type === 'https://tokenscope.example.com/errors/excluded-identity') {
    return e.data.detail ?? e.statusMessage ?? 'This account cannot be used with TokenScope.'
  }
  return null
}

function oidcLoggedInAtIso(oidcSession: OidcUserSessionLike): string {
  const v = oidcSession.loggedInAt
  if (typeof v === 'number') return new Date(v * 1000).toISOString()
  if (typeof v === 'string') return v
  return new Date().toISOString()
}

interface RevocationRow extends Record<string, unknown> {
  revoked_at: string | Date | null
}

function parseRevokedAtMs(value: string | Date | null | undefined): number | null {
  if (!value) return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * True if the session is post-revocation. Checks the primary identity
 * AND the impersonator (when present). One DB round-trip in the
 * non-impersonating case; two when impersonating.
 */
async function isRevoked(
  db: ReturnType<typeof getDb>,
  session: Session,
): Promise<boolean> {
  const issuedAtMs = Date.parse(session.issuedAt) || 0

  const rows = await db.execute<RevocationRow>(sql`
    SELECT revoked_at FROM teammate WHERE id = ${session.teammateId}::uuid LIMIT 1
  `)
  const row = [...rows][0]
  if (!row) return true // teammate gone — treat as revoked
  const primaryRevokedMs = parseRevokedAtMs(row.revoked_at)
  if (primaryRevokedMs !== null && primaryRevokedMs > issuedAtMs) return true

  if (session.impersonatorOid) {
    const impRows = await db.execute<RevocationRow>(sql`
      SELECT revoked_at FROM teammate WHERE entra_oid = ${session.impersonatorOid} LIMIT 1
    `)
    const impRow = [...impRows][0]
    const impRevokedMs = parseRevokedAtMs(impRow?.revoked_at ?? null)
    if (impRevokedMs !== null && impRevokedMs > issuedAtMs) return true
  }

  return false
}

