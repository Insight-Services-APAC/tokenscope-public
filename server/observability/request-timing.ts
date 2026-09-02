/*
 * O1 — per-request DB timing (docs/design/performance-observability-baseline.md).
 *
 * The AsyncLocalStorage store one /api request accumulates into, the
 * API-PRESERVING instrumentation of the REQUEST pool's postgres.js client
 * (dr-H2), and the Server-Timing writers the Nitro plugin
 * (server/plugins/server-timing.ts) registers. Substance lives here, not in
 * the plugin, so tests can drive it without a built server (the
 * server/plugins/oidc-session-store.ts precedent).
 *
 * Constraints (design §O1):
 * - The wrapper calls through SYNCHRONOUSLY and returns the ORIGINAL lazy
 *   PendingQuery — drizzle chains `.values()` on it synchronously
 *   (drizzle-orm/postgres-js/session.js). Settlement is timed by a
 *   NON-consuming subscription: postgres.js `Query#then` triggers `handle()`
 *   (execution — postgres/src/query.js), the NATIVE `Promise.prototype.then`
 *   does not, and `Query[Symbol.species]` is `Promise`, so subscribing neither
 *   starts the query early nor constructs the subclass.
 * - The handles minted for BOTH `begin` and `savepoint` callbacks are wrapped,
 *   recursively (postgres/src/index.js `scope()`): every `withRlsContext`
 *   request runs inside `begin`, and drizzle's nested transactions run on
 *   savepoint handles — an unwrapped handle drops the whole transaction's
 *   statements.
 * - The ALS store is read AT CALL TIME (interleaved requests attribute
 *   correctly); no store = pure pass-through. Only the request pool is wrapped
 *   (server/db/index.ts) — the worker lane and scripts are untouched.
 * - Never any SQL text — durations and counts only.
 * - postgres.js's own BEGIN/COMMIT/SAVEPOINT bookkeeping goes through its
 *   internal template tag, not `unsafe`, and is deliberately uncounted:
 *   `db;dur`/`stmts` describe the application's statements.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { H3Event } from 'h3'

export interface RequestTimingStore {
  /** Summed statement settlement time (ms), unsafe() call → settle. */
  dbMs: number
  /** Statements SETTLED (same population `dbMs` sums — counted on settle). */
  stmts: number
  /** performance.now() at store creation; `app;dur` measures from here. */
  startedAt: number
}

export const requestTimingStorage = new AsyncLocalStorage<RequestTimingStore>()

export function createRequestTimingStore(): RequestTimingStore {
  return { dbMs: 0, stmts: 0, startedAt: performance.now() }
}

type AnyFn = (...args: unknown[]) => unknown

/**
 * Wrap the request pool's postgres.js client. API-preserving (dr-H2): every
 * property/call forwards to the real client; only `unsafe` (drizzle's sole
 * statement path — session.js execute/all/query/queryObjects) is timed, and
 * `begin`/`savepoint` are intercepted purely to wrap the scoped handle their
 * callback receives.
 */
export function instrumentRequestClient<T extends object>(client: T): T {
  return wrapHandle(client)
}

function wrapHandle<T extends object>(handle: T): T {
  // One wrapper per (handle, prop): `unsafe` is hit once per statement, so the
  // closures are built lazily and reused.
  const cache = new Map<PropertyKey, AnyFn>()
  return new Proxy(handle, {
    get(target, prop) {
      if (prop === 'unsafe' || prop === 'begin' || prop === 'savepoint') {
        const original = Reflect.get(target, prop) as unknown
        // `savepoint` only exists on transaction-scoped handles; a non-function
        // (top-level client) falls through untouched.
        if (typeof original === 'function') {
          let fn = cache.get(prop)
          if (fn === undefined) {
            fn =
              prop === 'unsafe'
                ? makeTimedUnsafe(original as AnyFn, target)
                : makeScopeWrapper(original as AnyFn, target)
            cache.set(prop, fn)
          }
          return fn
        }
      }
      return Reflect.get(target, prop)
    },
  })
}

function makeTimedUnsafe(unsafe: AnyFn, target: object): AnyFn {
  return function timedUnsafe(...args: unknown[]): unknown {
    // SYNCHRONOUS call-through; the ORIGINAL PendingQuery is what returns.
    const query = unsafe.apply(target, args)
    // ALS read AT CALL TIME; no store (boot, off-request work) = pass-through.
    const store = requestTimingStorage.getStore()
    if (store !== undefined && query instanceof Promise) {
      const t0 = performance.now()
      const settle = () => {
        store.dbMs += performance.now() - t0
        store.stmts += 1
      }
      // Non-consuming subscription — see the module header for why this MUST
      // be the native then (Query#then would trigger execution). The derived
      // promise settles via `settle` on both paths, so it can never surface an
      // unhandled rejection; the caller's own rejection flow is untouched.
      // KNOWN GAP (r3-L9): a `.cursor()` consumer replaces the query's
      // resolvers, so its promise never settles and the statement goes
      // uncounted — no request-path handler uses cursors today.
      void Promise.prototype.then.call(query, settle, settle)
    }
    return query
  }
}

/**
 * `begin(fn)` / `begin(options, fn)` / `savepoint(fn)` / `savepoint(name, fn)`:
 * wrap the scoped handle postgres.js passes to the trailing callback so its
 * `unsafe` is timed and its own `savepoint` recurses. Non-callback forms
 * (postgres.js's internal template-tag savepoint) pass through unwrapped —
 * drizzle never uses them.
 */
function makeScopeWrapper(method: AnyFn, target: object): AnyFn {
  return function wrappedScope(...args: unknown[]): unknown {
    const last = args.length - 1
    if (last >= 0 && typeof args[last] === 'function') {
      const fn = args[last] as AnyFn
      args = args.slice()
      args[last] = function wrappedScopeCallback(this: unknown, ...cbArgs: unknown[]): unknown {
        const scoped = cbArgs[0]
        if (scoped !== null && (typeof scoped === 'object' || typeof scoped === 'function')) {
          cbArgs[0] = wrapHandle(scoped as object)
        }
        return fn.apply(this, cbArgs)
      }
    }
    return method.apply(target, args)
  }
}

/* ── Server-Timing writers (the Nitro plugin's substance) ─────────────────── */

/**
 * Append one Server-Timing component, preserving anything already on the
 * header (comma-separated per spec — `withReportCache`'s `cache;desc=…` lands
 * during the handler, BEFORE the plugin's `beforeResponse` write). Honours the
 * escape hatch (`NUXT_SERVER_TIMING=off`, design §O1) and never throws on a
 * late hook: headersSent = silent no-op (dr-H1).
 */
export function appendServerTiming(event: H3Event, component: string): void {
  if (process.env.NUXT_SERVER_TIMING === 'off') return
  const res = event.node?.res
  if (!res || res.headersSent) return
  const existing = res.getHeader('Server-Timing')
  const prefix = Array.isArray(existing)
    ? existing.join(', ')
    : existing !== undefined
      ? String(existing)
      : ''
  res.setHeader('Server-Timing', prefix.length > 0 ? `${prefix}, ${component}` : component)
}

/**
 * Root-handler wrap: run the ENTIRE request — handler, middleware, and the
 * `beforeResponse` hook h3 fires inside `app.handler` — under one ALS store.
 *
 * NOT a `request`-hook `enterWith`: a hook callback is awaited by its caller,
 * and `enterWith` inside an awaited callback mutates only THAT callback's
 * async scope — the parent resumes in its own context, so the handler and
 * `beforeResponse` would see no store. Proven live on the built artifact
 * (2026-08-20: cache markers present, db/stmts/app absent). Reassigning
 * `h3App.handler` is Nitro's own in-core pattern
 * (nitropack/dist/runtime/internal/app.mjs:140-141), and `toNodeListener`
 * dereferences `.handler` per request. Gated to /api/ (static assets
 * excluded, design §O1) and to the escape hatch.
 */
export function wrapAppHandlerWithTiming<
  T extends (event: H3Event) => unknown,
>(handler: T): (event: H3Event) => unknown {
  return (event: H3Event) => {
    if (process.env.NUXT_SERVER_TIMING === 'off') return handler(event)
    if (!event.path?.startsWith('/api/')) return handler(event)
    const store = createRequestTimingStore()
    // ALSO stashed on the event: when the handler REJECTS, h3 catches the
    // rejection outside this callback and runs error handling +
    // beforeResponse there — outside the ALS scope. The context fallback
    // keeps timing on buffered error responses (review r3-M2).
    ;(event.context as Record<string, unknown>).__requestTiming = store
    return requestTimingStorage.run(store, () => handler(event))
  }
}

/**
 * `beforeResponse` hook: write the header. `app;dur` is HANDLER wall time,
 * deliberately not named total (dr-M3 — serialization and transfer happen
 * after this hook; the browser's TTFB/download columns are the complement).
 * `db;dur` SUMS per-statement settlement spans: under pipelined waves
 * (Promise.all on one connection) each span includes queue-wait behind its
 * wave-mates, so db;dur can exceed app;dur — an attribution signal ("the
 * time lives in the DB round-trips"), never additive wall time.
 * The /api/ re-check is belt-and-braces: the store is scoped by
 * `requestTimingStorage.run`, which cannot bleed past its callback.
 */
export function writeServerTiming(event: H3Event): void {
  const store =
    requestTimingStorage.getStore() ??
    ((event.context as Record<string, unknown>).__requestTiming as
      | RequestTimingStore
      | undefined)
  if (store === undefined) return
  if (!event.path?.startsWith('/api/')) return
  const appMs = performance.now() - store.startedAt
  appendServerTiming(
    event,
    `db;dur=${store.dbMs.toFixed(1)}, stmts;desc="${store.stmts}", app;dur=${appMs.toFixed(1)}`,
  )
}
