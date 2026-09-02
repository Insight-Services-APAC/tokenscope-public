// @vitest-environment node
/*
 * GUARD — GET /api/v1/auth/me ALWAYS ANSWERS 200.
 *
 * That is the route's stated contract ("Always responds 200", me.get.ts), and
 * it is load-bearing: `auth.global.ts` awaits this probe before any page
 * renders, so a 500 here is not a degraded nav — it is the whole app failing
 * to boot.
 *
 * Adding the Reporting verdict put database work on that path for the first
 * time. This pins that a failure in that work degrades the VERDICT rather than
 * the RESPONSE, and that it degrades CLOSED (no entry) rather than open.
 *
 * An integration-level version of this test does not work: `getDb()` memoises
 * its pool, so pointing DATABASE_URL at a dead host after the first connection
 * is a no-op and the test passes for the wrong reason (observed — it returned a
 * live verdict). The failure has to be injected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { consola } from 'consola'

const TEAMMATE = '9a1e0000-0000-4000-8000-0000000000c1'

const session = {
  teammateId: TEAMMATE,
  email: 'dev@n.test',
  displayName: 'Dev',
  role: 'developer',
  regionId: '9a1e0000-0000-4000-8000-0000000000c2',
  orgPath: 'n',
  issuedAt: new Date().toISOString(),
}

vi.mock('../../../server/utils/auth', () => ({
  tryAuth: vi.fn(async () => session),
}))

const withRequestRls = vi.fn()
vi.mock('../../../server/db/request-rls', () => ({
  withRequestRls: (...args: unknown[]) => withRequestRls(...args),
}))

const handler = (await import('../../../server/api/v1/auth/me.get')).default

const call = async () =>
  (await handler({ context: {} } as never)) as unknown as {
    authenticated: boolean
    reporting?: { visible: boolean; scope: string | null }
  }

beforeEach(() => {
  withRequestRls.mockReset()
  // These cases deliberately drive the degraded path, which logs. Silenced so a
  // normal run does not print errors that are the POINT of the test — same
  // pattern as tests/unit/server/redact-probe-error.test.ts.
  vi.spyOn(consola, 'error').mockImplementation(() => {})
})

describe('GET /auth/me under a failing database', () => {
  it('still answers 200, with the verdict failed CLOSED', async () => {
    withRequestRls.mockRejectedValue(new Error('connection refused'))

    const r = await call()

    expect(r.authenticated).toBe(true)
    expect(r.reporting).toEqual({ visible: false, scope: null })
    // The rest of the session must survive intact — the verdict is the only
    // thing allowed to degrade.
    expect(r).toMatchObject({ email: 'dev@n.test', role: 'developer' })
  })

  it('a thrown transaction does not become a 500', async () => {
    withRequestRls.mockImplementation(() => {
      throw new Error('pool exhausted') // synchronous throw, not a rejection
    })
    await expect(call()).resolves.toMatchObject({ authenticated: true })
  })

  it('serves the real verdict when the database is healthy', async () => {
    // Proves the catch is not swallowing the happy path too.
    withRequestRls.mockResolvedValue({ visible: true, scope: 'cost-centre' })
    const r = await call()
    expect(r.reporting).toEqual({ visible: true, scope: 'cost-centre' })
  })
})
