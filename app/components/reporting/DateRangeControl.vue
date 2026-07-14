<script setup lang="ts">
/*
 * DateRangeControl — the period control for the Across-regions / Regional /
 * Cost-centre reporting scopes. (Finance has its own retrospective month/quarter
 * picker — FinancePeriodControl.)
 *
 * Usage/FinOps is tracked in CALENDAR periods, not rolling day-windows, so the
 * presets are: This month (MTD + live forecast) · Last month (a complete month,
 * so MoM works) · This quarter (quarter-to-date) · Custom. It binds directly to
 * the URL state via useReportState():
 *   - This month  → clears month + from/to (the scopes default to the current month)
 *   - Last month  → sets ?month = last complete month (month mode, no range)
 *   - This quarter→ sets the quarter-to-date ?from/?to range (clears ?month)
 *   - Custom      → an explicit from/to range
 * Month presets use ?month (keeps forecast/MoM eligibility); quarter + custom use
 * the ?from/?to range. Every sub-resource (drivers, drill, export) windows on the
 * SAME active period, so figures reconcile in range mode too — only the
 * month-anchored forecast/MoM null out for a range (they have no meaning over a span).
 * Each write is ONE patch() so two router.replace() calls never race.
 */
import { computed, ref, watch } from 'vue'

const rs = useReportState()

// ── Day/period helpers (UTC, to dodge the bare-date tz off-by-one) ───────────
function isoUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
function todayMs(): number {
  const n = new Date()
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())
}
function daysAgo(n: number): string {
  return isoUTC(todayMs() - n * 86_400_000)
}
/** Last COMPLETE calendar month, `YYYY-MM` (day 0 of this month = last of prior). */
function lastCompleteMonth(): string {
  const n = new Date()
  const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
/** Current calendar month, `YYYY-MM` — the "This month" default expressed via ?month. */
function currentMonth(): string {
  const n = new Date()
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`
}
/** Current quarter TO DATE: [quarter-start, today] (inclusive). */
function currentQuarterRange(): { from: string; to: string } {
  const n = new Date()
  const qStartMonth = Math.floor(n.getUTCMonth() / 3) * 3 // 0,3,6,9
  return {
    from: `${n.getUTCFullYear()}-${String(qStartMonth + 1).padStart(2, '0')}-01`,
    to: daysAgo(0),
  }
}

const from = computed(() => rs.from.value)
const to = computed(() => rs.to.value)

// Which preset the current URL state matches (drives the active pill).
const mode = computed<'month' | 'lastMonth' | 'quarter' | 'custom'>(() => {
  if (from.value && to.value) {
    const q = currentQuarterRange()
    // Match "This quarter" by the quarter-START alone. `to` is set to today when the
    // preset is CLICKED, but comparing stored `to` against a freshly-recomputed today
    // would flip the pill off after UTC midnight; the from-anchor names the current
    // quarter's to-date range. Tradeoff (accepted, LOW): a hand-crafted custom range
    // that merely STARTS on a quarter's first day also reads as "This quarter".
    return from.value === q.from ? 'quarter' : 'custom'
  }
  if (rs.month.value) {
    if (rs.month.value === lastCompleteMonth()) return 'lastMonth'
    // A `?month=<current month>` deep-link IS the "This month" default expressed via
    // ?month — treat it as 'month' so it doesn't read as 'custom' and auto-open the
    // editor seeded with an unrelated 30-day range (#6). Only a genuinely arbitrary past
    // month (neither current nor last-complete) stays ambiguous → 'custom'.
    if (rs.month.value === currentMonth()) return 'month'
    return 'custom'
  }
  return 'month' // nothing set → the scope's current-month default
})

const PRESETS = [
  { key: 'month', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'custom', label: 'Custom' },
] as const

// ── Custom range: local draft, applied when both dates are a valid ordering ──
const showCustom = ref(mode.value === 'custom')
const draftFrom = ref(from.value ?? daysAgo(29))
const draftTo = ref(to.value ?? daysAgo(0))

// Reflect an external URL range change back into the draft + expansion.
watch([from, to, mode], () => {
  if (mode.value === 'custom' && from.value && to.value) {
    draftFrom.value = from.value
    draftTo.value = to.value
    showCustom.value = true
  }
})

// Mirror the server cap (server/reporting/params.ts MAX_RANGE_DAYS) so an
// over-span pick shows an inline message instead of the report 400-ing.
const MAX_RANGE_DAYS = 400
const rangeError = computed<string | null>(() => {
  const f = draftFrom.value
  const t = draftTo.value
  if (!f || !t) return null
  if (f > t) return 'From must be on or before To.'
  const span = (Date.parse(t) - Date.parse(f)) / 86_400_000 + 1
  if (span > MAX_RANGE_DAYS) return `Range too large — pick at most ${MAX_RANGE_DAYS} days.`
  return null
})
const rangeInvalid = computed(() => rangeError.value != null)

function selectPreset(key: (typeof PRESETS)[number]['key']) {
  if (key === 'month') {
    rs.patch({ month: null, from: null, to: null }) // → the scope's current-month default
    showCustom.value = false
  } else if (key === 'lastMonth') {
    rs.patch({ month: lastCompleteMonth(), from: null, to: null }) // month mode (MoM eligible)
    showCustom.value = false
  } else if (key === 'quarter') {
    const q = currentQuarterRange()
    rs.patch({ month: null, from: q.from, to: q.to })
    showCustom.value = false
  } else {
    // Open the custom editor seeded from the current window (or a 30-day default).
    // Do NOT apply yet — applying here would silently re-window the report just
    // because the user clicked "Custom" to open the picker. The window changes only
    // when they pick a date (@change="applyCustom" on the inputs).
    draftFrom.value = from.value ?? daysAgo(29)
    draftTo.value = to.value ?? daysAgo(0)
    showCustom.value = true
  }
}

function applyCustom() {
  if (!draftFrom.value || !draftTo.value || rangeInvalid.value) return
  rs.patch({ from: draftFrom.value, to: draftTo.value, month: null })
}

// A pill reads active when it is the matched mode, plus Custom stays lit while its
// editor is open even before a valid range is applied.
function isActive(key: string): boolean {
  if (key === 'custom') return mode.value === 'custom' || showCustom.value
  return mode.value === key && !showCustom.value
}
</script>

<template>
  <div
    class="inline-flex flex-col gap-2"
    role="group"
    aria-label="Reporting period"
    data-testid="date-range-control"
  >
    <div class="inline-flex p-0.5 bg-calm-2 rounded-lg gap-0.5 w-fit">
      <button
        v-for="p in PRESETS"
        :key="p.key"
        type="button"
        :aria-pressed="isActive(p.key)"
        class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap"
        :class="
          isActive(p.key)
            ? 'bg-white text-brand-harmony shadow-sm'
            : 'text-carbon-2 hover:text-brand-harmony'
        "
        :data-testid="`date-range-${p.key}`"
        @click="selectPreset(p.key)"
      >
        {{ p.label }}
      </button>
    </div>

    <div v-if="showCustom" class="inline-flex items-center gap-2 flex-wrap" data-testid="date-range-editor">
      <input
        v-model="draftFrom"
        type="date"
        :max="draftTo || undefined"
        aria-label="From date"
        class="border border-calm-2 rounded-md px-2 py-1 text-sm text-carbon-1 bg-white focus:border-brand-harmony focus:outline-none"
        data-testid="date-range-from"
        @change="applyCustom"
      >
      <span class="text-carbon-3 text-xs">to</span>
      <input
        v-model="draftTo"
        type="date"
        :min="draftFrom || undefined"
        aria-label="To date"
        class="border border-calm-2 rounded-md px-2 py-1 text-sm text-carbon-1 bg-white focus:border-brand-harmony focus:outline-none"
        data-testid="date-range-to"
        @change="applyCustom"
      >
      <span v-if="rangeError" class="text-[11px] text-rag-red" data-testid="date-range-invalid">
        {{ rangeError }}
      </span>
    </div>
  </div>
</template>
