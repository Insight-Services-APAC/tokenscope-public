/*
 * The settling clock's short words, in ONE place: the on-screen chip
 * (SettlingStateChip) and the printed header (#583) must name a state the same
 * way. The copy bank bans "finalised": `settled` is a clock state only, so it
 * reads "Provisional".
 */
import { isRealUtcDay } from '../schemas/activity'
import type { SettlingState } from './types'

export function settlingPill(state: SettlingState): string {
  switch (state) {
    case 'estimated':
      return 'Estimated'
    case 'settling':
      return 'Settling'
    case 'settled':
      return 'Provisional'
  }
  return 'Provisional'
}

/**
 * The day a provider's numbers settle, as the product writes a date: "1 Dec 2026".
 * The value is a UTC day boundary (`settlesAt`), a provider fact, so it is never
 * converted to the viewer's zone. Returns '' for anything that is not a real day.
 */
export function settlingDay(value: string): string {
  const day = value.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isRealUtcDay(day)) return ''
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    Date.parse(`${day}T00:00:00.000Z`),
  )
}
