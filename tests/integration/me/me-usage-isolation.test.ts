// @vitest-environment node
/*
 * ONE SNAPSHOT for the /me/usage response.
 *
 * The handler proves the rollup is current and then reads the cached and live
 * bases in separate statements. Under READ COMMITTED every statement takes its
 * own snapshot, so a write committing after the proof lands in the view-backed
 * figures and not the split-backed ones — a proof that was true when taken and
 * false when used, which is worse than not proving it.
 *
 * Two things have to hold, and a test of one without the other proves nothing:
 * the MECHANISM must actually change what the database runs at (a transaction
 * option that silently fails to apply looks identical from the handler), and
 * the ROUTE must actually ask for it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { withRlsContext } from '../../../server/db/rls'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

/*
 * The route is imported for its SIDE EFFECT of calling withRequestRls, so the
 * wrapper is stubbed to record the options and stop there. Running the handler
 * body would need a session and a seeded estate for no extra information: the
 * claim under test is which isolation the route asks for.
 */
const probe = vi.hoisted(() => ({ opts: [] as Array<Record<string, unknown> | undefined> }))
vi.mock('../../../server/db/request-rls', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    withRequestRls: (_event: unknown, _fn: unknown, opts?: Record<string, unknown>) => {
      probe.opts.push(opts)
      return Promise.resolve(null)
    },
  }
})

let t: TestDb

const CTX = {
  userRegionId: '9a1e0000-0000-4000-8000-00000000000a',
  userOrgPath: 'apac',
  userRole: 'developer',
  userTeammateId: '9a1e0000-0000-4000-8000-0000000000f1',
}

async function isolationUnder(opts?: { isolationLevel: 'repeatable read' }): Promise<string> {
  let level = ''
  await withRlsContext(
    t.db,
    CTX,
    async (tx) => {
      const [row] = await tx.execute<{ level: string }>(
        sql`SELECT current_setting('transaction_isolation') AS level`,
      )
      level = row!.level
    },
    opts,
  )
  return level
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
}, 300_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('withRlsContext isolation', () => {
  it('actually puts the transaction in REPEATABLE READ', async () => {
    // Asked of the database, not of the code: the option is only worth
    // anything if the server agrees it applied.
    expect(await isolationUnder({ isolationLevel: 'repeatable read' })).toBe('repeatable read')
  })

  it('DEFAULTS to read committed', async () => {
    /*
     * Named for what it can see. The option is opt-in and nine other callers
     * share this helper, so a default that quietly changed would be a far
     * bigger change than this one — but this proves only the default, not that
     * no other caller opts in. /me/usage is the only one that does today, and
     * a second would need its own read-only argument, not this test.
     */
    expect(await isolationUnder()).toBe('read committed')
  })
})

describe('the /me/usage route', () => {
  it('ASKS for the one snapshot', async () => {
    /*
     * The mechanism test above passes whether or not the route uses it. This
     * asserts the route's OWN call, because "the helper supports it" and "the
     * page gets it" are different claims — and the second is the one that
     * protects the figures.
     */
    const mod = await import('../../../server/api/v1/me/usage.get')
    const handler = mod.default as unknown as (e: unknown) => Promise<unknown>
    const url = '/x'
    // The route authenticates BEFORE it opens the transaction, so a session is
    // needed even though the stub never runs the body.
    const e = {
      method: 'GET',
      path: url,
      context: { params: {} },
      node: {
        req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3450' } },
        res: { statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, end() {} },
      },
    }
    injectTestSession(e as never, {
      teammateId: CTX.userTeammateId,
      email: 'gate@example.test',
      displayName: 'Gate',
      role: 'developer',
      regionId: CTX.userRegionId,
      orgPath: CTX.userOrgPath,
      issuedAt: new Date().toISOString(),
    } as unknown as Session)
    await handler(e)
    expect(probe.opts[0]).toEqual({ isolationLevel: 'repeatable read' })
  })
})
