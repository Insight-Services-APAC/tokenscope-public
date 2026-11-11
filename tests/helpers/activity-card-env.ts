/*
 * The Nuxt auto-imports ActivityCard reads (#578): the route (its filters live
 * in the address), the router, its own lazy read of your projects, and the
 * server clock (the date picker's upper bound). All are bare globals at
 * runtime, so a mounted test stubs them here.
 */
import { computed, reactive, ref } from 'vue'
import { vi } from 'vitest'

export interface ActivityCardEnv {
  route: { query: Record<string, string> }
  query: Record<string, string>
  replace: ReturnType<typeof vi.fn>
  projects: { id: string; code: string; display_name: string }[]
}

export function stubActivityCardEnv(
  opts: {
    query?: Record<string, string>
    projects?: { id: string; code: string; display_name: string }[]
    projectsError?: unknown
    today?: string | null
  } = {},
): ActivityCardEnv {
  const route = reactive({ query: { ...(opts.query ?? {}) } as Record<string, string> })
  const replace = vi.fn((to: { query: Record<string, string> }) => {
    route.query = { ...to.query }
    return Promise.resolve()
  })
  const projects = opts.projects ?? [
    { id: 'p1', code: 'ACME-1', display_name: 'Acme' },
    { id: 'p2', code: 'FALCON', display_name: 'Project Falcon' },
  ]
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => ({ replace }))
  vi.stubGlobal('useLazyFetch', () => ({
    data: ref({ projects }),
    error: ref(opts.projectsError ?? null),
    pending: ref(false),
    refresh: vi.fn(),
  }))
  const today = opts.today === undefined ? '2026-11-11' : opts.today
  vi.stubGlobal('useServerClock', () => ({
    clock: computed(() => null),
    today: computed(() => today),
    settledThrough: computed(() => today),
  }))
  return { route, query: route.query, replace, projects }
}
