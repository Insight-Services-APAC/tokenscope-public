// @vitest-environment node
/*
 * `issuedAt` falls back to EPOCH, not now() (audit round 2, #3).
 *
 * DEFENCE IN DEPTH, NOT A LIVE DEFECT. nuxt-oidc-auth always writes
 * `loggedInAt` as a number (dist/runtime/server/handler/callback.js), so the
 * fallback branch in oidcLoggedInAtIso is unreachable in production today. This
 * file pins its DIRECTION so a future session shape cannot quietly acquire a
 * revocation bypass.
 *
 * Why the direction matters: `issuedAt` exists only to answer "was this session
 * minted before the revocation?" (isRevoked compares `revoked_at > issuedAt`).
 * An unknown mint time must therefore sort BEFORE every revocation. Defaulting
 * to now() would make a session with an unreadable loggedInAt look NEWER than
 * any revoked_at ever stamped — surviving revocation exactly when we know least
 * about it. Epoch fails closed.
 *
 * Kept in its own file rather than folded into deactivated-teammate.test.ts so
 * that the higher-value is_active change stays revertable on its own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let teammateId: string
const OID = 'oid-issued-at-fallback'
const EMAIL = 'fallback.user@example.com'

beforeAll(async () => {
  process.env.NUXT_SESSION_SECRET = 'issued-at-fallback-test-secret-32-chars-plus'
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  vi.resetModules()

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'iaf', displayName: 'IAF Region' })
    .returning()
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: region!.id,
      path: 'iaf.svc',
      code: 'iaf-svc',
      displayName: 'IAF Services',
      unitType: 'bu',
    })
    .returning()
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: OID,
      email: EMAIL,
      displayName: 'Fallback User',
      role: 'developer',
      regionId: region!.id,
      orgUnitId: bu!.id,
    })
    .returning()
  teammateId = tm!.id
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

/** Drive tryAuth with an OIDC session whose loggedInAt is whatever we say —
 *  including absent, which is the branch under test. */
async function tryAuthWithLoggedInAt(loggedInAt: unknown) {
  vi.doMock('nuxt-oidc-auth/runtime/server/utils/session.js', () => ({
    getUserSession: async () => ({
      ...(loggedInAt === undefined ? {} : { loggedInAt }),
      claims: { oid: OID, email: EMAIL, name: 'Fallback User' },
    }),
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
  } catch {
    return null
  } finally {
    vi.doUnmock('nuxt-oidc-auth/runtime/server/utils/session.js')
    vi.resetModules()
  }
}

describe('a session with no readable loggedInAt is treated as issued at the epoch', () => {
  it('CONTROL: a normal numeric loggedInAt resolves and stamps that instant', async () => {
    await t.client`UPDATE teammate SET revoked_at = NULL WHERE id = ${teammateId}::uuid`
    const at = Math.floor(Date.now() / 1000)
    const session = await tryAuthWithLoggedInAt(at)
    expect(session?.teammateId).toBe(teammateId)
    expect(session?.issuedAt).toBe(new Date(at * 1000).toISOString())
  })

  it('an ABSENT loggedInAt stamps the epoch (not now)', async () => {
    await t.client`UPDATE teammate SET revoked_at = NULL WHERE id = ${teammateId}::uuid`
    const session = await tryAuthWithLoggedInAt(undefined)
    expect(session?.issuedAt).toBe('1970-01-01T00:00:00.000Z')
  })

  it('and is therefore REVOKED by any revoked_at — with now() it would have survived', async () => {
    // The whole point. revoked_at is in the past, so a now() fallback would sort
    // after it and the session would resolve.
    await t.client`UPDATE teammate SET revoked_at = now() - interval '1 hour'
                    WHERE id = ${teammateId}::uuid`
    expect(await tryAuthWithLoggedInAt(undefined)).toBeNull()

    // Same teammate, same revocation, a real mint time after it → still fine.
    const session = await tryAuthWithLoggedInAt(Math.floor(Date.now() / 1000))
    expect(session?.teammateId).toBe(teammateId)
  })
})
