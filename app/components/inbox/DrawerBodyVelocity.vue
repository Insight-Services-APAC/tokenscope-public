<script setup lang="ts">
/*
 * DrawerBodyVelocity — body content for a velocity-warning inbox item.
 *
 * Per design-notes §Screen 7: small spark chart + suggested action.
 * Spark is an inline-SVG sparkline from `body.weeklySeries` (array of
 * numbers — recent weekly spends; last entry is current week).
 *
 * Body payload fields read (all optional):
 *   - weeklySeries : number[]
 *   - meanUsd      : number    (rolling 4w mean)
 *   - currentUsd   : number    (this week's spend)
 *   - deltaPct     : number    (e.g. 0.38 for +38%)
 *
 * #587: the same What happened / What it means / What to do layout as every
 * other kind. The bell counts UNREAD items (#574), so opening this alert is
 * what clears it; the copy no longer claims Acknowledge does.
 */
import { fmtUsd } from '../../composables/useFormat'

const props = defineProps<{
  body: Record<string, unknown>
}>()

function series(): number[] | null {
  const v = props.body.weeklySeries
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number')) {
    return v as number[]
  }
  return null
}

function num(k: string): number | null {
  const v = props.body[k]
  return typeof v === 'number' ? v : null
}

const points = series()
const maxV = points ? Math.max(...points, 1) : 1
const W = 200
const H = 60
const spark =
  points === null
    ? ''
    : points
        .map((p, i) => {
          const x = (i / Math.max(1, points.length - 1)) * W
          const y = H - (p / maxV) * (H - 4) - 2
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')

const currentUsd = num('currentUsd')
const meanUsd = num('meanUsd')
const deltaPct = num('deltaPct')
// Stroke colour follows severity — Hunger only when the trend actually
// crosses the velocity-worker's 25% threshold; Vision otherwise.
const strokeColor =
  deltaPct !== null && deltaPct >= 0.25 ? 'var(--brand-hunger)' : 'var(--brand-vision)'
</script>

<template>
  <section class="space-y-5">
    <div v-if="points">
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Spend trend ({{ points.length }} weeks)
      </div>
      <svg :width="W" :height="H" viewBox="0 0 200 60" aria-hidden="true">
        <path
          :d="spark"
          fill="none"
          :stroke="strokeColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <div class="text-xs text-carbon-2 mt-2 flex justify-between">
        <span v-if="currentUsd !== null" style="font-variant-numeric: tabular-nums">
          {{ fmtUsd(currentUsd) }} this week
        </span>
        <span
          v-if="deltaPct !== null"
          class="font-bold"
          :class="deltaPct >= 0.25 ? 'text-brand-hunger' : 'text-brand-vision-ink'"
        >
          {{ deltaPct >= 0 ? '+' : '' }}{{ Math.round(deltaPct * 100) }}% vs typical
        </span>
      </div>
    </div>
    <div>
      <h3 class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">What happened</h3>
      <p class="text-sm text-carbon-2 leading-relaxed" data-testid="velocity-happened">
        <template v-if="currentUsd !== null && deltaPct !== null">
          You spent {{ fmtUsd(currentUsd) }} this week, {{ Math.round(Math.abs(deltaPct) * 100) }}%
          {{ deltaPct >= 0 ? 'more' : 'less' }} than a typical week<template v-if="meanUsd !== null"> ({{ fmtUsd(meanUsd) }})</template>.
        </template>
        <template v-else>Your spend this week is well above a typical week for you.</template>
      </p>
    </div>
    <div>
      <h3 class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">What it means</h3>
      <p class="text-sm text-carbon-2 leading-relaxed">
        This is a heads-up, not a limit. Nothing is blocked and no budget changes.
      </p>
    </div>
    <div>
      <h3 class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">What to do</h3>
      <p class="text-sm text-carbon-2 leading-relaxed" data-testid="velocity-todo">
        Look at what changed this week in My usage. A new long-running task or a switch to a
        heavier model often explains it. If the spend is expected, resolve this alert.
      </p>
    </div>
  </section>
</template>
