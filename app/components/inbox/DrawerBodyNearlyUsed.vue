<script setup lang="ts">
/*
 * DrawerBodyNearlyUsed — "Budget nearly used" (#575), raised once per project
 * per month at 80% of the budget in force (server/workers/budget-alert.ts).
 *
 * The figures are the run that raised the alert, and so is the pace line: it
 * is drawn with the same `budgetPace` / `projectedMonthEnd` My projects uses,
 * from the UTC day of the month the server counted (`dayOfMonth`), never the
 * browser's clock. Before PACE_MIN_DAYS there is no pace line, as on My
 * projects. Body fields may be missing on an odd item: each renders "not
 * recorded on this alert" rather than a blank or $0.00.
 */
import UiPbar from '../ui/Pbar.vue'
import UiBadge from '../ui/Badge.vue'
import { fmtUsd } from '../../composables/useFormat'
import {
  PACE_MIN_DAYS,
  budgetPace,
  budgetPaceKind,
  budgetPaceLabel,
  projectedMonthEnd,
} from '../../composables/useRagState'
import { MISSING } from './drawer-copy'

const props = defineProps<{
  body: Record<string, unknown>
  /* Whether THIS reader can open the budget editor (the list route emits the
   * allocation link only then). The alert also reaches contributors, who
   * cannot add a top-up. */
  canTopUp?: boolean
}>()

function num(k: string): number | null {
  const v = props.body[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const usedUsd = num('usedUsd')
const capUsd = num('capUsd')
const day = num('dayOfMonth')
const daysInMonth = num('daysInMonth')
const pct = usedUsd !== null && capUsd !== null && capUsd > 0 ? usedUsd / capUsd : null

const pace =
  usedUsd !== null && capUsd !== null && day !== null && daysInMonth !== null
    ? budgetPace(usedUsd, capUsd, day, daysInMonth)
    : null
const projected =
  usedUsd !== null && day !== null && daysInMonth !== null && day >= PACE_MIN_DAYS && day < daysInMonth
    ? projectedMonthEnd(usedUsd, day, daysInMonth)
    : null
const monthEnd = (() => {
  const m = typeof props.body.month === 'string' ? /^(\d{4})-(\d{2})/.exec(props.body.month) : null
  if (!m || daysInMonth === null) return null
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, daysInMonth)),
  )
})()
</script>

<template>
  <section class="space-y-5">
    <div>
      <div class="flex items-baseline gap-2 flex-wrap">
        <span class="text-2xl font-bold text-carbon" style="font-variant-numeric: tabular-nums" data-testid="nearly-used-spend">
          {{ usedUsd !== null ? fmtUsd(usedUsd) : MISSING }}
        </span>
        <span class="text-sm text-carbon-2" style="font-variant-numeric: tabular-nums" data-testid="nearly-used-of">
          of {{ capUsd !== null ? fmtUsd(capUsd) : MISSING }}
          <template v-if="day !== null && daysInMonth !== null"> · day {{ day }} of {{ daysInMonth }} (UTC)</template>
        </span>
      </div>
      <UiPbar v-if="pct !== null" :pct="pct" size="lg" class="mt-3" />
      <p v-if="pace && projected !== null && monthEnd" class="mt-2 text-xs text-carbon-2 flex items-center gap-2 flex-wrap" data-testid="nearly-used-pace">
        <UiBadge :kind="budgetPaceKind(pace)">{{ budgetPaceLabel(pace) }}</UiBadge>
        <span>on pace for about <strong>{{ fmtUsd(projected, { whole: true }) }}</strong> by {{ monthEnd }}</span>
      </p>
      <p v-else-if="day !== null && day < PACE_MIN_DAYS" class="mt-2 text-xs text-carbon-3" data-testid="nearly-used-too-early">
        Too early in the month to project.
      </p>
      <p class="mt-2 text-[11px] text-carbon-3">These figures are from when the alert was sent. The project page shows today's.</p>
    </div>
    <div>
      <h3 class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">What you can do</h3>
      <p v-if="canTopUp" class="text-sm text-carbon-2 leading-relaxed" data-testid="nearly-used-can-top-up">
        Add a top-up, or look at what is driving the spend on the project page. Members can also ask you for more budget.
      </p>
      <p v-else class="text-sm text-carbon-2 leading-relaxed" data-testid="nearly-used-member">
        Look at what is driving the spend on the project page. If the project needs more, ask for more budget there;
        the project's manager decides.
      </p>
    </div>
    <div>
      <h3 class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">What happens if you do nothing</h3>
      <p class="text-sm text-carbon-2 leading-relaxed">
        Nothing is blocked. Budgets here are for reporting. You will get an "Over budget" alert if spend goes
        over the project's budget.
      </p>
    </div>
  </section>
</template>
