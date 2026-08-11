/*
 * useServerClock — the client's ONLY answer to "what day is it".
 *
 * `docs/design/clock-and-day-boundary.md` D3: "today" on a chart means the last
 * UTC day our pollers have covered. That is a provider-derived fact; `new Date()`
 * cannot know it. So the browser stops computing it and reads it.
 *
 * ONE FETCH, SHARED. Every caller passes the same `useFetch` key, so Nuxt shares
 * one promise and one payload across every component on the page — and across
 * the SSR/hydration boundary, which is the failure the reference pattern already
 * warns about (`ScopeRegionalView.vue`: "NEVER `new Date()` at setup scope: SSR
 * and client hydration could evaluate that across a UTC midnight and disagree").
 * Two components cannot get two clocks.
 *
 * NULL UNTIL IT LANDS, AND THAT IS DELIBERATE. There is no browser fallback.
 * A fallback would be a second clock — the exact thing this retires — and it
 * would be the one in force during the moment a page is most likely to be
 * screenshotted. Callers render their clock-dependent parts only once `ready`.
 *
 * CONSUMED AS A NUXT AUTO-IMPORT, never an explicit `import`. That is the house
 * convention for `app/composables/**` (see `useReportState`) and it is what lets
 * a unit test `vi.stubGlobal('useServerClock', …)` to pin the clock for a mounted
 * component — the client-side half of the test seam D3 asks for.
 * `tests/helpers/server-clock.ts` is that stub.
 */
import { computed } from 'vue'
import type { ServerClock } from '#shared/reports/clock'

/*
 * THREE READS, BECAUSE THREE ARE READ. This returned a `now` / `ready` / `error`
 * / `refresh` facade as well; nothing in `app/**` ever consumed one (external
 * review). A composable that publishes an error channel no caller handles reads
 * as "failure is dealt with somewhere" when it is not — the honest shape is the
 * one the callers actually use, and the null-until-it-lands contract above is
 * how a caller detects the un-landed clock (`clock.value == null`).
 */
export function useServerClock() {
  const { data } = useFetch<ServerClock>('/api/v1/clock', {
    key: 'server-clock',
    // A clock must not be answered from a cache, on either side of the wire.
    retry: false,
  })

  const clock = computed<ServerClock | null>(() => data.value ?? null)
  /** The still-filling UTC day. Drawn partial; never an axis edge. */
  const today = computed<string | null>(() => clock.value?.today ?? null)
  /** The last COMPLETE UTC day. THE axis edge. */
  const settledThrough = computed<string | null>(() => clock.value?.settledThrough ?? null)

  return { clock, today, settledThrough }
}
