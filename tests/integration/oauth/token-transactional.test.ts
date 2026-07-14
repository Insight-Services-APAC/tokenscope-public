// @vitest-environment node
/*
 * AUTH-4 (robustness-review-2026-06-09) — the /oauth/token authorization_code
 * exchange runs consumeAuthCode→issueTokens→recordAuditEvent in ONE
 * transaction. A transient failure after the consume (injected here as a
 * throwing audit insert) must roll the consume back so the code stays
 * exchangeable on retry — no permanently burned code, no orphaned token pair
 * the client never received.
 *
 * Counter-check: VALIDATION failures (e.g. wrong PKCE verifier) must still
 * BURN the code (the consume commits) — the transaction must not weaken the
 * single-use/brute-force property.
 *
 * Harness mirrors tests/integration/oauth/oauth-flow.test.ts.
 */
import { createHash, randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { hashSessionToken } from '../../../server/auth/hmac'

import registerHandler from '../../../server/api/v1/oauth/register.post'
import authorizePostHandler from '../../../server/api/v1/oauth/authorize.post'
import tokenHandler from '../../../server/api/v1/oauth/token.post'

let t: TestDb
let regionId: string
let teammateId: string

const REDIRECT_URI = 'http://localhost:43118/callback'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'token-tx-test-padded-to-thirty-two-chars!!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'token-tx-test-hmac-key-padded-well-beyond-32-chars'

  const [r] = await t.db.insert(schema.region).values({ code: 'tx', displayName: 'TX Region' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'tx.svc', code: 'tx-svc', displayName: 'TX Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'tx-oid-1', email: 'tx-user@example.com', displayName: 'TX User', role: 'developer', regionId, orgUnitId: ou!.id })
    .returning()
  teammateId = tm!.id
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

type AnyHandler = (e: unknown) => Promise<unknown>

const userSession = (): Session =>
  ({ teammateId, email: 'tx-user@example.com', displayName: 'TX User', role: 'developer', regionId, orgPath: 'tx.svc' }) as Session

function ev(opts: { method?: string; body?: unknown; session?: Session }) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
  }
  const method = opts.method ?? 'POST'
  const e = {
    method,
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method,
        url: '/x',
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

function makePkce() {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function registerClient(): Promise<{ client_id: string; client_secret: string }> {
  return call(registerHandler, ev({ body: { client_name: 'TX MCP', redirect_uris: [REDIRECT_URI] } }))
}

async function authorizeForCode(clientId: string, challenge: string): Promise<string> {
  const e = ev({
    method: 'POST',
    body: {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'tokenscope.read tokenscope.tag',
      state: randomBytes(16).toString('hex'),
      action: 'approve',
    },
    session: userSession(),
  })
  await call(authorizePostHandler, e)
  expect(statusOf(e)).toBe(302)
  const loc = (e as { node: { res: { _headers: Record<string, string> } } }).node.res._headers['location']
  const code = new URL(loc).searchParams.get('code')!
  expect(code).toBeTruthy()
  return code
}

async function codeConsumedAt(code: string): Promise<Date | null> {
  const rows = await t.db.execute<{ consumed_at: Date | null }>(sql`
    SELECT consumed_at FROM oauth_auth_code WHERE code_hash = ${hashSessionToken(code)} LIMIT 1
  `)
  return [...rows][0]?.consumed_at ?? null
}

function exchangeBody(client: { client_id: string; client_secret: string }, code: string, verifier: string) {
  return {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    client_id: client.client_id,
    client_secret: client.client_secret,
  }
}

describe('AUTH-4 — auth-code exchange is one transaction', () => {
  it('a failure AFTER consume rolls the consume back; the same code exchanges on retry', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const code = await authorizeForCode(client.client_id, challenge)

    // Inject the fault: the post-issue audit insert throws inside the tx.
    await t.client.unsafe(
      `ALTER TABLE audit_event ADD CONSTRAINT test_block_audit CHECK (event_type <> 'oauth_token_issue') NOT VALID`,
    )
    try {
      const e = ev({ body: exchangeBody(client, code, verifier) })
      const res = await call<{ error: string }>(tokenHandler, e)
      expect(res.error).toBe('server_error')
      expect(statusOf(e)).toBe(500)

      // Rolled back: the code is NOT consumed (retryable)...
      expect(await codeConsumedAt(code)).toBeNull()
      // ...and no orphaned live token pair was minted for this client.
      const tokens = await t.db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n FROM oauth_token WHERE client_id = ${client.client_id}::uuid
      `)
      expect(Number([...tokens][0]!.n)).toBe(0)
    } finally {
      await t.client.unsafe(`ALTER TABLE audit_event DROP CONSTRAINT IF EXISTS test_block_audit`)
    }

    // Retry with the SAME code succeeds once the fault clears.
    const retry = ev({ body: exchangeBody(client, code, verifier) })
    const ok = await call<{ access_token: string; refresh_token: string }>(tokenHandler, retry)
    expect(ok.access_token).toBeTruthy()
    expect(ok.refresh_token).toBeTruthy()
    expect(await codeConsumedAt(code)).not.toBeNull()
  })

  it('a VALIDATION failure (wrong PKCE verifier) still BURNS the code — no rollback weakening', async () => {
    const client = await registerClient()
    const { challenge } = makePkce()
    const code = await authorizeForCode(client.client_id, challenge)

    const e = ev({
      body: exchangeBody(client, code, randomBytes(48).toString('base64url')),
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')

    // The consume COMMITTED: the code is burned and cannot be replayed with the
    // (now-guessed-right) verifier — single-use survives the transaction change.
    expect(await codeConsumedAt(code)).not.toBeNull()
  })
})
