// @vitest-environment node
/*
 * OAuth 2.1 Authorization Server — full-flow integration (ADR-0005 credential
 * pathway). Real DB via testcontainers + the actual handlers called directly
 * (the region-lifecycle.test.ts pattern: ev() builds an h3-shaped event; the
 * OAuth handlers return RFC-6749 JSON bodies and set res.statusCode rather than
 * throwing, so we assert on the returned body + res.statusCode).
 *
 * Coverage (per brief):
 *   - Happy path: register → authorize(issues code) → token(code+PKCE) →
 *     access+refresh → refresh(new access) → revoke → token rejected.
 *   - PKCE failure (wrong verifier → invalid_grant).
 *   - Expired/used code → invalid_grant.
 *   - Cross-client code theft → invalid_grant.
 *   - requireOAuthBearer: accepts valid; rejects expired / revoked-token /
 *     E2-revoked-teammate.
 */
import { createHash, randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { requireOAuthBearer } from '../../../server/auth/oauth-bearer'
import { hashSessionToken } from '../../../server/auth/hmac'

import registerHandler from '../../../server/api/v1/oauth/register.post'
import authorizeHandler from '../../../server/api/v1/oauth/authorize.get'
import authorizePostHandler from '../../../server/api/v1/oauth/authorize.post'
import { refreshAccessToken } from '../../../server/auth/oauth'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import tokenHandler from '../../../server/api/v1/oauth/token.post'
import revokeHandler from '../../../server/api/v1/oauth/revoke.post'

let t: TestDb
let regionId: string
let ouId: string
let teammateId: string

const REDIRECT_URI = 'http://localhost:43117/callback'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'oauth-test-padded-to-thirty-two-chars!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'oauth-test-hmac-key-padded-well-beyond-32-chars'

  const [r] = await t.db.insert(schema.region).values({ code: 'oa', displayName: 'OAuth Region' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'oa.svc', code: 'oa-svc', displayName: 'OA Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oa-oid-1', email: 'oauth-user@example.com', displayName: 'OAuth User', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  teammateId = tm!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

type AnyHandler = (e: unknown) => Promise<unknown>

const userSession = (): Session =>
  ({ teammateId, email: 'oauth-user@example.com', displayName: 'OAuth User', role: 'developer', regionId, orgPath: 'oa.svc' }) as Session

/**
 * Build an h3-shaped event. `authed` injects a TokenScope session (for the
 * authorize endpoint's requireAuth); omit it to model an unauthenticated GET.
 */
function ev(opts: {
  method?: string
  params?: Record<string, string>
  query?: Record<string, string>
  body?: unknown
  headers?: Record<string, string>
  session?: Session
}) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    ...(opts.headers ?? {}),
  }
  const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : ''
  const url = '/x' + qs
  const method = opts.method ?? 'POST'
  const e = {
    method,
    path: url,
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method,
        url,
        body: opts.body,
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
        // sendRedirect() routes through h3's send() which defers
        // res.end(data) via setImmediate — provide a no-op so the deferred
        // flush doesn't throw an async uncaught exception after the handler
        // promise has already resolved.
        write() { return true },
        end() { this._ended = true; return this },
        get headersSent() { return this._ended },
      },
    },
  }
  if (opts.session) injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown
}

async function call<R = unknown>(h: unknown, e: unknown): Promise<R> {
  return (h as AnyHandler)(e) as Promise<R>
}

function statusOf(e: unknown): number {
  return (e as { node: { res: { statusCode: number } } }).node.res.statusCode
}

// ── PKCE helpers ────────────────────────────────────────────────────────────
function makePkce() {
  const verifier = randomBytes(48).toString('base64url') // 64 chars, valid charset
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// Register a fresh client; returns { client_id, client_secret }.
async function registerClient(): Promise<{ client_id: string; client_secret: string }> {
  const out = await call<{ client_id: string; client_secret: string }>(
    registerHandler,
    ev({ body: { client_name: 'Test MCP', redirect_uris: [REDIRECT_URI] } }),
  )
  return out
}

// Approve consent via authorize.post (the consent page's grant) and return the
// `code` from the 302 Location. (The GET now hands off to the consent page; the
// code is issued by the POST — mirrors the real browser flow without a browser.)
async function authorizeForCode(
  clientId: string,
  challenge: string,
  opts: { scope?: string; state?: string; session?: Session } = {},
): Promise<{ code: string; state: string }> {
  const state = opts.state ?? randomBytes(16).toString('hex')
  const e = ev({
    method: 'POST',
    body: {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: opts.scope ?? 'tokenscope.read tokenscope.tag',
      state,
      action: 'approve',
    },
    session: opts.session ?? userSession(),
  })
  await call(authorizePostHandler, e)
  // No Accept: application/json → the POST 302s with code+state in the Location.
  expect(statusOf(e)).toBe(302)
  const loc = (e as { node: { res: { _headers: Record<string, string> } } }).node.res._headers['location']
  expect(loc).toBeTruthy()
  const u = new URL(loc)
  const code = u.searchParams.get('code')!
  expect(code).toBeTruthy()
  expect(u.searchParams.get('state')).toBe(state)
  return { code, state }
}

describe('OAuth happy path', () => {
  it('register → authorize → token → refresh → revoke → rejected', async () => {
    // 1. Register.
    const client = await registerClient()
    expect(client.client_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(client.client_secret).toMatch(/^[0-9a-f]{64}$/)

    // 2. Authorize → code.
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)

    // 3. Token (authorization_code + PKCE).
    const tok = await call<{ access_token: string; refresh_token: string; scope: string; token_type: string; expires_in: number }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    expect(tok.access_token).toBeTruthy()
    expect(tok.refresh_token).toBeTruthy()
    expect(tok.token_type).toBe('bearer')
    // emit is NOT grantable via the interactive flow (R1 F1) — only read+tag.
    expect(tok.scope).toBe('tokenscope.read tokenscope.tag')

    // 4. Refresh → NEW access token, SAME refresh token (NON-ROTATING, ADR-0005).
    const refreshed = await call<{ access_token: string; refresh_token: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'refresh_token',
          refresh_token: tok.refresh_token,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    expect(refreshed.access_token).toBeTruthy()
    expect(refreshed.access_token).not.toBe(tok.access_token)
    // Non-rotating: the refresh token is echoed UNCHANGED and stays live.
    expect(refreshed.refresh_token).toBe(tok.refresh_token)

    // The SAME refresh token is still valid and reusable across multiple cycles
    // (this is the durable-emission fix — re-presenting it must NOT invalidate it).
    const reuse = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    })
    const reuseRes = await call<{ access_token: string; refresh_token: string }>(tokenHandler, reuse)
    expect(statusOf(reuse)).toBe(200)
    expect(reuseRes.access_token).toBeTruthy()
    expect(reuseRes.refresh_token).toBe(tok.refresh_token)

    // A third cycle still works (durability under repeated active use).
    const reuse2 = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    })
    const reuse2Res = await call<{ access_token: string }>(tokenHandler, reuse2)
    expect(reuse2Res.access_token).toBeTruthy()

    // 5. Revoke the (still-same) refresh token.
    const revRes = await call<Record<string, never>>(
      revokeHandler,
      ev({
        body: {
          token: tok.refresh_token,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    expect(revRes).toEqual({})

    // 6. The revoked refresh token is rejected — revocation, not rotation, is
    //    the control that ends a durable refresh credential.
    const afterRevoke = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    })
    const afterRes = await call<{ error: string }>(tokenHandler, afterRevoke)
    expect(afterRes.error).toBe('invalid_grant')
  })
})

describe('PKCE + code failure modes', () => {
  it('wrong verifier → invalid_grant', async () => {
    const client = await registerClient()
    const { challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    const e = ev({
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: randomBytes(48).toString('base64url'), // different verifier
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')
    expect(statusOf(e)).toBe(400)
  })

  it('used code → invalid_grant (single-use)', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
    }
    const first = await call<{ access_token: string }>(tokenHandler, ev({ body }))
    expect(first.access_token).toBeTruthy()
    // Second exchange of the same code → consumed → invalid_grant.
    const e2 = ev({ body })
    const second = await call<{ error: string }>(tokenHandler, e2)
    expect(second.error).toBe('invalid_grant')
  })

  it('expired code → invalid_grant', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    // Force-expire the code in the DB.
    await t.db.execute(sql`
      UPDATE oauth_auth_code SET expires_at = now() - interval '1 minute'
      WHERE code_hash = ${hashSessionToken(code)}
    `)
    const e = ev({
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')
  })

  it('cross-client code theft → invalid_grant', async () => {
    const victim = await registerClient()
    const attacker = await registerClient()
    const { verifier, challenge } = makePkce()
    // Victim's client gets the code (authorized by the user).
    const { code } = await authorizeForCode(victim.client_id, challenge)
    // Attacker tries to redeem it with ITS OWN credentials.
    const e = ev({
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: attacker.client_id,
        client_secret: attacker.client_secret,
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')
  })
})

describe('authorize endpoint guards', () => {
  it('unauthenticated → 302 to login (no code issued)', async () => {
    const client = await registerClient()
    const { challenge } = makePkce()
    const e = ev({
      method: 'GET',
      query: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'tokenscope.read',
        state: randomBytes(16).toString('hex'),
      },
      // no session → unauthenticated
    })
    await call(authorizeHandler, e)
    expect(statusOf(e)).toBe(302)
    const loc = (e as { node: { res: { _headers: Record<string, string> } } }).node.res._headers['location']
    expect(loc).toContain('/auth/entra/login')
    expect(loc).not.toContain('code=')
  })

  it('unknown client_id → invalid_client (no redirect)', async () => {
    const { challenge } = makePkce()
    const e = ev({
      method: 'GET',
      query: {
        response_type: 'code',
        client_id: '00000000-0000-4000-8000-0000000000ff',
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'tokenscope.read',
        state: randomBytes(16).toString('hex'),
      },
      session: userSession(),
    })
    const res = await call<{ error: string }>(authorizeHandler, e)
    expect(res.error).toBe('invalid_client')
    expect(statusOf(e)).toBe(400)
  })

  it('redirect_uri not matching registration → invalid_request (no redirect)', async () => {
    const client = await registerClient()
    const { challenge } = makePkce()
    const e = ev({
      method: 'GET',
      query: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: 'http://localhost:9999/evil',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'tokenscope.read',
        state: randomBytes(16).toString('hex'),
      },
      session: userSession(),
    })
    const res = await call<{ error: string }>(authorizeHandler, e)
    expect(res.error).toBe('invalid_request')
    expect(statusOf(e)).toBe(400)
  })
})

describe('client + token endpoint auth', () => {
  it('invalid client secret at /token → invalid_client (401)', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    const e = ev({
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: client.client_id,
        client_secret: 'wrong-secret',
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_client')
    expect(statusOf(e)).toBe(401)
  })

  it('non-loopback redirect_uri at /register → rejected', async () => {
    const e = ev({ body: { client_name: 'Bad', redirect_uris: ['https://evil.example.com/cb'] } })
    const res = await call<{ error: string }>(registerHandler, e)
    // zod schema rejects → invalid_client_metadata (400).
    expect(res.error).toBe('invalid_client_metadata')
    expect(statusOf(e)).toBe(400)
  })
})

// ── requireOAuthBearer ────────────────────────────────────────────────────────
describe('requireOAuthBearer', () => {
  // Mint an EMIT access token the LEGIT way — issueEmitCredential (internal client)
  // + refresh — since emit is NOT grantable via the interactive flow (R1 F1).
  async function mintEmitAccessToken(): Promise<string> {
    const cred = await issueEmitCredential(t.db as never, teammateId)
    const refreshed = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
    return refreshed.access_token
  }

  // Mint a token via the full interactive flow, returning the raw access token.
  async function mintAccessToken(scope = 'tokenscope.read tokenscope.tag'): Promise<{ accessToken: string; clientId: string }> {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge, { scope })
    const tok = await call<{ access_token: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    return { accessToken: tok.access_token, clientId: client.client_id }
  }

  function bearerEv(token: string) {
    return ev({ method: 'GET', headers: { authorization: `Bearer ${token}` } })
  }

  it('accepts a valid token and returns the teammate', async () => {
    const accessToken = await mintEmitAccessToken()
    const tm = await requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never)
    expect(tm.teammateId).toBe(teammateId)
    expect(tm.email).toBe('oauth-user@example.com')
    expect(tm.scope).toContain('tokenscope.emit')
  })

  it('R1 F1: the interactive flow does NOT grant tokenscope.emit (only read+tag)', async () => {
    const { accessToken } = await mintAccessToken('tokenscope.read tokenscope.emit')
    // emit was stripped → the minted token is read-only, rejected at the emit gate.
    await expect(
      requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
    // but still valid for read.
    const tm = await requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.read', t.db as never)
    expect(tm.teammateId).toBe(teammateId)
  })

  it('rejects a token missing the required scope (insufficient_scope)', async () => {
    const { accessToken } = await mintAccessToken('tokenscope.read')
    await expect(
      requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an unknown / malformed bearer', async () => {
    await expect(
      requireOAuthBearer(bearerEv('not-a-real-token') as never, undefined, t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
    await expect(
      requireOAuthBearer(ev({ method: 'GET' }) as never, undefined, t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an expired access token', async () => {
    const { accessToken } = await mintAccessToken()
    await t.db.execute(sql`
      UPDATE oauth_token SET access_expires_at = now() - interval '1 minute'
      WHERE access_token_hash = ${hashSessionToken(accessToken)}
    `)
    await expect(
      requireOAuthBearer(bearerEv(accessToken) as never, undefined, t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects a revoked access token', async () => {
    const { accessToken } = await mintAccessToken()
    await t.db.execute(sql`
      UPDATE oauth_token SET revoked_at = now()
      WHERE access_token_hash = ${hashSessionToken(accessToken)}
    `)
    await expect(
      requireOAuthBearer(bearerEv(accessToken) as never, undefined, t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects when the bound teammate is revoked AFTER issuance (ADR-0005 E2)', async () => {
    // A dedicated teammate so we don't poison the shared one.
    const [tm2] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oa-oid-e2', email: 'e2-user@example.com', displayName: 'E2', role: 'developer', regionId, orgUnitId: ouId })
      .returning()
    const e2Session = (): Session =>
      ({ teammateId: tm2!.id, email: 'e2-user@example.com', displayName: 'E2', role: 'developer', regionId, orgPath: 'oa.svc' }) as Session

    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge, { session: e2Session() })
    const tok = await call<{ access_token: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )

    // Token works before revocation.
    const ok = await requireOAuthBearer(bearerEv(tok.access_token) as never, undefined, t.db as never)
    expect(ok.teammateId).toBe(tm2!.id)

    // Revoke the teammate AFTER the token was issued.
    await t.db.execute(sql`UPDATE teammate SET revoked_at = now() WHERE id = ${tm2!.id}::uuid`)

    await expect(
      requireOAuthBearer(bearerEv(tok.access_token) as never, undefined, t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })
})

// ── Registration hardening (MEDIUM-1) ─────────────────────────────────────────
describe('register hardening', () => {
  it('rejects the reserved emit client_name (no client created)', async () => {
    const before = [
      ...(await t.db.execute<{ count: string }>(sql`SELECT COUNT(*)::text AS count FROM oauth_client`)),
    ][0]!.count
    const e = ev({ body: { client_name: 'tokenscope-emit', redirect_uris: [REDIRECT_URI] } })
    const res = await call<{ error: string }>(registerHandler, e)
    expect(res.error).toBe('invalid_client_metadata')
    expect(statusOf(e)).toBe(400)
    const after = [
      ...(await t.db.execute<{ count: string }>(sql`SELECT COUNT(*)::text AS count FROM oauth_client`)),
    ][0]!.count
    expect(after).toBe(before)
  })

  it('public registration always sets internal = false', async () => {
    const client = await registerClient()
    const rows = [
      ...(await t.db.execute<{ internal: boolean }>(
        sql`SELECT internal FROM oauth_client WHERE client_id = ${client.client_id}::uuid`,
      )),
    ]
    expect(rows[0]!.internal).toBe(false)
  })
})

// ── Non-rotating refresh + E2 teammate-revocation cascade (HIGH-1/HIGH-2) ──────
describe('refresh: teammate revocation (ADR-0005 E2)', () => {
  // Full flow for a fresh teammate; returns the live access + refresh tokens.
  async function mintPair(): Promise<{
    accessToken: string
    refreshToken: string
    clientId: string
    clientSecret: string
    tmId: string
  }> {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: `oa-oid-${randomBytes(4).toString('hex')}`,
        email: `rev-${randomBytes(4).toString('hex')}@example.com`,
        displayName: 'Rev',
        role: 'developer',
        regionId,
        orgUnitId: ouId,
      })
      .returning()
    const session = (): Session =>
      ({ teammateId: tm!.id, email: tm!.email, displayName: 'Rev', role: 'developer', regionId, orgPath: 'oa.svc' }) as Session

    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge, { session: session() })
    const tok = await call<{ access_token: string; refresh_token: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      clientId: client.client_id,
      clientSecret: client.client_secret,
      tmId: tm!.id,
    }
  }

  it('a revoked teammate can no longer refresh (invalid_grant)', async () => {
    const p = await mintPair()
    // Revoke the teammate directly (anchor: revoked_at > refresh_issued_at).
    await t.db.execute(sql`UPDATE teammate SET revoked_at = now() WHERE id = ${p.tmId}::uuid`)

    const e = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: p.refreshToken,
        client_id: p.clientId,
        client_secret: p.clientSecret,
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')
    expect(statusOf(e)).toBe(400)
  })

  it('the eager oauth_token cascade revokes existing tokens (refresh + bearer both rejected)', async () => {
    const p = await mintPair()
    // Mirror the admin-handler eager cascade: revoke teammate + cascade oauth_token.
    await t.db.execute(sql`UPDATE teammate SET revoked_at = now() WHERE id = ${p.tmId}::uuid`)
    await t.db.execute(sql`
      UPDATE oauth_token SET revoked_at = now()
      WHERE teammate_id = ${p.tmId}::uuid AND revoked_at IS NULL
    `)

    // Refresh now fails (row revoked_at IS NOT NULL).
    const e = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: p.refreshToken,
        client_id: p.clientId,
        client_secret: p.clientSecret,
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')

    // The previously-issued access token is rejected by requireOAuthBearer.
    await expect(
      requireOAuthBearer(
        ev({ method: 'GET', headers: { authorization: `Bearer ${p.accessToken}` } }) as never,
        undefined,
        t.db as never,
      ),
    ).rejects.toMatchObject({ statusCode: 401 })
  })
})
