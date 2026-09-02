// @vitest-environment node
/*
 * O1 driver-wrapper CONTRACT tests (dr-H2,
 * docs/design/performance-observability-baseline.md §O1) against a real
 * testcontainers Postgres — the wrapper is API-PRESERVING or it is wrong:
 *   - `.values()` passthrough: drizzle chains it SYNCHRONOUSLY on the lazy
 *     PendingQuery (drizzle-orm/postgres-js/session.js), so mapped selects
 *     must return drizzle-shaped rows through the wrapper;
 *   - nested (savepoint) transaction statements are counted — drizzle's
 *     nested tx runs on the savepoint handle postgres.js mints for the
 *     callback (postgres/src/index.js scope());
 *   - two interleaved ALS contexts attribute separately (store read AT CALL
 *     TIME);
 *   - no store = pure pass-through (boot / off-request work is unaffected);
 *   - a rejected statement still settles the timer and the rejection still
 *     reaches the caller.
 * Plus the validation-plan header shape: a bound event whose handler ran real
 * statements carries `db;dur`/`stmts`/`app;dur` on the beforeResponse write.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { sql, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { H3Event } from 'h3'
import * as schema from '../../../drizzle/schema'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  instrumentRequestClient,
  requestTimingStorage,
  createRequestTimingStore,
  wrapAppHandlerWithTiming,
  writeServerTiming,
} from '../../../server/observability/request-timing'

let t: TestDb
let wrapped: TestDb['client']
let db: TestDb['db']

beforeAll(async () => {
  t = await startTestDb()
  // Production wiring, in miniature (server/db/index.ts): wrap the client,
  // then let drizzle wrap the proxy.
  wrapped = instrumentRequestClient(t.client)
  db = drizzle(wrapped, { schema })
})

afterAll(async () => {
  if (t) await stopTestDb(t)
})

afterEach(() => {
  // Sever any enterWith binding so no store bleeds across tests.
  requestTimingStorage.disable()
})

describe('.values() passthrough (dr-H2)', () => {
  it('mapped insert+select return drizzle-shaped rows and are counted', async () => {
    const store = createRequestTimingStore()
    const rows = await requestTimingStorage.run(store, async () => {
      await db
        .insert(schema.region)
        .values({ code: 'obs-contract', displayName: 'Observability Contract' })
      // Awaited INSIDE the context: drizzle queries are lazy (execution starts
      // at .then), and the wrapper reads the store at the unsafe() call.
      return await db.select().from(schema.region).where(eq(schema.region.code, 'obs-contract'))
    })
    // Drizzle-shaped: mapped column objects, not raw value arrays — proof the
    // wrapper returned the ORIGINAL PendingQuery for the synchronous .values().
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ code: 'obs-contract', displayName: 'Observability Contract' })
    expect(typeof rows[0].id).toBe('string')
    expect(store.stmts).toBe(2)
    expect(store.dbMs).toBeGreaterThan(0)
  })

  it('the unmapped db.execute path is counted too', async () => {
    const store = createRequestTimingStore()
    const res = await requestTimingStorage.run(store, async () => {
      return await db.execute(sql`select 1 as one`)
    })
    expect(res[0]).toMatchObject({ one: 1 })
    expect(store.stmts).toBe(1)
  })

  it('a direct unsafe().values() chain on the wrapped client stays intact', async () => {
    const store = createRequestTimingStore()
    const rows = await requestTimingStorage.run(store, () =>
      wrapped.unsafe('select $1::int as a, $2::int as b', [1, 2]).values(),
    )
    expect(rows[0]).toEqual([1, 2])
    expect(store.stmts).toBe(1)
  })
})

describe('transaction handles (dr-H2: begin AND savepoint)', () => {
  it('counts statements inside a nested (savepoint) transaction', async () => {
    const store = createRequestTimingStore()
    const answer = await requestTimingStorage.run(store, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select 1`)
        return tx.transaction(async (tx2) => {
          const r = await tx2.execute(sql`select 41 + 1 as answer`)
          return r[0].answer
        })
      }),
    )
    expect(answer).toBe(42)
    // Exactly the two application statements: postgres.js's own
    // BEGIN/SAVEPOINT/COMMIT bookkeeping bypasses `unsafe` and is uncounted
    // by design (§O1 — the header describes the app's statements).
    expect(store.stmts).toBe(2)
    expect(store.dbMs).toBeGreaterThan(0)
  })
})

describe('ALS attribution (store read at call time)', () => {
  it('two interleaved contexts attribute separately', async () => {
    const s1 = createRequestTimingStore()
    const s2 = createRequestTimingStore()
    const runN = (n: number) => async () => {
      for (let i = 0; i < n; i++) {
        await db.execute(sql`select pg_sleep(0.005)`)
      }
    }
    await Promise.all([
      requestTimingStorage.run(s1, runN(3)),
      requestTimingStorage.run(s2, runN(5)),
    ])
    expect(s1.stmts).toBe(3)
    expect(s2.stmts).toBe(5)
    expect(s1.dbMs).toBeGreaterThan(0)
    expect(s2.dbMs).toBeGreaterThan(0)
  })

  it('no store = pure pass-through: queries run untimed and untouched', async () => {
    const sentinel = createRequestTimingStore()
    const rows = await db.select().from(schema.region).limit(1)
    expect(Array.isArray(rows)).toBe(true)
    const raw = await wrapped.unsafe('select 7 as seven', []).values()
    expect(raw[0]).toEqual([7])
    expect(sentinel.stmts).toBe(0)
    expect(sentinel.dbMs).toBe(0)
  })

  it('a rejected statement still settles the timer and propagates', async () => {
    const store = createRequestTimingStore()
    await requestTimingStorage.run(store, async () => {
      await expect(db.execute(sql`select * from missing_table_obs`)).rejects.toThrow()
    })
    expect(store.stmts).toBe(1)
    expect(store.dbMs).toBeGreaterThanOrEqual(0)
  })
})

describe('the header, end to end over real statements (validation plan §O1)', () => {
  it('a bound /api event carries db;dur, stmts at the known floor, app;dur', async () => {
    const headers: Record<string, unknown> = {}
    const event = {
      method: 'GET',
      path: '/api/v1/observability-probe',
      context: {},
      node: {
        req: { method: 'GET', url: '/api/v1/observability-probe', headers: {} },
        res: {
          setHeader(name: string, value: unknown) {
            headers[String(name).toLowerCase()] = value
          },
          getHeader(name: string) {
            return headers[String(name).toLowerCase()]
          },
          get headersSent() {
            return false
          },
        },
      },
    } as unknown as H3Event

    await wrapAppHandlerWithTiming(async () => {
      await db.execute(sql`select 1`)
      await db.select().from(schema.region).limit(1)
      // h3 fires beforeResponse INSIDE app.handler, i.e. inside this wrap.
      writeServerTiming(event)
    })(event)

    const header = headers['server-timing'] as string
    expect(header).toMatch(/^db;dur=\d+\.\d, stmts;desc="2", app;dur=\d+\.\d$/)
    const dbDur = Number(/db;dur=([\d.]+)/.exec(header)![1])
    const appDur = Number(/app;dur=([\d.]+)/.exec(header)![1])
    expect(appDur).toBeGreaterThanOrEqual(dbDur)
  })
})
