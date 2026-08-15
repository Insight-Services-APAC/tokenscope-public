// @vitest-environment node
/*
 * Wave-V persona-override triple-gate + JIT teammate + stop-impersonating.
 *
 * The gate is a pure function (server/auth/persona-override.ts) — tested
 * directly. The end-to-end handler invocations exercise the audit-row
 * shape, session impersonator stamps, and the stop-impersonating restore
 * flow against a testcontainers Postgres.
 *
 * Pattern follows tests/integration/inbox/endpoints.test.ts: direct
 * handler invocation against a mocked h3 event, with a real DB. Avoids
 * the cost of booting full Nitro.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { evaluatePersonaGate } from '../../../server/auth/persona-override'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

let t: TestDb
let regionId: string
let orgUnitId: string
let lenaId: string
let priyaId: string
let nonDemoId: string
const LENA_OID = 'oid-lena-wave-v'
const PRIYA_OID = 'oid-priya-wave-v'

beforeAll(async () => {
  process.env.NUXT_SESSION_SECRET = 'wave-v-test-padded-to-thirty-two-chars-or-more'
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  // Reset getDb()'s module-level cache so it reconnects to our
  // testcontainer rather than a previously-cached postgres client. The
  // getDb() module is a singleton; we use vi.resetModules() so the
  // next import is fresh and respects DATABASE_URL set above.
  vi.resetModules()

  // Seed: APAC region + BU + lena (admin via bootstrap email later) +
  // priya (developer).
  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-v', displayName: 'APAC' })
    .returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'apac.svc',
      code: 'svc',
      displayName: 'Services',
      unitType: 'bu',
    })
    .returning()
  orgUnitId = bu!.id

  // Personas referenced by DEMO_PERSONAS — the dev-login handler resolves
  // by email, so they must exist in the test DB. Each persona's role is
  // pinned to mirror the PERSONAS table in shared/auth/roles.ts so the
  // stop-impersonating restore (which now reads adminRow.role per
  // migration 0005) returns the right value.
  for (const seed of [
    { email: 'demo-priya.iyer@example.com', oid: PRIYA_OID, name: 'Priya Iyer', role: 'developer' },
    { email: 'demo-anil.verma@example.com', oid: 'oid-anil-wave-v', name: 'Anil Verma', role: 'manager' },
    { email: 'demo-lena.park@example.com', oid: LENA_OID, name: 'Lena Park', role: 'admin' },
    {
      email: 'demo-mara.holloway@example.com',
      oid: 'oid-mara-wave-v',
      name: 'Mara Holloway',
      role: 'global-finops',
    },
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
    if (seed.email === 'demo-lena.park@example.com') lenaId = row!.id
    if (seed.email === 'demo-priya.iyer@example.com') priyaId = row!.id
  }

  // A regular, NON-demo teammate — the DEMO_PERSONAS target check's
  // negative case. The dev-login handler can never mint an override
  // naming this teammate (getPersona() only accepts DEMO_PERSONAS keys),
  // so a cookie naming it can only exist via a hand-mint (HMAC secret
  // exfiltration or a future code path bug) — resolvePersonaTarget must
  // refuse it regardless of which caller reaches it.
  const [nonDemoRow] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-non-demo-wave-v',
      email: 'regular.dev@example.com',
      displayName: 'Regular Dev',
      role: 'developer',
      regionId,
      orgUnitId,
    })
    .returning()
  nonDemoId = nonDemoRow!.id
})

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(() => {
  // Each test owns its env-var matrix — clear between cases so a
  // previous test's setting doesn't leak through.
  delete process.env.NUXT_OIDC_AUTH_DEV_MODE
  delete process.env.NUXT_ALLOW_PERSONA_OVERRIDE
  delete process.env.NUXT_BOOTSTRAP_ADMIN_EMAIL
  // R1 F1 (Dev bicep): the gate now reads NUXT_DEPLOY_ENV, not NODE_ENV.
  // Tests clear it per-case; individual "in production" tests set it.
  delete process.env.NUXT_DEPLOY_ENV
  process.env.NODE_ENV = 'test'
})

// ── Pure-gate decisions (allowlist) ──────────────────────────────
describe('evaluatePersonaGate — allowlist decisions', () => {
  it('dev-mode (a), no caller, demo-capable → allowed/dev', () => {
    const v = evaluatePersonaGate(
      { devMode: true, allowOverride: false, demoCapable: true },
      null,
    )
    expect(v).toEqual({ allowed: true, mode: 'dev' })
  })

  it('dev-mode (a), with caller, demo-capable → allowed/dev (dev-mode covers it)', () => {
    const v = evaluatePersonaGate(
      { devMode: true, allowOverride: false, demoCapable: true },
      { role: 'developer', teammateId: 'x' },
    )
    expect(v).toEqual({ allowed: true, mode: 'dev' })
  })

  // THE headline security property: the structural floor refuses BEFORE any flag
  // or caller role — even with devMode AND override AND an admin caller, a
  // non-demo-capable env (dev/staging/prod/unknown) cannot impersonate.
  it('env NOT demo-capable → refused 404 even with devMode+override+admin (structural floor)', () => {
    const v = evaluatePersonaGate(
      { devMode: true, allowOverride: true, demoCapable: false },
      { role: 'admin', teammateId: 'x' },
    )
    expect(v).toEqual({ allowed: false, status: 404, reason: 'env-not-demo-capable' })
  })

  it('env NOT demo-capable, override+admin → refused 404 env-not-demo-capable', () => {
    const v = evaluatePersonaGate(
      { devMode: false, allowOverride: true, demoCapable: false },
      { role: 'admin', teammateId: 'x' },
    )
    expect(v).toEqual({ allowed: false, status: 404, reason: 'env-not-demo-capable' })
  })

  it('demo-capable, override flag off, admin caller → refused 404 (no signal leak)', () => {
    const v = evaluatePersonaGate(
      { devMode: false, allowOverride: false, demoCapable: true },
      { role: 'admin', teammateId: 'x' },
    )
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.status).toBe(404)
      expect(v.reason).toBe('override-disabled')
    }
  })

  it('demo-capable, override flag on, no session → refused 401', () => {
    const v = evaluatePersonaGate(
      { devMode: false, allowOverride: true, demoCapable: true },
      null,
    )
    expect(v.allowed).toBe(false)
    if (!v.allowed) expect(v.status).toBe(401)
  })

  it('demo-capable, override flag on, developer session → refused 403', () => {
    const v = evaluatePersonaGate(
      { devMode: false, allowOverride: true, demoCapable: true },
      { role: 'developer', teammateId: 'x' },
    )
    expect(v.allowed).toBe(false)
    if (!v.allowed) expect(v.status).toBe(403)
  })

  it('demo-capable, override flag on, admin session → allowed/override', () => {
    const v = evaluatePersonaGate(
      { devMode: false, allowOverride: true, demoCapable: true },
      { role: 'admin', teammateId: 'x' },
    )
    expect(v).toEqual({ allowed: true, mode: 'override' })
  })

  it('demo-capable, override flag on, global-finops session → allowed/override', () => {
    const v = evaluatePersonaGate(
      { devMode: false, allowOverride: true, demoCapable: true },
      { role: 'global-finops', teammateId: 'x' },
    )
    expect(v).toEqual({ allowed: true, mode: 'override' })
  })
})

// ── The SECOND enforcement point: tryAuth/resolveSession READS the override cookie
//    ONLY on a demo-capable env. A valid, correctly-signed cookie is INERT on
//    dev/staging/production/unknown even with NUXT_ALLOW_PERSONA_OVERRIDE=true. This
//    guards the exact regression channel the security review flagged. ─────────────
describe('persona-override cookie READ is env-gated (the cookie-read enforcement point)', () => {
  function overrideEvent() {
    const cookies = new Map<string, string>()
    return {
      context: {} as Record<string, unknown>,
      node: {
        req: {
          method: 'GET',
          url: '/api/v1/auth/me',
          get headers() {
            const cookie = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
            return { host: 'localhost:3450', cookie }
          },
        },
        res: {
          _headers: {} as Record<string, string | string[]>,
          statusCode: 200,
          getHeader(n: string) { return this._headers[n.toLowerCase()] },
          setHeader(n: string, v: string | string[]) {
            this._headers[n.toLowerCase()] = v
            if (n.toLowerCase() === 'set-cookie') {
              for (const item of (Array.isArray(v) ? v : [v])) {
                const [pair] = item.split(';')
                const eq = pair!.indexOf('=')
                cookies.set(pair!.slice(0, eq), pair!.slice(eq + 1))
              }
            }
          },
          removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
          appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
          get headersSent() { return false },
        },
      },
    }
  }

  /** Build an event carrying a VALID override cookie that targets priya. */
  async function eventWithValidOverrideCookie() {
    return eventWithOverrideCookieFor(priyaId)
  }

  /** Build an event carrying a VALID (properly HMAC-signed) override cookie
   *  naming an ARBITRARY target teammate — used to probe resolvePersonaTarget's
   *  DEMO_PERSONAS check independent of the cookie's own tamper-detection. */
  async function eventWithOverrideCookieFor(targetTeammateId: string) {
    const ev = overrideEvent()
    const { setPersonaOverrideCookie } = await import('../../../server/utils/persona-override-cookie')
    setPersonaOverrideCookie(ev as unknown as Parameters<typeof setPersonaOverrideCookie>[0], {
      targetTeammateId,
      issuedAt: '2026-05-25T00:00:00Z',
      impersonatorOid: LENA_OID,
      impersonatorEmail: 'demo-lena.park@example.com',
    })
    return ev
  }

  /**
   * Run `fn` with getUserSession (nuxt-oidc-auth's session reader) mocked to
   * return a fabricated OIDC session carrying `claims` — the ONLY way to
   * reach `resolveSession`'s "Normal path" (server/utils/auth.ts:155-211)
   * and therefore `applyPersonaOverride`. Every OTHER integration test in
   * this repo bypasses OIDC entirely via injectTestSession(), which
   * pre-populates tryAuth's per-event cache before resolveSession ever
   * runs — so applyPersonaOverride has no prior test coverage at all.
   * Restores the project's default stub (tests/helpers/nuxt-oidc-auth-stub.ts,
   * aliased in vitest.config.ts) afterwards so later tests keep the
   * "no OIDC session" baseline they're written against.
   */
  async function withMockedOidcSession<T>(
    claims: { oid: string; email: string; name?: string },
    fn: (authModule: typeof import('../../../server/utils/auth')) => Promise<T>,
  ): Promise<T> {
    vi.doMock('nuxt-oidc-auth/runtime/server/utils/session.js', () => ({
      getUserSession: async () => ({
        loggedInAt: Math.floor(Date.now() / 1000),
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

  it('demo-capable (local) + dev-mode + override flag → cookie IS honored (the seam still works)', async () => {
    process.env.NUXT_OIDC_AUTH_DEV_MODE = 'true'
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    // No NUXT_DEPLOY_ENV + NODE_ENV=test → 'local' → demo-capable.
    const { tryAuth } = await import('../../../server/utils/auth')
    const ev = await eventWithValidOverrideCookie()
    const session = await tryAuth(ev as never)
    expect(session?.teammateId).toBe(priyaId)
    expect(session?.impersonatorEmail).toBe('demo-lena.park@example.com')
  })

  it.each(['dev', 'staging', 'production'])(
    'deployed env (NUXT_DEPLOY_ENV=%s) + dev-mode + override flag → cookie is INERT (never the persona)',
    async (deployEnv) => {
      process.env.NUXT_DEPLOY_ENV = deployEnv
      process.env.NUXT_OIDC_AUTH_DEV_MODE = 'true'
      process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
      const { tryAuth } = await import('../../../server/utils/auth')
      const ev = await eventWithValidOverrideCookie()
      let session: { teammateId?: string } | null = null
      try {
        session = (await tryAuth(ev as never)) as { teammateId?: string } | null
      } catch {
        // No OIDC fallback in the harness → unauthenticated (correct); `session` stays null.
      }
      expect(session?.teammateId).not.toBe(priyaId)
    },
  )

  it('DROPPED NUXT_DEPLOY_ENV on a deployed container (NODE_ENV=production) → cookie INERT (fail closed)', async () => {
    delete process.env.NUXT_DEPLOY_ENV
    process.env.NODE_ENV = 'production'
    process.env.NUXT_OIDC_AUTH_DEV_MODE = 'true'
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    const { tryAuth } = await import('../../../server/utils/auth')
    const ev = await eventWithValidOverrideCookie()
    let session: { teammateId?: string } | null = null
    try {
      session = (await tryAuth(ev as never)) as { teammateId?: string } | null
    } catch {
      // Fail-closed: unauthenticated on error; `session` stays null.
    }
    expect(session?.teammateId).not.toBe(priyaId)
  })

  // ── The "missing DEMO_PERSONAS target check" defect (resolvePersonaTarget
  //    extraction, server/utils/auth.ts) — assert BOTH callers ────────────
  it('demo-capable (local) + dev-mode + override flag → a hand-minted cookie naming a NON-demo teammate resolves to null (resolveFromOverrideOnly caller)', async () => {
    process.env.NUXT_OIDC_AUTH_DEV_MODE = 'true'
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    const { tryAuth } = await import('../../../server/utils/auth')
    const ev = await eventWithOverrideCookieFor(nonDemoId)
    const session = await tryAuth(ev as never)
    expect(session).toBeNull()
  })

  it('demo-capable (local) + dev-mode + override flag → the same cookie shape naming a DEMO_PERSONAS teammate still resolves (resolveFromOverrideOnly caller)', async () => {
    process.env.NUXT_OIDC_AUTH_DEV_MODE = 'true'
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    const { tryAuth } = await import('../../../server/utils/auth')
    const ev = await eventWithOverrideCookieFor(priyaId)
    const session = await tryAuth(ev as never)
    expect(session?.teammateId).toBe(priyaId)
  })

  it('non-dev-mode (real OIDC) + override flag → a hand-minted cookie naming a NON-demo teammate resolves to null (applyPersonaOverride caller: the impersonator falls back to their own identity, no impersonation stamp)', async () => {
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    // NUXT_OIDC_AUTH_DEV_MODE stays unset (beforeEach clears it) → devMode
    // is false → resolveSession takes the "Normal path" (real OIDC
    // required), which is what reaches applyPersonaOverride rather than
    // resolveFromOverrideOnly.
    const session = await withMockedOidcSession(
      { oid: LENA_OID, email: 'demo-lena.park@example.com', name: 'Lena Park' },
      async ({ tryAuth }) => {
        const ev = await eventWithOverrideCookieFor(nonDemoId)
        return tryAuth(ev as never)
      },
    )
    expect(session?.teammateId).toBe(lenaId)
    expect(session?.impersonatorEmail).toBeUndefined()
  })

  it('non-dev-mode (real OIDC) + override flag → the same cookie shape naming a DEMO_PERSONAS teammate still resolves (applyPersonaOverride caller, unaffected by the resolvePersonaTarget extraction)', async () => {
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    const session = await withMockedOidcSession(
      { oid: LENA_OID, email: 'demo-lena.park@example.com', name: 'Lena Park' },
      async ({ tryAuth }) => {
        const ev = await eventWithOverrideCookieFor(priyaId)
        return tryAuth(ev as never)
      },
    )
    expect(session?.teammateId).toBe(priyaId)
    expect(session?.impersonatorEmail).toBe('demo-lena.park@example.com')
  })
})

// ── End-to-end audit + session shape ──────────────────────────────
describe('persona override — audit + session impersonator stamp', () => {
  // We invoke the handler directly. The handler imports getDb() — vi.resetModules()
  // in beforeAll ensures the next `await import(...)` reads our env vars.
  async function loadHandler() {
    return (
      await import('../../../server/api/v1/auth/dev-login.post')
    ).default as (event: unknown) => Promise<unknown>
  }

  function makeEvent(initialSession?: Session, body: Record<string, unknown> = { persona: 'developer' }) {
    const cookies = new Map<string, string>()
    // No Origin / Referer header — checkOriginPolicy treats this as a
    // CLI / server-to-server call (allowed). The pure CSRF logic is
    // covered by tests/integration/auth/csrf.test.ts; this test focuses
    // on the gate + audit + session shape.
    const headers: Record<string, string> = { host: 'localhost:3450' }
    const ev = {
      cookies,
      method: 'POST',
      path: '/api/v1/auth/dev-login',
      // h3 helpers reach into node.req.headers / node.res — copy the
      // shape used in tests/integration/auth/session.test.ts.
      node: {
        req: {
          method: 'POST',
          url: '/api/v1/auth/dev-login',
          // h3's readRawBody picks up `body` on the node req when it
          // looks like a plain Object (line ~401 in h3/dist/index.mjs:
          // `if (_resolved.constructor === Object) return Buffer.from(
          // JSON.stringify(_resolved))`. We thread the test body
          // through that path so the handler's readValidatedBody resolves.
          body,
          get headers() {
            const cookieHeader = Array.from(cookies.entries())
              .map(([k, v]) => `${k}=${v}`)
              .join('; ')
            return { ...headers, cookie: cookieHeader, 'content-type': 'application/json' }
          },
        },
        res: {
          _headers: {} as Record<string, string | string[]>,
          statusCode: 200,
          getHeader(name: string) {
            return this._headers[name.toLowerCase()]
          },
          setHeader(name: string, value: string | string[]) {
            this._headers[name.toLowerCase()] = value
            if (name.toLowerCase() === 'set-cookie') {
              const items = Array.isArray(value) ? value : [value]
              for (const item of items) {
                const [pair] = item.split(';')
                const eq = pair!.indexOf('=')
                const k = pair!.slice(0, eq)
                const v = pair!.slice(eq + 1)
                if (v === '' && item.includes('Max-Age=0')) cookies.delete(k)
                else cookies.set(k, v)
              }
            }
          },
          removeHeader(name: string) {
            this._headers[name.toLowerCase()] = ''
          },
          appendHeader(name: string, value: string | string[]) {
            const incoming = Array.isArray(value) ? value : [value]
            if (name.toLowerCase() === 'set-cookie') {
              for (const item of incoming) {
                const [pair] = item.split(';')
                const eq = pair!.indexOf('=')
                const k = pair!.slice(0, eq)
                const v = pair!.slice(eq + 1)
                if (v === '' && item.includes('Max-Age=0')) cookies.delete(k)
                else cookies.set(k, v)
              }
            }
            const existing = this._headers[name.toLowerCase()]
            this._headers[name.toLowerCase()] = existing
              ? (Array.isArray(existing) ? existing : [existing]).concat(incoming)
              : incoming
          },
          get headersSent() {
            return false
          },
        },
      },
    }
    if (initialSession) {
      injectTestSession(ev as unknown as Parameters<typeof injectTestSession>[0], initialSession)
    }
    return ev
  }

  beforeEach(() => {
    // Wipe audit rows between cases — assertions count rows by event_type.
    return t.db.execute(sql`TRUNCATE TABLE audit_event RESTART IDENTITY CASCADE`)
  })

  it('dev-mode, no caller → /dev-login allowed; audit row eventType=dev-login', async () => {
    process.env.NUXT_OIDC_AUTH_DEV_MODE = 'true'
    const handler = await loadHandler()
    const ev = makeEvent(undefined, { persona: 'developer' })

    const result = await handler(ev as never)
    expect(result).toMatchObject({ authenticated: true, role: 'developer' })

    const rows = await t.client<{ event_type: string; payload: { mode?: string } }[]>`
      SELECT event_type, payload FROM audit_event WHERE event_type = 'dev-login'
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.payload.mode).toBe('dev')
  })

  it('override flag on, admin caller → /dev-login allowed; audit row eventType=persona-impersonation', async () => {
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    const handler = await loadHandler()
    const adminSession: Session = {
      teammateId: lenaId,
      email: 'demo-lena.park@example.com',
      displayName: 'Lena Park',
      role: 'admin',
      regionId,
      orgPath: 'apac.svc',
    }
    const ev = makeEvent(adminSession, { persona: 'developer' })

    const result = await handler(ev as never)
    expect(result).toMatchObject({ authenticated: true, role: 'developer' })

    const rows = await t.client<{
      event_type: string
      actor_teammate_id: string | null
      subject_id: string | null
      payload: {
        actualOid?: string
        actualEmail?: string
        personaKey?: string
        personaEmail?: string
        personaRole?: string
        env?: string
      }
    }[]>`
      SELECT event_type, actor_teammate_id::text AS actor_teammate_id,
             subject_id::text AS subject_id, payload
      FROM audit_event WHERE event_type = 'persona-impersonation'
    `
    expect(rows.length).toBe(1)
    const audit = rows[0]!
    expect(audit.actor_teammate_id).toBe(lenaId)
    expect(audit.subject_id).toBe(priyaId)
    expect(audit.payload.actualOid).toBe(LENA_OID)
    expect(audit.payload.actualEmail).toBe('demo-lena.park@example.com')
    expect(audit.payload.personaKey).toBe('developer')
    expect(audit.payload.personaEmail).toBe('demo-priya.iyer@example.com')
    expect(audit.payload.personaRole).toBe('developer')
  })

  it('override flag on, global-finops caller → /dev-login allowed; stop-impersonating restores global-finops (not admin)', async () => {
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    const handler = await loadHandler()
    const MARA_OID = 'oid-mara-wave-v'
    const financeSession: Session = {
      teammateId: '', // resolved below
      email: 'demo-mara.holloway@example.com',
      displayName: 'Mara Holloway',
      role: 'global-finops',
      regionId,
      orgPath: 'apac.svc',
    }
    // Look up Mara's teammate id.
    const maraRows = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM teammate WHERE entra_oid = ${MARA_OID}
    `
    financeSession.teammateId = maraRows[0]!.id

    const ev = makeEvent(financeSession, { persona: 'developer' })
    const result = (await handler(ev as never)) as { authenticated: boolean; role: string }
    expect(result).toMatchObject({ authenticated: true, role: 'developer' })

    // The sidecar override cookie now carries the global-finops admin's
    // impersonator stamp. R1 F6 (real-admin role inferred, not hardcoded
    // 'admin') is now enforced at the OIDC layer — when stop-impersonating
    // clears the sidecar, tryAuth() falls back to the OIDC identity, and
    // tryAuth resolves the admin's actual role from the teammate row.
    // We verify (a) the audit row carries the global-finops stamp, and
    // (b) the sidecar cookie was cleared (Set-Cookie Max-Age=0).
    const {
      readPersonaOverrideCookie,
    } = await import('../../../server/utils/persona-override-cookie')
    const overridePayload = readPersonaOverrideCookie(
      ev as unknown as Parameters<typeof readPersonaOverrideCookie>[0],
    )
    expect(overridePayload!.impersonatorEmail).toBe('demo-mara.holloway@example.com')

    const { default: stopHandler } = await import(
      '../../../server/api/v1/auth/stop-impersonating.post'
    )
    // Reconstruct event for the stop call carrying the just-minted
    // impersonation session so tryAuth() picks it up via context.
    const stopEv = makeEvent(
      {
        teammateId: priyaId,
        email: 'demo-priya.iyer@example.com',
        displayName: 'Priya Iyer',
        role: 'developer',
        regionId,
        orgPath: 'apac.svc',
        impersonatorOid: MARA_OID,
        impersonatorEmail: 'demo-mara.holloway@example.com',
        impersonatedAt: '2026-05-25T00:00:00Z',
      },
      undefined,
    )
    await stopHandler(stopEv as never)

    const auditEnd = await t.client<{ payload: { actualEmail?: string } }[]>`
      SELECT payload FROM audit_event WHERE event_type = 'persona-impersonation-end'
    `
    expect(auditEnd.length).toBe(1)
    expect(auditEnd[0]!.payload.actualEmail).toBe('demo-mara.holloway@example.com')
    // Sidecar cookie cleared (Max-Age=0 captured by the mock setHeader).
    expect(stopEv.cookies.has('ts_persona_override')).toBe(false)
  })

  it('override flag on, developer caller → /dev-login refused 403', async () => {
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    const handler = await loadHandler()
    const devSession: Session = {
      teammateId: priyaId,
      email: 'demo-priya.iyer@example.com',
      displayName: 'Priya Iyer',
      role: 'developer',
      regionId,
      orgPath: 'apac.svc',
    }
    const ev = makeEvent(devSession, { persona: 'admin' })

    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('override flag on, no caller → /dev-login refused 401', async () => {
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    const handler = await loadHandler()
    const ev = makeEvent(undefined, { persona: 'admin' })

    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('override flag off, admin caller → /dev-login refused 404', async () => {
    // NUXT_ALLOW_PERSONA_OVERRIDE unset (= false equivalent)
    const handler = await loadHandler()
    const adminSession: Session = {
      teammateId: lenaId,
      email: 'demo-lena.park@example.com',
      displayName: 'Lena Park',
      role: 'admin',
      regionId,
      orgPath: 'apac.svc',
    }
    const ev = makeEvent(adminSession, { persona: 'developer' })

    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  // ── Allowlist floor at the handler: a DEPLOYED env refuses regardless of flags ──
  it('deployed env (NUXT_DEPLOY_ENV=dev) + override flag ON + admin caller → refused 404 (structural floor)', async () => {
    process.env.NUXT_DEPLOY_ENV = 'dev'
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    const handler = await loadHandler()
    const adminSession: Session = {
      teammateId: lenaId,
      email: 'demo-lena.park@example.com',
      displayName: 'Lena Park',
      role: 'admin',
      regionId,
      orgPath: 'apac.svc',
    }
    const ev = makeEvent(adminSession, { persona: 'developer' })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('deployed env (NUXT_DEPLOY_ENV=dev) + dev-mode flag ON → refused 404 (DEV_MODE cannot unlock a pilot-prod)', async () => {
    process.env.NUXT_DEPLOY_ENV = 'dev'
    process.env.NUXT_OIDC_AUTH_DEV_MODE = 'true'
    const handler = await loadHandler()
    const ev = makeEvent(undefined, { persona: 'developer' })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('DROPPED NUXT_DEPLOY_ENV on a deployed container (NODE_ENV=production) → refused 404 (fail closed, not local)', async () => {
    delete process.env.NUXT_DEPLOY_ENV
    process.env.NODE_ENV = 'production'
    process.env.NUXT_ALLOW_PERSONA_OVERRIDE = 'true'
    const handler = await loadHandler()
    const adminSession: Session = {
      teammateId: lenaId,
      email: 'demo-lena.park@example.com',
      displayName: 'Lena Park',
      role: 'admin',
      regionId,
      orgPath: 'apac.svc',
    }
    const ev = makeEvent(adminSession, { persona: 'developer' })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 404 })
  })
})

// ── stop-impersonating ────────────────────────────────────────────
describe('POST /api/v1/auth/stop-impersonating', () => {
  async function loadStopHandler() {
    return (
      await import('../../../server/api/v1/auth/stop-impersonating.post')
    ).default as (event: unknown) => Promise<unknown>
  }

  function makeEvent(initialSession?: Session) {
    const cookies = new Map<string, string>()
    const headers: Record<string, string> = { host: 'localhost:3450' }
    const ev = {
      cookies,
      method: 'POST',
      path: '/api/v1/auth/stop-impersonating',
      node: {
        req: {
          method: 'POST',
          url: '/api/v1/auth/stop-impersonating',
          get headers() {
            const cookieHeader = Array.from(cookies.entries())
              .map(([k, v]) => `${k}=${v}`)
              .join('; ')
            return { ...headers, cookie: cookieHeader }
          },
        },
        res: {
          _headers: {} as Record<string, string | string[]>,
          statusCode: 200,
          getHeader(name: string) {
            return this._headers[name.toLowerCase()]
          },
          setHeader(name: string, value: string | string[]) {
            this._headers[name.toLowerCase()] = value
            if (name.toLowerCase() === 'set-cookie') {
              const items = Array.isArray(value) ? value : [value]
              for (const item of items) {
                const [pair] = item.split(';')
                const eq = pair!.indexOf('=')
                const k = pair!.slice(0, eq)
                const v = pair!.slice(eq + 1)
                if (v === '' && item.includes('Max-Age=0')) cookies.delete(k)
                else cookies.set(k, v)
              }
            }
          },
          removeHeader(name: string) {
            this._headers[name.toLowerCase()] = ''
          },
          appendHeader(name: string, value: string | string[]) {
            const incoming = Array.isArray(value) ? value : [value]
            if (name.toLowerCase() === 'set-cookie') {
              for (const item of incoming) {
                const [pair] = item.split(';')
                const eq = pair!.indexOf('=')
                const k = pair!.slice(0, eq)
                const v = pair!.slice(eq + 1)
                if (v === '' && item.includes('Max-Age=0')) cookies.delete(k)
                else cookies.set(k, v)
              }
            }
            const existing = this._headers[name.toLowerCase()]
            this._headers[name.toLowerCase()] = existing
              ? (Array.isArray(existing) ? existing : [existing]).concat(incoming)
              : incoming
          },
          get headersSent() {
            return false
          },
        },
      },
    }
    if (initialSession) {
      injectTestSession(ev as unknown as Parameters<typeof injectTestSession>[0], initialSession)
    }
    return ev
  }

  beforeEach(() => {
    return t.db.execute(sql`TRUNCATE TABLE audit_event RESTART IDENTITY CASCADE`)
  })

  it('clears the override sidecar when impersonator fields are set', async () => {
    const handler = await loadStopHandler()
    const impersonatingSession: Session = {
      teammateId: priyaId,
      email: 'demo-priya.iyer@example.com',
      displayName: 'Priya Iyer',
      role: 'developer',
      regionId,
      orgPath: 'apac.svc',
      impersonatorOid: LENA_OID,
      impersonatorEmail: 'demo-lena.park@example.com',
      impersonatedAt: '2026-05-25T00:00:00Z',
      issuedAt: '2026-05-25T00:00:00Z',
    }
    const ev = makeEvent(impersonatingSession)
    // Seed the override sidecar so the handler has something to clear.
    const {
      setPersonaOverrideCookie,
      readPersonaOverrideCookie,
    } = await import('../../../server/utils/persona-override-cookie')
    setPersonaOverrideCookie(
      ev as unknown as Parameters<typeof setPersonaOverrideCookie>[0],
      {
        targetTeammateId: priyaId,
        issuedAt: '2026-05-25T00:00:00Z',
        impersonatorOid: LENA_OID,
        impersonatorEmail: 'demo-lena.park@example.com',
      },
    )
    const result = (await handler(ev as never)) as { ok: boolean; landing: string }
    expect(result.ok).toBe(true)
    expect(result.landing).toBe('/admin')

    // Audit row records the stop event with the real admin's identity.
    const rows = await t.client<{ event_type: string; payload: { actualEmail?: string } }[]>`
      SELECT event_type, payload FROM audit_event WHERE event_type = 'persona-impersonation-end'
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.payload.actualEmail).toBe('demo-lena.park@example.com')

    // Sidecar cookie cleared — Option C: tryAuth() falls back to the OIDC
    // identity on the next request, which IS the real admin.
    expect(
      readPersonaOverrideCookie(
        ev as unknown as Parameters<typeof readPersonaOverrideCookie>[0],
      ),
    ).toBeNull()
  })

  it('refuses 400 when session has no impersonator fields', async () => {
    const handler = await loadStopHandler()
    const adminSession: Session = {
      teammateId: lenaId,
      email: 'demo-lena.park@example.com',
      displayName: 'Lena Park',
      role: 'admin',
      regionId,
      orgPath: 'apac.svc',
    }
    const ev = makeEvent(adminSession)
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('refuses 401 when no session at all', async () => {
    const handler = await loadStopHandler()
    const ev = makeEvent(undefined)
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 401 })
  })
})

// ── JIT teammate creator ──────────────────────────────────────────
describe('JIT teammate creator (resolveOrCreateTeammate)', () => {
  beforeEach(async () => {
    delete process.env.NUXT_BOOTSTRAP_ADMIN_EMAIL
    await t.client`DELETE FROM directory_exclusion_pattern`
    await t.db.execute(sql`TRUNCATE TABLE audit_event RESTART IDENTITY CASCADE`)
  })

  it('returns existing teammate when entra_oid already in DB', async () => {
    const { resolveOrCreateTeammate } = await import('../../../server/auth/jit-teammate')
    const result = await resolveOrCreateTeammate(t.db, {
      oid: LENA_OID,
      email: 'demo-lena.park@example.com',
      name: 'Lena Park',
    })
    expect(result.created).toBe(false)
    expect(result.teammateId).toBe(lenaId)
    expect(result.email).toBe('demo-lena.park@example.com')
  })

  it('JIT-creates with `developer` role for non-bootstrap emails', async () => {
    const { resolveOrCreateTeammate } = await import('../../../server/auth/jit-teammate')
    const result = await resolveOrCreateTeammate(t.db, {
      oid: 'oid-new-dev-wave-v',
      email: 'new.dev@example.com',
      name: 'New Dev',
    })
    expect(result.created).toBe(true)
    expect(result.role).toBe('developer')

    const auditRows = await t.client<{ event_type: string; payload: { bootstrapMatch?: boolean } }[]>`
      SELECT event_type, payload FROM audit_event WHERE event_type = 'teammate-jit-created'
    `
    expect(auditRows.length).toBe(1)
    expect(auditRows[0]!.payload.bootstrapMatch).toBe(false)
    // Note: we leave the JIT'd teammate row in place. Each JIT test
    // uses a unique entra_oid, so we avoid the audit_event → teammate
    // FK constraint that would block a cleanup DELETE.
  })

  it('JIT-creates with `platform-admin` role when email matches NUXT_BOOTSTRAP_ADMIN_EMAIL', async () => {
    process.env.NUXT_BOOTSTRAP_ADMIN_EMAIL = 'Bootstrap.Admin@example.com'
    const { resolveOrCreateTeammate } = await import('../../../server/auth/jit-teammate')
    const result = await resolveOrCreateTeammate(t.db, {
      oid: 'oid-bootstrap-wave-v',
      email: 'bootstrap.admin@example.com', // case-insensitive match
      name: 'Bootstrap Admin',
    })
    expect(result.created).toBe(true)
    expect(result.role).toBe('platform-admin')

    const auditRows = await t.client<{ payload: { bootstrapMatch?: boolean } }[]>`
      SELECT payload FROM audit_event WHERE event_type = 'teammate-jit-created'
    `
    expect(auditRows[0]!.payload.bootstrapMatch).toBe(true)
  })

  it('#121: REFUSES first sign-in of a privileged (excluded UPN) account — no teammate created', async () => {
    await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES ('*@contoso.onmicrosoft.com')`
    const { resolveOrCreateTeammate } = await import('../../../server/auth/jit-teammate')
    await expect(
      resolveOrCreateTeammate(t.db, {
        oid: 'oid-cld-excluded',
        email: 'rtanaka-cld@contoso.onmicrosoft.com',
        name: 'Rio CLD',
        upn: 'rtanaka-cld@contoso.onmicrosoft.com',
      }),
    ).rejects.toMatchObject({ statusCode: 403, statusMessage: 'Excluded identity' })
    const [n] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM teammate WHERE entra_oid = 'oid-cld-excluded'`
    expect(n!.n).toBe('0')
    const [audit] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_event WHERE event_type = 'teammate-jit-excluded'`
    expect(audit!.n).toBe('1')
  })

  it('#121: BLOCKS the bootstrap-admin escalation for a privileged account (refused before role resolution)', async () => {
    process.env.NUXT_BOOTSTRAP_ADMIN_EMAIL = 'priv.admin@contoso.onmicrosoft.com'
    await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES ('*@contoso.onmicrosoft.com')`
    const { resolveOrCreateTeammate } = await import('../../../server/auth/jit-teammate')
    await expect(
      resolveOrCreateTeammate(t.db, {
        oid: 'oid-priv-bootstrap',
        email: 'priv.admin@contoso.onmicrosoft.com',
        upn: 'priv.admin@contoso.onmicrosoft.com',
      }),
    ).rejects.toMatchObject({ statusCode: 403 }) // never reaches the platform-admin mint
    const [n] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM teammate WHERE entra_oid = 'oid-priv-bootstrap'`
    expect(n!.n).toBe('0')
  })

  it('#121: FAIL-OPEN — with no pattern, an onmicrosoft account still JIT-creates', async () => {
    const { resolveOrCreateTeammate } = await import('../../../server/auth/jit-teammate')
    const result = await resolveOrCreateTeammate(t.db, {
      oid: 'oid-onmicro-nopat',
      email: 'kwong@contoso.onmicrosoft.com',
      upn: 'kwong@contoso.onmicrosoft.com',
    })
    expect(result.created).toBe(true)
  })

  it('#121: the hot fast-path is NOT gated — an existing teammate whose UPN would match still signs in', async () => {
    // A legacy privileged row not yet retired by the cleanup worker keeps working
    // until is_active is flipped; the guard only blocks NEW teammate creation.
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
      VALUES ('oid-legacy-cld', 'legacy-cld@contoso.onmicrosoft.com', 'Legacy', ${regionId}::uuid, ${orgUnitId}::uuid, 'developer', 'directory')`
    await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES ('*@contoso.onmicrosoft.com')`
    const { resolveOrCreateTeammate } = await import('../../../server/auth/jit-teammate')
    const result = await resolveOrCreateTeammate(t.db, {
      oid: 'oid-legacy-cld',
      email: 'legacy-cld@contoso.onmicrosoft.com',
      upn: 'legacy-cld@contoso.onmicrosoft.com',
    })
    expect(result.created).toBe(false) // fast-path returned it, no exclusion query
  })
})

describe('POST /api/v1/oauth/authorize refuses an assumed identity', () => {
  // An OAuth consent mints a teammate-bound auth code that a client exchanges
  // for a durable access/refresh token. Granting one while impersonating would
  // hand the impersonator a credential that outlives the impersonation and
  // carries the impersonated teammate's identity. This is a GUARD-RAIL: the
  // persona override is double-gated ({local, sandbox} + NUXT_ALLOW_PERSONA_
  // OVERRIDE) and cannot fire on dev, the only environment that authenticates.
  // These assertions hold the property if that ever changes.
  const REDIRECT_URI = 'http://127.0.0.1:57621/callback'
  let clientId: string

  beforeAll(async () => {
    // Only the APPROVE path needs this (issueAuthCode HMACs the code). The
    // refusal tests below pass without it — which is itself evidence the guard
    // short-circuits before any code is minted.
    process.env.NUXT_HMAC_SESSION_KEY = 'persona-guard-hmac-key-padded-well-beyond-32-chars'
    const [row] = await t.db
      .insert(schema.oauthClient)
      .values({
        clientSecretHash: 'not-used-on-this-path',
        clientName: 'Persona Guard Test Client',
        redirectUris: [REDIRECT_URI],
      })
      .returning()
    clientId = row!.clientId
  })

  async function loadAuthorizeHandler() {
    return (
      await import('../../../server/api/v1/oauth/authorize.post')
    ).default as (event: unknown) => Promise<unknown>
  }

  // No Origin header → assertSameOrigin treats this as a non-browser call and
  // allows it, so these assertions isolate the impersonation guard. CSRF is
  // covered by tests/integration/auth/csrf.test.ts.
  function oauthEvent(session: Session) {
    const body = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      // A real S256 challenge shape (43-128 chars, base64url charset).
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      scope: 'tokenscope.read',
      state: 'persona-guard-state-0123456789',
      action: 'approve',
    }
    const headers: Record<string, string> = { host: 'localhost:3450' }
    const e = {
      method: 'POST',
      path: '/api/v1/oauth/authorize',
      context: { params: {} },
      node: {
        req: {
          method: 'POST',
          url: '/api/v1/oauth/authorize',
          body,
          socket: { remoteAddress: '127.0.0.1' },
          get headers() {
            return { ...headers, 'content-type': 'application/json' }
          },
        },
        res: {
          _headers: {} as Record<string, string | string[]>,
          _ended: false,
          statusCode: 200,
          getHeader(n: string) { return this._headers[n.toLowerCase()] },
          setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
          removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
          appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
          write() { return true },
          end() { this._ended = true; return this },
          get headersSent() { return this._ended },
        },
      },
    }
    injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
    return e
  }

  const normalSession = (): Session =>
    ({
      teammateId: priyaId,
      email: 'demo-priya.iyer@example.com',
      displayName: 'Priya Iyer',
      role: 'developer',
      regionId,
      orgPath: 'apac.svc',
    }) as Session

  const assumedSession = (): Session =>
    ({ ...normalSession(), impersonatorOid: LENA_OID }) as Session

  it('refuses with 403 access_denied when impersonatorOid is set', async () => {
    const handler = await loadAuthorizeHandler()
    const e = oauthEvent(assumedSession())
    const out = (await handler(e)) as { error: string; error_description: string }

    // 403, not 500 and not a redirect — a refusal the consent page can render.
    expect(e.node.res.statusCode).toBe(403)
    expect(out.error).toBe('access_denied')
    expect(out.error_description).toMatch(/acting as another user/i)
    // Fail-CLOSED: no redirect was issued, so no code can have leaked to the
    // client's redirect_uri.
    expect(e.node.res._headers['location']).toBeUndefined()
  })

  it('issues no auth code at all for the refused request', async () => {
    const before = await t.client`SELECT count(*)::int AS n FROM oauth_auth_code`
    const handler = await loadAuthorizeHandler()
    await handler(oauthEvent(assumedSession()))
    const after = await t.client`SELECT count(*)::int AS n FROM oauth_auth_code`
    expect(after[0]!.n).toBe(before[0]!.n)
  })

  it('still issues consent for a normal (non-impersonated) session', async () => {
    const handler = await loadAuthorizeHandler()
    const e = oauthEvent(normalSession())
    await handler(e)

    // 302 to the registered redirect_uri carrying a code — the guard is
    // specific to assumed identities and does not break the real flow.
    expect(e.node.res.statusCode).toBe(302)
    const loc = e.node.res._headers['location'] as string
    expect(loc).toBeTruthy()
    const u = new URL(loc)
    expect(u.searchParams.get('code')).toBeTruthy()
    expect(u.searchParams.get('state')).toBe('persona-guard-state-0123456789')
  })
})
