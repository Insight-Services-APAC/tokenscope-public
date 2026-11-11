<script setup lang="ts">
/*
 * RegionalPracticeRank — attributed usage by practice for the region (ChartRankedBar).
 *
 * Rankings are MAGNITUDE, so the ranked bars wear a SINGLE hue with the $ labelled
 * at the bar end (the chart kit replaces the old grey-track progress bars). Each
 * row carries its cost-owning-unit id as `meta`; a click emits `select` with that
 * id so the container can drill into the practice (`?ou=`). The explicit
 * "Unattributed" bucket (no cost-owning ancestor) is shown for sum-back honesty
 * but carries no drill target.
 *
 * The region's `default` BU (`isDefault`, server-flagged) is NOT a real practice —
 * it is where teammates who have not yet been placed under a named practice land.
 * It is pulled OUT of the peer ranking and rendered below as a quiet TO-DO row
 * (muted text + a reduced-opacity fill + a "place these teammates" hint), so the
 * often-largest "APAC (default)" bar never reads as a peer category.
 *
 * Only an admin can place anyone (#585), so the hint is a link for an admin who
 * can open the region's placement list (the container passes `placementHref`)
 * and plain words for everyone else: "not yet placed in a Business Unit".
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartRankedBar from '../charts/ChartRankedBar.client.vue'
import LaneSwitchLink from '../LaneSwitchLink.vue'
import { fmtUsd } from '../../../composables/useFormat'
import type { SpendClass } from '#shared/reports/types'

const props = defineProps<{
  practices: {
    key: string
    label: string
    value: number
    spendClass: SpendClass
    /** True when this bucket is the region's `default` BU (unplaced teammates). */
    isDefault: boolean
  }[]
  /** Admin-only: the region's Teammates tab filtered to unplaced. Null/absent = plain words. */
  placementHref?: string | null
}>()

const emit = defineEmits<{ select: [ouId: string] }>()

// The default BU is pulled out of the peer ranking; everything else keeps the
// magnitude ranked-bar treatment.
const defaultPractice = computed(() => props.practices.find((p) => p.isDefault) ?? null)

const rankedRows = computed(() =>
  props.practices
    .filter((p) => !p.isDefault)
    .map((p) => ({ label: p.label, value: p.value, meta: p.key })),
)

const defaultRow = computed(() =>
  defaultPractice.value
    ? { label: defaultPractice.value.label, value: defaultPractice.value.value }
    : null,
)

// Width relative to the largest value across the whole card (incl. the default
// bucket) so the muted to-do bar still reads at true magnitude.
const maxValue = computed(() => Math.max(0, ...props.practices.map((p) => p.value)))
const defaultPct = computed(() =>
  defaultRow.value && maxValue.value > 0
    ? Math.min((defaultRow.value.value / maxValue.value) * 100, 100)
    : 0,
)

function onSelect(row: { label: string; value: number; meta?: unknown }) {
  const key = row.meta
  if (typeof key === 'string' && key !== 'unattributed') emit('select', key)
}
</script>

<template>
  <UiCard data-testid="regional-practice-rank">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Usage by practice</div>
      <div class="text-[11px] text-carbon-3">Ranked by usage · sums to attributed usage</div>
    </div>
    <div class="text-[11px] text-carbon-3 mb-3">Select a practice to drill into its teammates and models.</div>

    <ChartRankedBar
      v-if="rankedRows.length"
      :rows="rankedRows"
      :value-format="(v) => fmtUsd(v)"
      clickable
      @select="onSelect"
    />

    <!-- Default (unplaced) bucket — a to-do, not a peer practice: muted text, a
         reduced-opacity fill (never a solid magnitude bar), and a placement
         hint (a link for an admin, words for everyone else). No drill target. -->
    <div
      v-if="defaultRow"
      class="mt-3 pt-3 border-t border-calm-1"
      data-testid="regional-practice-default"
    >
      <div class="flex items-baseline justify-between gap-3">
        <div class="text-[13px] text-carbon-3 truncate min-w-0">{{ defaultRow.label }}</div>
        <div class="text-[12px] tabular-nums text-carbon-3 shrink-0">{{ fmtUsd(defaultRow.value) }}</div>
      </div>
      <div class="mt-1.5 h-2 rounded-full bg-calm-1 overflow-hidden" role="presentation">
        <div class="h-full rounded-full bg-carbon-3/30" :style="{ width: `${defaultPct}%` }" />
      </div>
      <NuxtLink
        v-if="placementHref"
        :to="placementHref"
        class="mt-1 inline-block text-[11px] font-semibold text-brand-harmony hover:underline"
        data-testid="regional-practice-place-link"
      >Not yet placed in a Business Unit: place these teammates →</NuxtLink>
      <div
        v-else
        class="mt-1 text-[11px] text-carbon-3 italic"
        data-testid="regional-practice-unplaced-note"
      >not yet placed in a Business Unit</div>
    </div>

    <!-- I5 cross-link: this usage ranking's §B sibling is chargeback-by-cost-centre. -->
    <LaneSwitchLink label="See chargeback by Business Unit" />
  </UiCard>
</template>
