/*
 * reporting/report-cache — the short-TTL response cache + single-flight for the
 * report GETs, and the function-level scan memo behind the cross-endpoint
 * duplicate reads (docs/design/reporting-consolidation/
 * 09-reports-performance-plan.md D5-D8).
 *
 * WHAT IS CACHED: the post-authorization computation only. Every request still
 * authenticates and resolves its grants/scope against live rows FIRST (the
 * handler's short authz transaction) — a revoked grant 403s immediately; what
 * can be ≤TTL stale is the DATA, never the authorization (D5).
 *
 * THE KEY IS THE SECURITY BOUNDARY. Report visibility is per-caller
 * (shared/auth/report-visibility.ts; ownership/subtree predicates reach into
 * the SQL itself), so serving one caller's cached body to another is a
 * SECURITY DEFECT, not a staleness bug. Every key hashes, in order: the
 * endpoint id + route path params, the normalized query, the caller's
 * effective identity (the four RLS GUC inputs + pre-collapse role — persona
 * impersonation rewrites the effective session, so the key moves with it),
 * the RESOLVED authorization output (width/grant/scopeKey/visible-set), the
 * UTC day of `now` (a day flip re-keys instantly — forecast, providerStates
 * and MTD clamps are date-anchored), and the copilot finance mode (a mode
 * flip re-keys instantly). Anything that could change what a caller may SEE
 * either lives in the key or is resolved live in the authz transaction.
 *
 * SINGLE-FLIGHT (D6): identical concurrent requests — the retry storm, the
 * multi-tab case — share ONE computation. A waiter only ever joins a promise
 * whose key contains its own GUC inputs + resolved scope, i.e. a computation
 * pinned to the identical RLS identity. Rejections are never cached and drop
 * the inflight entry. The leader computes inside its own transaction;
 * RESPONSE-cache waiters hold NO database connection while awaiting (r1-M2 —
 * the handlers release their authz transaction before entering this module).
 * A memoizedScan waiter is different and deliberately so (v1-M1, bound
 * corrected v2-L1): it awaits from INSIDE its own compute transaction — but
 * that transaction exists to compute the rest of its response either way,
 * and idling through a shared scan is strictly cheaper than the no-memo
 * baseline of running the same scan itself. Memo-waiter count is bounded by
 * the number of DISTINCT response computations in flight (identical requests
 * are absorbed one level up by the response cache's own single-flight) —
 * each of those holds its compute connection regardless of the memo, so the
 * memo never adds connection pressure; it only converts duplicate scans
 * into idle awaits.
 *
 * VALUES ARE STORED AS JSON STRINGS and re-parsed per hit: a consumer mutating
 * its response object can never poison another caller's response.
 *
 * TTL: 60 s default; `TOKENSCOPE_REPORT_CACHE_TTL_MS` overrides; DEFAULT 0
 * (disabled, headers off) under VITEST so every existing test sees today's
 * behaviour — cache tests opt in explicitly (the month-floor.ts precedent).
 * Staleness sits far inside the settling-window contract (Reporting.md §4,
 * hours-grain) and carries the same meta.providerStates markers a fresh
 * answer would.
 *
 * Cache-Control (D7): `private, max-age=<ttl>` + `Vary: Cookie` on every
 * response of a cached family while the cache is enabled — browser
 * back-navigation renders instantly. `private` forbids shared caches. The
 * bounded revocation trade-off is decided and documented at plan D7.
 */
import { createHash } from 'node:crypto'
import { setHeader } from 'h3'
import type { H3Event } from 'h3'
import { appendServerTiming } from '../observability/request-timing'
import { copilotFinanceMode } from '../reports/copilot-mode'
import { requestClock } from '../utils/request-clock'
import type { Session } from '../utils/auth'
import type { ResolvedRegionRequest } from './region-scope'

const MAX_ENTRIES = 256

interface Entry {
  json: string
  expiresAt: number
}

const store = new Map<string, Entry>()
const inflight = new Map<string, Promise<string>>()

/** Test-observable counters (unit/integration tests assert transitions). */
export interface ReportCacheStats {
  responseHits: number
  responseMisses: number
  responseJoins: number
  memoHits: number
  memoMisses: number
  memoJoins: number
}
const stats: ReportCacheStats = {
  responseHits: 0,
  responseMisses: 0,
  responseJoins: 0,
  memoHits: 0,
  memoMisses: 0,
  memoJoins: 0,
}

export function reportCacheStats(): ReportCacheStats {
  return { ...stats }
}

/** Tests only: drop every entry, inflight handle and counter. */
/**
 * Bumped by every reset. A computation that STARTED before the reset must not
 * write its result afterwards.
 *
 * Without this, invalidation is only half-effective and in the worst case
 * useless: a report begins computing, a Migrate commits and clears the cache,
 * and the in-flight computation then stores its PRE-migrate answer for the full
 * TTL. The admin's correction lands and the very next reader still sees the old
 * figure — the failure this cache reset was added to prevent, reintroduced by
 * the reset's own timing.
 */
let generation = 0

export function resetReportCache(): void {
  generation++
  store.clear()
  inflight.clear()
  for (const k of Object.keys(stats) as (keyof ReportCacheStats)[]) stats[k] = 0
}

/**
 * The active TTL, read PER CALL so tests and the perf harness can toggle it.
 * Under VITEST the default is 0 (disabled) — the override still wins, so
 * cache tests opt in explicitly.
 */
export function reportCacheTtlMs(): number {
  const raw = process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  }
  // Value-compared, not presence-checked: VITEST=0/false in a prod env must
  // not disable the cache (month-floor.ts:62 precedent).
  return process.env.VITEST === 'true' ? 0 : 60_000
}

/**
 * The caller's effective identity, as key material: the four RLS GUC inputs
 * (server/db/request-rls.ts) plus the PRE-collapse role — platform-admin and
 * global-finops share GUCs but stay separate entries (the safe direction).
 * Persona impersonation rewrites the effective session, so this moves with it.
 */
export function identityKey(session: Session): string {
  return [session.teammateId, session.role, session.regionId, session.orgPath].join('|')
}

/**
 * The RESOLVED authorization output of a `/reports/region*` request, as key
 * material: the width, every grant flag, and — for the clamped width — the
 * engine's own `RegionalScope.scopeKey` (effective role, home/effective
 * region, ou id + ou PATH, live-GUC echo; the ou path is already in it
 * because a moved subtree keeps its id).
 */
export function regionRequestKey(req: ResolvedRegionRequest): string {
  const g = req.grant
  const grant = `${g.tab}:${g.allRegions}:${g.crossRegion}:${g.ownRegion}:${g.landing}`
  return req.width === 'all-regions'
    ? `all|${grant}`
    : `region|${grant}|${req.scope.scopeKey}`
}

/**
 * Normalized query material: sorted entries, undefined dropped — so key order
 * in the URL can never mint a second entry, and `month=` vs `from/to=` of the
 * same span can never alias (they serialize differently by construction).
 */
export function normalizedQuery(query: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
}

function hashKey(material: readonly (string | null | undefined)[]): string {
  return createHash('sha256')
    .update(JSON.stringify(material))
    .digest('hex')
}

function readFresh(key: string, now: number): string | undefined {
  const e = store.get(key)
  if (!e) return undefined
  if (e.expiresAt <= now) {
    store.delete(key)
    return undefined
  }
  return e.json
}

function write(key: string, json: string, ttlMs: number, now: number): void {
  store.set(key, { json, expiresAt: now + ttlMs })
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

type Kind = 'response' | 'memo'

/** The path `cached` took — O1's `cache;desc=<outcome>` Server-Timing marker. */
type CacheOutcome = 'hit' | 'miss' | 'join'

async function cached<T>(
  kind: Kind,
  keyMaterial: readonly (string | null | undefined)[],
  compute: () => Promise<T>,
  // Out-param, not a return-shape change: the stats path already knows which
  // branch ran, and every existing caller keeps its `Promise<T>` contract.
  onOutcome?: (outcome: CacheOutcome) => void,
): Promise<T> {
  const ttlMs = reportCacheTtlMs()
  if (ttlMs <= 0) return compute()
  const key = `${kind}:${hashKey(keyMaterial)}`
  const now = Date.now()

  const fresh = readFresh(key, now)
  if (fresh !== undefined) {
    stats[kind === 'response' ? 'responseHits' : 'memoHits']++
    onOutcome?.('hit')
    return JSON.parse(fresh) as T
  }

  const joined = inflight.get(key)
  if (joined) {
    stats[kind === 'response' ? 'responseJoins' : 'memoJoins']++
    onOutcome?.('join')
    return JSON.parse(await joined) as T
  }

  stats[kind === 'response' ? 'responseMisses' : 'memoMisses']++
  onOutcome?.('miss')
  const startedAt = generation
  const run = (async () => {
    const value = await compute()
    const json = JSON.stringify(value)
    // Still the caller's ANSWER either way — only the STORE is skipped. A
    // request that raced an invalidation gets its (correct-as-of-read) data;
    // what it must not do is pin that read for the next sixty seconds.
    if (startedAt === generation) write(key, json, ttlMs, Date.now())
    return json
  })()
  inflight.set(key, run)
  try {
    return JSON.parse(await run) as T
  } finally {
    /*
     * ONLY IF IT IS STILL OURS. An unconditional delete removes whatever is
     * under the key, and after an invalidation a NEW computation can be
     * registered there — so the old run's cleanup would evict the new one's
     * promise, and every subsequent caller would recompute instead of joining
     * it. The single-flight quietly stops being single.
     *
     * `run` IS THE COMPARISON, so it is deliberately not awaited — this is
     * reference identity, asking "is the promise under this key still mine".
     * Awaiting would compare the resolved JSON string against a Promise, which
     * is never equal, so the entry would never be deleted and `inflight` would
     * grow without bound. A static analyser reads this as a missing `await`
     * (github-code-quality flagged it on PR #241); it is not one.
     */
    if (inflight.get(key) === run) inflight.delete(key)
  }
}

/**
 * The response cache for one report GET. `keyMaterial` is the handler's
 * ordered material (endpoint id, path params, normalized query, identity,
 * resolved scope/grants); the UTC day and copilot mode are appended here so
 * no handler can forget them. Sets the D7 headers on hit AND miss while the
 * cache is enabled; a disabled cache (TTL 0) is a pure passthrough with no
 * headers — exactly today's behaviour.
 */
export async function withReportCache<T>(
  event: H3Event,
  keyMaterial: readonly (string | null | undefined)[],
  compute: () => Promise<T>,
): Promise<T> {
  const ttlMs = reportCacheTtlMs()
  if (ttlMs <= 0) return compute()
  /*
   * The UTC day comes from the REQUEST CLOCK, not a fresh `new Date()` (F1/D1).
   * A cache key holding its own clock read is a second definition of today: it
   * could bucket the key on one day while the SQL frontier that produced the
   * body used another, and the body would keep serving yesterday's right edge
   * across the rollover with no test able to pin the boundary
   * (clock-rot-audit.md §H.6).
   */
  const utcDay = requestClock(event).today
  let outcome: CacheOutcome | undefined
  const value = await cached(
    'response',
    [...keyMaterial, utcDay, copilotFinanceMode()],
    compute,
    (o) => {
      outcome = o
    },
  )
  // Headers only AFTER a successful body (v2-M1): a thrown 5xx must never
  // leave with `max-age` on it — an error is not a fact worth keeping.
  setHeader(event, 'cache-control', `private, max-age=${Math.floor(ttlMs / 1000)}`)
  setHeader(event, 'vary', 'Cookie')
  // O1 (performance-observability-baseline.md §O1): the cache marker rides
  // Server-Timing. This lands DURING the handler; the plugin's beforeResponse
  // write appends after it — both sides append, neither clobbers.
  if (outcome !== undefined) appendServerTiming(event, `cache;desc=${outcome}`)
  return value
}

/**
 * The function-level scan memo (D8) — the cross-endpoint duplicate reads
 * (chargeback trend, daily metrics, concentration) computed once per
 * (identity, scope, window) per TTL, shared across CONCURRENT requests by the
 * same single-flight. No headers: this is not a response. Sharing requires
 * identical key material — a different window is a different scan.
 */
export async function memoizedScan<T>(
  keyMaterial: readonly (string | null | undefined)[],
  compute: () => Promise<T>,
): Promise<T> {
  return cached('memo', keyMaterial, compute)
}
