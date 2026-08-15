// @vitest-environment node
/*
 * The UPN claim reaches the JIT directory-exclusion guard (audit round 2, #2).
 *
 * THE DEFECT: extractClaims (server/utils/auth.ts) reads the UPN from three
 * sources — claims.preferred_username, claims.upn, userInfo.preferred_username
 * — and ALL THREE were permanently undefined, so the exclusion guard in
 * server/auth/jit-teammate.ts failed open on every single sign-in. The chain:
 *
 *   1. nuxt-oidc-auth populates `user.claims` STRICTLY from the provider's
 *      configured `optionalClaims`, against the ID token
 *      (dist/runtime/server/handler/callback.js — the loop this file
 *      reimplements verbatim below).
 *   2. nuxt.config.ts listed only ['oid', 'email', 'name'].
 *   3. `user.userInfo` is written only when `config.userInfoUrl` is set; we
 *      configure none. So the third source could never be populated either.
 *
 * `userNameClaim: 'preferred_username'` is NOT a fourth source for this: the
 * module reads it out of the ACCESS token, not the id token, and an Entra Graph
 * access token does not reliably carry preferred_username. The fixture below
 * models that faithfully (userName comes from a separate access-token object)
 * so a future "just read userName" shortcut cannot make this test pass.
 *
 * EXPOSURE TODAY IS NIL. Migration 0083 seeds ZERO exclusion patterns and
 * server/workers/privileged-identity-cleanup.ts returns early when there are
 * none, so the guard currently matches nobody whether or not it can see a UPN.
 * This test ARMS a control; it does not close a live hole. The test therefore
 * has to CONFIGURE a pattern before it can observe anything at all — which is
 * itself the proof of that claim.
 *
 * WHY THE FIXTURE IS BUILT, NOT HAND-WRITTEN: a hand-built
 * `{ claims: { preferred_username: 'x' } }` presupposes exactly the thing that
 * was broken. This file reads the REAL optionalClaims list out of nuxt.config.ts
 * and runs the REAL callback filter over a realistic Entra v2 id token, so
 * reverting the config change makes the fixture lose the claim on its own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'

let t: TestDb
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

beforeAll(async () => {
  process.env.NUXT_SESSION_SECRET = 'upn-claim-extraction-test-secret-32-chars!!'
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  vi.resetModules()

  await t.db.insert(schema.region).values({ code: 'upn', displayName: 'UPN Region' }).returning()
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

// ── the fixture, built from the real config + the real module behaviour ──────

/**
 * The `optionalClaims` array as nuxt.config.ts actually declares it. Parsed from
 * source rather than imported because importing nuxt.config.ts pulls in the
 * whole Nuxt module graph. This is the coupling that makes the test honest: if
 * the config loses 'preferred_username', this list loses it too.
 */
async function configuredOptionalClaims(): Promise<string[]> {
  const src = await readFile(join(REPO_ROOT, 'nuxt.config.ts'), 'utf8')
  const m = /optionalClaims:\s*\[([^\]]*)\]/.exec(src)
  if (!m) throw new Error('nuxt.config.ts: could not find an optionalClaims array')
  return m[1]!
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

/** Does nuxt.config.ts configure a userInfoUrl for entra? (It must not — the
 *  third UPN source in extractClaims depends on it and is dead without it.) */
async function configuresUserInfoUrl(): Promise<boolean> {
  const src = await readFile(join(REPO_ROOT, 'nuxt.config.ts'), 'utf8')
  return /userInfoUrl:/.test(src)
}

/**
 * Reproduce nuxt-oidc-auth's callback handler EXACTLY (see the header). Given a
 * decoded id token and access token, produce the `user` object that gets sealed
 * into the session cookie and later handed to extractClaims.
 */
function buildCallbackUserSession(opts: {
  idToken: Record<string, unknown>
  accessToken: Record<string, unknown>
  optionalClaims: string[]
  userNameClaim?: string
  userInfoUrl?: string
}) {
  const user: Record<string, unknown> = {
    canRefresh: true,
    loggedInAt: Math.trunc(Date.now() / 1000),
    updatedAt: Math.trunc(Date.now() / 1000),
    provider: 'entra',
  }
  // callback.js: userName comes from the ACCESS token, not the id token.
  if (opts.userNameClaim) {
    user.userName =
      opts.userNameClaim in opts.accessToken ? opts.accessToken[opts.userNameClaim] : ''
  }
  // callback.js: userInfo is fetched ONLY when a userInfoUrl is configured.
  if (opts.userInfoUrl) user.userInfo = {}
  // callback.js: claims are filtered from the ID token by optionalClaims.
  if (opts.optionalClaims && opts.idToken) {
    const claims: Record<string, unknown> = {}
    for (const claim of opts.optionalClaims) {
      if (opts.idToken[claim]) claims[claim] = opts.idToken[claim]
    }
    user.claims = claims
  }
  return user
}

/** A realistic Entra v2.0 id token for an on-prem-synced privileged account. */
function entraIdToken(opts: { oid: string; upn: string; email: string; name: string }) {
  return {
    aud: '11111111-2222-4333-8444-555555555555',
    iss: 'https://login.microsoftonline.com/99999999-8888-4777-8666-555555555555/v2.0',
    iat: Math.trunc(Date.now() / 1000) - 60,
    nbf: Math.trunc(Date.now() / 1000) - 60,
    exp: Math.trunc(Date.now() / 1000) + 3600,
    sub: 'AAAAAAAAAAAAAAAAAAAAAA',
    tid: '99999999-8888-4777-8666-555555555555',
    ver: '2.0',
    oid: opts.oid,
    name: opts.name,
    email: opts.email,
    preferred_username: opts.upn,
    upn: opts.upn,
  }
}

/** The Graph access token Entra actually returns — deliberately WITHOUT
 *  preferred_username, which is why userNameClaim is not a substitute. */
function entraAccessToken() {
  return {
    aud: '00000003-0000-0000-c000-000000000000',
    iss: 'https://sts.windows.net/99999999-8888-4777-8666-555555555555/',
    scp: 'User.Read profile openid email',
    ver: '1.0',
  }
}

async function tryAuthWithSession(userSession: Record<string, unknown>) {
  vi.doMock('nuxt-oidc-auth/runtime/server/utils/session.js', () => ({
    getUserSession: async () => userSession,
  }))
  vi.resetModules()
  const { tryAuth } = await import('../../../server/utils/auth')
  const ev = {
    context: {} as Record<string, unknown>,
    node: {
      req: { method: 'GET', url: '/api/v1/auth/me', headers: { host: 'localhost:3450' } },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) {
          return this._headers[n.toLowerCase()]
        },
        setHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
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
  try {
    return await tryAuth(ev as never)
  } finally {
    vi.doUnmock('nuxt-oidc-auth/runtime/server/utils/session.js')
    vi.resetModules()
  }
}

// ── the chain the fix depends on ─────────────────────────────────────────────

describe('the configuration chain that makes the UPN reachable', () => {
  it('nuxt.config.ts requests the UPN claims — the only source user.claims can come from', async () => {
    const claims = await configuredOptionalClaims()
    expect(claims).toContain('oid')
    expect(claims).toContain('email')
    expect(claims).toContain('preferred_username')
  })

  it('no userInfoUrl is configured, so extractClaims’ userInfo source is dead by construction', async () => {
    expect(await configuresUserInfoUrl()).toBe(false)
  })
})

describe('the UPN survives the real callback filter and reaches the JIT exclusion guard', () => {
  const UPN = 'svc-deploy-cld@contoso.onmicrosoft.com'

  async function signIn(oid: string, upn: string, email: string) {
    return tryAuthWithSession(
      buildCallbackUserSession({
        idToken: entraIdToken({ oid, upn, email, name: 'Deploy Service' }),
        accessToken: entraAccessToken(),
        optionalClaims: await configuredOptionalClaims(),
        userNameClaim: 'preferred_username',
      }) as Record<string, unknown>,
    )
  }

  it('the built fixture actually carries the UPN (and userName does NOT — it comes from the access token)', async () => {
    const user = buildCallbackUserSession({
      idToken: entraIdToken({ oid: 'x', upn: UPN, email: 'a@b.com', name: 'n' }),
      accessToken: entraAccessToken(),
      optionalClaims: await configuredOptionalClaims(),
      userNameClaim: 'preferred_username',
    })
    expect((user.claims as Record<string, unknown>).preferred_username).toBe(UPN)
    // The access token has no preferred_username → userName is ''. This is the
    // reason `userName` cannot stand in for the UPN.
    expect(user.userName).toBe('')
    expect(user.userInfo).toBeUndefined()
  })

  it('with NO exclusion pattern configured, an excluded-looking account signs in normally (exposure today is NIL)', async () => {
    const patterns = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM directory_exclusion_pattern`
    expect(Number(patterns[0]!.c)).toBe(0) // mig 0083 seeds zero, by design

    const session = await signIn('oid-upn-nopattern', UPN, 'svc-deploy@example.com')
    expect(session).not.toBeNull() // the guard matches nobody without a policy
  })

  it('with a pattern configured, the privileged account is REFUSED at first-touch JIT', async () => {
    await t.client`
      INSERT INTO directory_exclusion_pattern (pattern, note)
      VALUES ('*@contoso.onmicrosoft.com', 'audit round 2 test')
      ON CONFLICT DO NOTHING`

    const session = await signIn('oid-upn-excluded', UPN, 'svc-deploy-2@example.com')
    expect(session).toBeNull()

    // The guard EVALUATED (rather than failing open): it recorded the refusal
    // with the UPN it matched on. This is what proves extraction worked.
    const audit = await t.client<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM audit_event
       WHERE event_type = 'teammate-jit-excluded' AND payload->>'oid' = 'oid-upn-excluded'`
    expect(audit.length).toBe(1)
    expect(audit[0]!.payload.upn).toBe(UPN)

    // No teammate row was created for the privileged account.
    const tm = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM teammate WHERE entra_oid = 'oid-upn-excluded'`
    expect(Number(tm[0]!.c)).toBe(0)

    // And the blind-guard observability event did NOT fire — that event exists
    // precisely to record "a policy is configured but this token carried no
    // UPN", which was the permanent state before this fix.
    const blind = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM audit_event WHERE event_type = 'teammate-jit-no-upn'`
    expect(Number(blind[0]!.c)).toBe(0)
  })

  it('an ordinary user is unaffected by the same configured pattern', async () => {
    const session = await signIn(
      'oid-upn-ordinary',
      'jane.doe@example.com',
      'jane.doe@example.com',
    )
    expect(session).not.toBeNull()
    expect(session?.email).toBe('jane.doe@example.com')
  })
})
