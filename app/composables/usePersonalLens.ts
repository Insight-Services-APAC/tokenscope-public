/*
 * usePersonalLens — the ADR 0012 lens on the PERSONAL surfaces (`/` and
 * `/consumption`).
 *
 * Same concept, same URL key (`?lane=`), same default (`usage`) and the same
 * validator as the reporting area's `useReportState().lane` — but not the same
 * owner, because `useReportState` owns the reporting query as a whole
 * (`scope`/`region`/`ou`/`cc`) and writing through it from the dashboard would
 * stamp `scope=region` onto a URL that has no report scope.
 *
 * Like the reporting lane, only `chargeback` is persisted: `usage` is the
 * default and stays out of the URL, so a default-lens link is byte-stable.
 */
import { computed, type WritableComputedRef } from 'vue'
import type { LocationQueryRaw } from 'vue-router'
import { parseSpendLens, type SpendLens } from '#shared/usage/lens'

export function usePersonalLens(): WritableComputedRef<SpendLens> {
  const route = useRoute()
  const router = useRouter()
  return computed<SpendLens>({
    get: () => parseSpendLens(route.query.lane),
    set: (v: SpendLens) => {
      const query: LocationQueryRaw = { ...route.query }
      if (v === 'usage') delete query.lane
      else query.lane = v
      // replace, not push: flipping the lens is a re-lens of the page you are
      // on, not a new place — Back should leave the page, not undo the toggle.
      router.replace({ query })
    },
  })
}
