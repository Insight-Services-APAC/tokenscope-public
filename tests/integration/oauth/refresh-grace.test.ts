// @vitest-environment node
/*
 * AUTH-3 (robustness-review-2026-06-09) — one-deep access-token grace window on
 * the NON-ROTATING refresh.
 *
 * All CWs sharing a host's ~/.claude share ONE instance and therefore ONE emit
 * refresh token (2026-06-05 dogfood incident). Before the fix, refresh
 * overwrote access_token_hash in place, so two helpers refreshing concurrently
 * invalidated each other's access tokens and ping-ponged. Now the refresh
 * UPDATE parks the outgoing hash in prev_access_token_hash with a ~60 s
 * prev_valid_until horizon (mig 0044) and requireOAuthBearer accepts either.
 *
 * Coverage:
 *   - two concurrent refreshes → BOTH returned access tokens validate (≥60 s
 *     window, asserted via prev_valid_until in the DB);
 *   - the grace is one-deep + bounded: an expired prev_valid_until rejects the
 *     superseded token while the current one still validates;
 *   - revocation still kills BOTH instantly (the grace never outlives revoke).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests, hashSessionToken } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import { refreshAccessToken, ACCESS_TOKEN_GRACE_MS } from '../../../server/auth/oauth'
import { requireOAuthBearer } from '../../../server/auth/oauth-bearer'

let t: TestDb
let regionId: string
let teammateId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'refresh-grace-test-padded-to-thirty-two-chars'
  process.env.NUXT_HMAC_SESSION_KEY = 'refresh-grace-test-hmac-key-padded-well-beyond-32'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'rg', displayName: 'RG Region' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'rg.svc', code: 'rg-svc', displayName: 'RG Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'rg-oid-1', email: 'rg-user@example.com', displayName: 'RG User', role: 'developer', regionId, orgUnitId: ou!.id })
    .returning()
  teammateId = tm!.id
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function bearerEv(token: string) {
  return {
    node: {
      req: { method: 'GET', url: '/x', headers: { authorization: `Bearer ${token}`, host: 'localhost:3450' } },
      res: {
        _headers: {} as Record<string, string>,
        statusCode: 200,
        getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {},
        get headersSent() { return false },
      },
    },
  }
}

async function validate(token: string): Promise<string> {
  const tm = await requireOAuthBearer(bearerEv(token) as never, 'tokenscope.emit', t.db as never)
  return tm.teammateId
}

describe('AUTH-3 — refresh grace window', () => {
  it('two CONCURRENT refreshes: both returned access tokens validate, for ≥60 s', async () => {
    const cred = await issueEmitCredential(t.db as never, teammateId)

    const [a, b] = await Promise.all([
      refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId),
      refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId),
    ])

    // Both helpers keep working — no invalidation ping-pong.
    expect(await validate(a.access_token)).toBe(teammateId)
    expect(await validate(b.access_token)).toBe(teammateId)

    // The superseded one rides the parked prev hash, valid ≥ ~60 s from now.
    const rows = await t.db.execute<{ prev_ms: string | null }>(sql`
      SELECT (EXTRACT(EPOCH FROM (prev_valid_until - now())) * 1000)::text AS prev_ms
        FROM oauth_token
       WHERE refresh_token_hash = ${hashSessionToken(cred.tokens.refresh_token)}
    `)
    const prevMs = Number([...rows][0]!.prev_ms)
    expect(prevMs).toBeGreaterThan(ACCESS_TOKEN_GRACE_MS - 10_000)
    expect(prevMs).toBeLessThanOrEqual(ACCESS_TOKEN_GRACE_MS)
  })

  it('the grace is bounded: an elapsed prev_valid_until rejects the superseded token, current still works', async () => {
    const cred = await issueEmitCredential(t.db as never, teammateId)
    const first = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
    const second = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)

    // Within the window the superseded (first) token still validates.
    expect(await validate(first.access_token)).toBe(teammateId)

    // Force the window shut.
    await t.db.execute(sql`
      UPDATE oauth_token SET prev_valid_until = now() - interval '1 second'
       WHERE refresh_token_hash = ${hashSessionToken(cred.tokens.refresh_token)}
    `)
    await expect(validate(first.access_token)).rejects.toMatchObject({ statusCode: 401 })
    expect(await validate(second.access_token)).toBe(teammateId)
  })

  it('the grace is ONE-deep: a third refresh evicts the oldest parked hash', async () => {
    const cred = await issueEmitCredential(t.db as never, teammateId)
    const r1 = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
    const r2 = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
    const r3 = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)

    await expect(validate(r1.access_token)).rejects.toMatchObject({ statusCode: 401 })
    expect(await validate(r2.access_token)).toBe(teammateId) // parked
    expect(await validate(r3.access_token)).toBe(teammateId) // current
  })

  it('revocation kills the parked token too — the grace never outlives revoke', async () => {
    const cred = await issueEmitCredential(t.db as never, teammateId)
    const first = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
    const second = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)

    await t.db.execute(sql`
      UPDATE oauth_token SET revoked_at = now()
       WHERE refresh_token_hash = ${hashSessionToken(cred.tokens.refresh_token)}
    `)
    await expect(validate(first.access_token)).rejects.toMatchObject({ statusCode: 401 })
    await expect(validate(second.access_token)).rejects.toMatchObject({ statusCode: 401 })
  })
})
