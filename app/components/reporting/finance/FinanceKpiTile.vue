<script setup lang="ts">
/*
 * FinanceKpiTile — the quiet, hairline KPI tile for the Finance scope.
 *
 * Matches the Across-Regions flagship's KpiTile grammar EXACTLY: a hairline
 * border, NO coloured top-border, an uppercase eyebrow label, a big tabular-nums
 * value in carbon ink, and a one-line sub. A `#badge` slot carries a small status
 * chip inline with the label (e.g. a Copilot pending marker) so the tile never
 * grows a second row of chrome.
 *
 * Deliberately no RAG on the value — a §B chargeback/gap figure is a MAGNITUDE,
 * not a status (status colour is reserved for the reconciliation RAG). The value
 * always reads in neutral carbon.
 */
withDefaults(
  defineProps<{
    label: string
    value: string
    /** One-line supporting caption under the value. */
    sub?: string
  }>(),
  { sub: undefined },
)
</script>

<template>
  <div
    class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] px-5 py-4 flex flex-col gap-1.5 min-w-0"
    data-testid="finance-kpi-tile"
  >
    <div class="flex items-center justify-between gap-2 min-w-0">
      <span class="text-[10.5px] font-bold uppercase tracking-[1.1px] text-carbon-3 truncate">
        {{ label }}
      </span>
      <slot name="badge" />
    </div>

    <div class="text-[26px] leading-none font-bold tracking-[-0.5px] tabular-nums text-carbon">
      {{ value }}
    </div>

    <div v-if="sub || $slots.sub" class="text-[12px] leading-snug text-carbon-2">
      <slot name="sub">{{ sub }}</slot>
    </div>
  </div>
</template>
