<script setup lang="ts">
/*
 * ConsumptionHeroCard — "What kind of AI work drove this" (visuals-iter2 §I3).
 *
 * TWO half-height weekly stacks sharing one x-axis, one per BASIS GROUP, each
 * with its own legend header + per-lane MTD chips (share-of-visible WITHIN the
 * group). The juxtaposition is visual only: no scalar and no y-scale spans the
 * two bases (r1-F1); every group carries its basis caption inline (axis rule
 * a). The in-progress current week renders dashed and is excluded from fold
 * ranking and stats (r1-F4). Lane colours are the FIXED registry colours
 * (vendorLaneColor); the folded remainder wears the neutral kit hue.
 */
import { computed } from 'vue'
import type { Vendor } from '#shared/usage/vendor'
import { fmtUsd } from '../../composables/useFormat'
import { vendorLaneColor, VENDOR_LANE_COLORS } from '../../composables/useChartScale'
import { FOLDED_LANE_ID } from '../reporting/charts/fold-lanes'
import { buildConsumptionHero, type HeroGroupWire } from './build-consumption-hero'

const props = defineProps<{
  groups: HeroGroupWire[]
  windowDays: number
  /** SERVER-provided "today" (UTC, `hero.as_of`) — the partial-week anchor.
   *  Never a client `new Date()`: SSR/hydration must agree (iter2 review r1). */
  asOf: string
}>()

const built = computed(() => buildConsumptionHero(props.groups, props.windowDays, props.asOf))

const laneSwatch = (lane: string): string => {
  if (lane === FOLDED_LANE_ID) return 'var(--carbon-3)'
  if (lane in VENDOR_LANE_COLORS) return vendorLaneColor(lane as Vendor)
  return 'var(--carbon-3)'
}

const pct = (share: number) => `${Math.round(share * 100)}%`
const fmtWeek = (d: string) => d.slice(5) // MM-DD

const barTitle = (
  bar: { weekStart: string; partial: boolean; segments: Array<{ label: string; usd: number }> },
  basis: string,
) => {
  const head = `week of ${bar.weekStart}${bar.partial ? ' (in progress)' : ''} · ${basis}`
  if (!bar.segments.length) return `${head} — no spend`
  return `${head}\n${bar.segments.map((s) => `${s.label} — ${fmtUsd(s.usd)}`).join('\n')}`
}

// Sparse x labels: first / middle / last week of the shared axis.
const xLabels = computed(() => {
  const w = built.value.weeks
  if (!w.length) return []
  const idx = [...new Set([0, Math.floor(w.length / 2), w.length - 1])]
  return idx.map((i) => ({ i, label: fmtWeek(w[i]!.weekStart) }))
})

const hasAnyBars = computed(() =>
  built.value.groups.some((g) => g.bars.some((b) => b.totalUsd !== 0)),
)
</script>

<template>
  <UiCard data-testid="consumption-hero">
    <div class="flex items-baseline justify-between flex-wrap gap-2">
      <UiEyebrow>What kind of AI work drove this</UiEyebrow>
      <span class="text-[10px] text-carbon-3">
        per-lane $ · bases differ by group — never summed across groups · last {{ windowDays }}d
      </span>
    </div>

    <template v-if="hasAnyBars">
      <div
        v-for="g in built.groups"
        :key="g.id"
        class="mt-3"
        :data-testid="`hero-group-${g.id}`"
      >
        <!-- Group legend header: label + basis caption + per-lane MTD chips -->
        <div class="flex items-baseline justify-between flex-wrap gap-x-3">
          <span class="text-xs font-bold text-carbon">{{ g.label }}</span>
          <span class="text-[10px] text-carbon-3">{{ g.basis }}</span>
        </div>
        <div class="flex flex-wrap gap-x-4 gap-y-1 mt-1" :data-testid="`hero-chips-${g.id}`">
          <span
            v-for="c in g.chips"
            :key="c.lane"
            class="inline-flex items-center gap-1.5 text-[10px] text-carbon-2"
            :title="c.foldedTitle"
            :data-testid="`hero-chip-${g.id}-${c.lane}`"
          >
            <span
              class="inline-block w-2 h-2 rounded-sm shrink-0"
              :style="{ background: laneSwatch(c.lane) }"
              aria-hidden="true"
            />
            {{ c.label }}
            <span class="font-bold" style="font-variant-numeric: tabular-nums">{{ fmtUsd(c.mtdUsd) }}</span>
            <span class="text-carbon-3">MTD · {{ pct(c.share) }} of group</span>
          </span>
        </div>

        <!-- Half-height weekly stack (this group's OWN y-scale) -->
        <div class="flex items-end gap-1 h-[92px] mt-2" :data-testid="`hero-stack-${g.id}`">
          <div
            v-for="b in g.bars"
            :key="b.weekStart"
            class="flex-1 flex flex-col justify-end h-full"
            :title="barTitle(b, g.basis)"
          >
            <div
              class="w-full flex flex-col justify-end rounded-t-sm overflow-hidden"
              :class="b.partial ? 'border border-dashed border-carbon-3 opacity-70' : ''"
              :style="{ height: `${(b.totalUsd / g.maxUsd) * 84}px` }"
              :data-partial-week="b.partial ? 'true' : undefined"
            >
              <div
                v-for="s in b.segments"
                :key="s.lane"
                class="w-full"
                :style="{
                  height: `${b.totalUsd > 0 ? (s.usd / b.totalUsd) * 100 : 0}%`,
                  background: laneSwatch(s.lane),
                }"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- ONE shared x-axis under the second stack -->
      <div class="relative h-4 mt-1" aria-hidden="true">
        <span
          v-for="l in xLabels"
          :key="l.i"
          class="absolute text-[9px] text-carbon-3"
          :style="{
            left: `${((l.i + 0.5) / built.weeks.length) * 100}%`,
            transform: 'translateX(-50%)',
          }"
        >{{ l.label }}</span>
      </div>
      <p class="text-[10px] text-carbon-3 mt-1">
        Weekly bars over the last {{ windowDays }}d; dashed bar = week in progress (excluded from
        chips/shares). MTD chips are calendar month-to-date, each from its lane's own source.
      </p>
    </template>
    <p v-else class="text-xs text-carbon-3 italic py-6 text-center">
      No usage in this window yet — this fills in as spend lands.
    </p>
  </UiCard>
</template>
