/*
 * O1 Server-Timing — the plugin's substance, driven directly
 * (docs/design/performance-observability-baseline.md §O1; the Nitro plugin
 * itself is registration-only, per the oidc-session-store.ts precedent):
 * store binding is gated to /api/ and the NUXT_SERVER_TIMING=off escape hatch;
 * the beforeResponse write carries `db;dur` (1dp), `stmts;desc="<n>"` and
 * `app;dur` (dr-M3: handler time, not total); a late hook never throws
 * (headersSent guard, dr-H1); appends COMPOSE with a `cache;desc=…` marker the
 * handler already set; and `withReportCache` emits hit/miss/join from the path
 * it actually took (cache opt-in via TOKENSCOPE_REPORT_CACHE_TTL_MS —
 * report-cache.ts TTL contract).
 *
 * Driver-wrapper CONTRACT tests (dr-H2) need a real Postgres and live in
 * tests/integration/observability/request-timing.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { H3Event } from 'h3'
import {
  requestTimingStorage,
  createRequestTimingStore,
  wrapAppHandlerWithTiming,
  writeServerTiming,
  appendServerTiming,
} from '../../../server/observability/request-timing'
import { withReportCache, resetReportCache } from '../../../server/reporting/report-cache'

/** Recording fake event — headers land lowercase, like Node's OutgoingMessage lookup. */
function fakeEvent(path = '/api/v1/probe', sent = false) {
  const headers: Record<string, unknown> = {}
  const event = {
    method: 'GET',
    path,
    context: {},
    node: {
      req: { method: 'GET', url: path, headers: {} },
      res: {
        setHeader(name: string, value: unknown) {
          headers[String(name).toLowerCase()] = value
        },
        getHeader(name: string) {
          return headers[String(name).toLowerCase()]
        },
        removeHeader(name: string) {
          Reflect.deleteProperty(headers, String(name).toLowerCase())
        },
        get headersSent() {
          return sent
        },
      },
    },
  }
  return { event: event as unknown as H3Event, headers: () => headers }
}

const timing = (headers: () => Record<string, unknown>) =>
  headers()['server-timing'] as string | undefined

beforeEach(() => {
  resetReportCache()
  delete process.env.NUXT_SERVER_TIMING
  delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
})

afterEach(() => {
  // enterWith binds to the test's async context; disable() severs it so no
  // store bleeds into the next test (run/enterWith re-enable the instance).
  requestTimingStorage.disable()
  delete process.env.NUXT_SERVER_TIMING
  delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
})

describe('wrapAppHandlerWithTiming — the root-handler wrap', () => {
  it('runs an /api handler INSIDE a fresh store (and the store ends with it)', async () => {
    const { event } = fakeEvent('/api/v1/reports/region')
    let seen: unknown
    const wrapped = wrapAppHandlerWithTiming(async () => {
      // The load-bearing property the old request-hook enterWith LACKED: the
      // HANDLER's own continuation observes the store (proven missing live
      // on the built artifact, 2026-08-20).
      await Promise.resolve()
      seen = requestTimingStorage.getStore()
    })
    await wrapped(event)
    expect(seen).toMatchObject({ dbMs: 0, stmts: 0 })
    expect(requestTimingStorage.getStore()).toBeUndefined() // scoped, no bleed
  })

  it('does not bind for non-API paths (static assets excluded, §O1)', async () => {
    const { event } = fakeEvent('/_nuxt/entry.js')
    let seen: unknown = 'sentinel'
    const wrapped = wrapAppHandlerWithTiming(() => {
      seen = requestTimingStorage.getStore()
    })
    await wrapped(event)
    expect(seen).toBeUndefined()
  })

  it('NUXT_SERVER_TIMING=off binds nothing', async () => {
    process.env.NUXT_SERVER_TIMING = 'off'
    const { event } = fakeEvent()
    let seen: unknown = 'sentinel'
    const wrapped = wrapAppHandlerWithTiming(() => {
      seen = requestTimingStorage.getStore()
    })
    await wrapped(event)
    expect(seen).toBeUndefined()
  })
})

describe('writeServerTiming — the beforeResponse write', () => {
  it('formats db;dur (1dp), stmts;desc quoted, app;dur (dr-M3)', () => {
    const { event, headers } = fakeEvent()
    const store = createRequestTimingStore()
    store.dbMs = 12.34
    store.stmts = 4
    requestTimingStorage.run(store, () => writeServerTiming(event))
    expect(timing(headers)).toMatch(/^db;dur=12\.3, stmts;desc="4", app;dur=\d+\.\d$/)
  })

  it('no store → no header (the dr-H1 documented gap: unbound paths stay bare)', () => {
    const { event, headers } = fakeEvent()
    writeServerTiming(event)
    expect(timing(headers)).toBeUndefined()
  })

  it('a store bled onto a non-API event writes nothing (enterWith leak guard)', () => {
    const { event, headers } = fakeEvent('/login')
    requestTimingStorage.run(createRequestTimingStore(), () => writeServerTiming(event))
    expect(timing(headers)).toBeUndefined()
  })

  it('NUXT_SERVER_TIMING=off strips the write even with a live store', () => {
    const { event, headers } = fakeEvent()
    process.env.NUXT_SERVER_TIMING = 'off'
    requestTimingStorage.run(createRequestTimingStore(), () => writeServerTiming(event))
    expect(timing(headers)).toBeUndefined()
  })

  it('never throws after headersSent — a late hook is a silent no-op (dr-H1)', () => {
    const { event, headers } = fakeEvent('/api/v1/probe', true)
    expect(() =>
      requestTimingStorage.run(createRequestTimingStore(), () => writeServerTiming(event)),
    ).not.toThrow()
    expect(timing(headers)).toBeUndefined()
  })

  it('appends after a cache;desc marker the handler set (comma-composed)', () => {
    const { event, headers } = fakeEvent()
    appendServerTiming(event, 'cache;desc=hit')
    const store = createRequestTimingStore()
    store.dbMs = 1.05
    store.stmts = 1
    requestTimingStorage.run(store, () => writeServerTiming(event))
    expect(timing(headers)).toMatch(/^cache;desc=hit, db;dur=1\.[01], stmts;desc="1", app;dur=/)
  })
})

describe('withReportCache — cache;desc rides Server-Timing (§O1)', () => {
  beforeEach(() => {
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '60000'
  })

  it('miss on the cold call, hit on the warm one', async () => {
    const cold = fakeEvent()
    const compute = async () => ({ n: 1 })
    await withReportCache(cold.event, ['st-k'], compute)
    expect(timing(cold.headers)).toBe('cache;desc=miss')

    const warm = fakeEvent()
    await withReportCache(warm.event, ['st-k'], compute)
    expect(timing(warm.headers)).toBe('cache;desc=hit')
  })

  it('a concurrent identical request joins the leader (single-flight, D6)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const compute = async () => {
      await gate
      return { n: 1 }
    }
    const a = fakeEvent()
    const b = fakeEvent()
    const pa = withReportCache(a.event, ['st-join'], compute)
    const pb = withReportCache(b.event, ['st-join'], compute)
    release()
    await Promise.all([pa, pb])
    const marks = [timing(a.headers), timing(b.headers)].sort()
    expect(marks).toEqual(['cache;desc=join', 'cache;desc=miss'])
  })

  it('disabled cache (TTL 0) emits no marker — pure passthrough unchanged', async () => {
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '0'
    const { event, headers } = fakeEvent()
    await withReportCache(event, ['st-off'], async () => 1)
    expect(timing(headers)).toBeUndefined()
  })

  it('NUXT_SERVER_TIMING=off suppresses the marker but not the cache itself', async () => {
    process.env.NUXT_SERVER_TIMING = 'off'
    let n = 0
    const compute = async () => ++n
    const cold = fakeEvent()
    await withReportCache(cold.event, ['st-quiet'], compute)
    const warm = fakeEvent()
    const second = await withReportCache(warm.event, ['st-quiet'], compute)
    expect(second).toBe(1) // still served from cache
    expect(timing(cold.headers)).toBeUndefined()
    expect(timing(warm.headers)).toBeUndefined()
  })
})
