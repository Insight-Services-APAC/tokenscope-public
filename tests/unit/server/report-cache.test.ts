/*
 * reporting/report-cache — the store's semantics, unit-proven (plan
 * 09-reports-performance-plan.md D5-D7, tests T4/T5/T8 at store level):
 * VITEST default OFF; env override wins; single-flight shares ONE computation
 * and rejections are never cached; TTL expiry recomputes; values are
 * mutation-isolated (JSON round-trip); headers ride exactly the enabled state;
 * identity/normalization helpers behave as the cache key requires.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  withReportCache,
  memoizedScan,
  reportCacheTtlMs,
  reportCacheStats,
  resetReportCache,
  identityKey,
  normalizedQuery,
} from '../../../server/reporting/report-cache'
import type { Session } from '../../../server/utils/auth'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A recording fake event — enough of H3Event for setHeader. */
function fakeEvent() {
  const headers: Record<string, unknown> = {}
  return {
    headers: () => headers,
    event: {
      node: {
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
            return false
          },
        },
        req: { method: 'GET', url: '/x', headers: {} },
      },
      context: {},
      method: 'GET',
      path: '/x',
    } as unknown as Parameters<typeof withReportCache>[0],
  }
}

beforeEach(() => {
  resetReportCache()
  delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
})

afterEach(() => {
  delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
})

describe('TTL resolution', () => {
  it('defaults OFF under VITEST so every existing test sees uncached behaviour', () => {
    // The exact contract the TTL guard compares against — 'true', not mere
    // presence, so VITEST=0/false can never disable the cache in prod.
    expect(process.env.VITEST).toBe('true')
    expect(reportCacheTtlMs()).toBe(0)
  })

  it('the env override wins, per call', () => {
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '1234'
    expect(reportCacheTtlMs()).toBe(1234)
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = 'nonsense'
    expect(reportCacheTtlMs()).toBe(0)
  })
})

describe('disabled cache (TTL 0) is a pure passthrough', () => {
  it('computes every time and sets no headers', async () => {
    const { event, headers } = fakeEvent()
    let n = 0
    const compute = async () => ++n
    expect(await withReportCache(event, ['k'], compute)).toBe(1)
    expect(await withReportCache(event, ['k'], compute)).toBe(2)
    expect(headers()['cache-control']).toBeUndefined()
    expect(headers()['vary']).toBeUndefined()
    expect(reportCacheStats().responseMisses).toBe(0)
  })
})

describe('enabled cache', () => {
  beforeEach(() => {
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '60000'
  })

  it('hit within TTL; headers carry private,max-age + Vary: Cookie (T8)', async () => {
    const { event, headers } = fakeEvent()
    let n = 0
    const compute = async () => ({ value: ++n })
    const a = await withReportCache(event, ['k'], compute)
    const b = await withReportCache(event, ['k'], compute)
    expect(a).toEqual({ value: 1 })
    expect(b).toEqual({ value: 1 })
    expect(n).toBe(1)
    expect(headers()['cache-control']).toBe('private, max-age=60')
    expect(headers()['vary']).toBe('Cookie')
    const s = reportCacheStats()
    expect(s.responseMisses).toBe(1)
    expect(s.responseHits).toBe(1)
  })

  it('different key material is a different entry', async () => {
    const { event } = fakeEvent()
    let n = 0
    const compute = async () => ++n
    await withReportCache(event, ['k', 'idA'], compute)
    await withReportCache(event, ['k', 'idB'], compute)
    expect(n).toBe(2)
  })

  it('a hit returns an isolated copy — mutating one response cannot poison the next', async () => {
    const { event } = fakeEvent()
    const compute = async () => ({ rows: [1, 2, 3] })
    const a = await withReportCache<{ rows: number[] }>(event, ['k'], compute)
    a.rows.push(999)
    const b = await withReportCache<{ rows: number[] }>(event, ['k'], compute)
    expect(b.rows).toEqual([1, 2, 3])
  })

  it('single-flight: concurrent same-key calls share ONE computation (T4)', async () => {
    const { event } = fakeEvent()
    let n = 0
    const compute = async () => {
      await sleep(30)
      return ++n
    }
    const [a, b, c] = await Promise.all([
      withReportCache(event, ['k'], compute),
      withReportCache(event, ['k'], compute),
      withReportCache(event, ['k'], compute),
    ])
    expect([a, b, c]).toEqual([1, 1, 1])
    expect(n).toBe(1)
    const s = reportCacheStats()
    expect(s.responseMisses).toBe(1)
    expect(s.responseJoins).toBe(2)
  })

  it('a thrown computation leaves NO cache headers — errors must not carry max-age (v2-M1)', async () => {
    const { event, headers } = fakeEvent()
    await expect(
      withReportCache(event, ['k'], async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(headers()['cache-control']).toBeUndefined()
    expect(headers()['vary']).toBeUndefined()
  })

  it('rejections are never cached: the next call recomputes (T4)', async () => {
    const { event } = fakeEvent()
    let n = 0
    const failThenSucceed = async () => {
      n++
      if (n === 1) throw new Error('boom')
      return n
    }
    await expect(withReportCache(event, ['k'], failThenSucceed)).rejects.toThrow('boom')
    expect(await withReportCache(event, ['k'], failThenSucceed)).toBe(2)
  })

  it('concurrent waiters share the leader rejection, and nothing is cached', async () => {
    const { event } = fakeEvent()
    let n = 0
    const compute = async () => {
      n++
      await sleep(20)
      throw new Error(`boom-${n}`)
    }
    const results = await Promise.allSettled([
      withReportCache(event, ['k'], compute),
      withReportCache(event, ['k'], compute),
    ])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(n).toBe(1)
    const ok = async () => 'fresh'
    expect(await withReportCache(event, ['k'], ok)).toBe('fresh')
  })

  it('TTL expiry recomputes (T5)', async () => {
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '40'
    const { event } = fakeEvent()
    let n = 0
    const compute = async () => ++n
    expect(await withReportCache(event, ['k'], compute)).toBe(1)
    await sleep(80)
    expect(await withReportCache(event, ['k'], compute)).toBe(2)
  })

  it('memoizedScan shares the same semantics but sets no headers (T6 store level)', async () => {
    const { event, headers } = fakeEvent()
    void event
    let n = 0
    const compute = async () => {
      await sleep(20)
      return ++n
    }
    const [a, b] = await Promise.all([
      memoizedScan(['m'], compute),
      memoizedScan(['m'], compute),
    ])
    expect([a, b]).toEqual([1, 1])
    expect(headers()['cache-control']).toBeUndefined()
    const s = reportCacheStats()
    expect(s.memoMisses).toBe(1)
    expect(s.memoJoins).toBe(1)
  })

  it('memo and response entries never collide, even on identical material', async () => {
    const { event } = fakeEvent()
    let a = 0
    let b = 0
    expect(await withReportCache(event, ['same'], async () => `r${++a}`)).toBe('r1')
    expect(await memoizedScan(['same'], async () => `m${++b}`)).toBe('m1')
    expect(await withReportCache(event, ['same'], async () => `r${++a}`)).toBe('r1')
    expect(await memoizedScan(['same'], async () => `m${++b}`)).toBe('m1')
  })
})

describe('key material helpers', () => {
  it('identityKey carries exactly the four RLS GUC inputs + pre-collapse role', () => {
    const s = {
      teammateId: 'tm-1',
      role: 'platform-admin',
      regionId: 'r-1',
      orgPath: 'a.b',
    } as unknown as Session
    expect(identityKey(s)).toBe('tm-1|platform-admin|r-1|a.b')
  })

  it('normalizedQuery sorts keys and drops undefined — URL order cannot mint a second entry', () => {
    expect(normalizedQuery({ b: '2', a: '1', c: undefined })).toBe(
      normalizedQuery({ a: '1', b: '2' }),
    )
    // month= and from/to= of the same span stay DIFFERENT keys by construction.
    expect(normalizedQuery({ month: '2026-07' })).not.toBe(
      normalizedQuery({ from: '2026-07-01', to: '2026-07-31' }),
    )
  })

  it('a computation that STARTED before a reset does not write after it', async () => {
    /*
     * Invalidation is only half-effective without this, and in the worst case
     * useless. A Migrate commits and clears the cache; a report that began
     * computing BEFORE the clear then stores its pre-migrate answer for the
     * full TTL — so the admin's correction lands and the very next reader sees
     * the old figure anyway. The reset's own timing reintroduces the bug it was
     * added to prevent.
     */
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '60000'
    resetReportCache()

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { event } = fakeEvent()
    const slow = withReportCache(event, ['k-race'], async () => {
      await gate
      return { v: 'stale' }
    })

    // The migrate commits and invalidates while that read is in flight.
    resetReportCache()
    release()
    await expect(slow).resolves.toEqual({ v: 'stale' }) // the caller still gets its data…

    // …but nothing was pinned, so the next reader recomputes.
    let recomputed = false
    const { event: e2 } = fakeEvent()
    const fresh = await withReportCache(e2, ['k-race'], async () => {
      recomputed = true
      return { v: 'fresh' }
    })
    expect(recomputed).toBe(true)
    expect(fresh).toEqual({ v: 'fresh' })
    delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
  })
})
