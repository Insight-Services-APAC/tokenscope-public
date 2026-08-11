/*
 * THE CLIENT-SIDE CLOCK SEAM, for unit tests.
 *
 * `clock-and-day-boundary.md` D3 claims the fix is what makes the behaviour
 * testable: "a fake clock injected once is seen by the server, the controls and
 * the charts alike". Server-side that seam already existed (~15 modules take an
 * injectable `now`); the client had none, which is why five browser clocks
 * carried ZERO test signal and the parity gate could never shoot a real day-1.
 *
 * This is that seam. `useServerClock` is a Nuxt auto-import — a bare global at
 * runtime — so stubbing it pins the clock for every component under test at
 * once, exactly as one server-resolved payload does in the browser.
 *
 * NOTE THE DIFFERENCE FROM `vi.useFakeTimers`. Faking `Date` legitimises a
 * browser-owned clock rather than replacing it (the mistake
 * `my-projects-list.test.ts` made): once the values come from the server, moving
 * the system clock controls nothing. This stub moves the thing that is actually
 * in force.
 */
import { computed, ref, type Ref } from 'vue'
import { vi } from 'vitest'
import { resolveServerClock, type ServerClock } from '../../shared/reports/clock'

export interface StubbedServerClock {
  /** Mutable, so a test can land the clock AFTER mount and assert the transition. */
  value: Ref<ServerClock | null>
}

/**
 * Pin the client clock. Pass an instant (`2026-08-15T12:00:00Z`) or a resolved
 * clock; pass `null` to simulate the pre-landing state, where a control must
 * refuse to guess rather than fall back to the browser.
 */
export function stubServerClock(at: string | ServerClock | null = '2026-08-15T12:00:00Z'): StubbedServerClock {
  const initial =
    at == null ? null : typeof at === 'string' ? resolveServerClock(new Date(at)) : at
  const value = ref<ServerClock | null>(initial)
  vi.stubGlobal('useServerClock', () => ({
    clock: computed(() => value.value),
    today: computed(() => value.value?.today ?? null),
    settledThrough: computed(() => value.value?.settledThrough ?? null),
  }))
  return { value }
}
