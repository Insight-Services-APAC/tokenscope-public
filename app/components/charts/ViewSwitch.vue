<script setup lang="ts">
/*
 * ChartsViewSwitch — the "Chart / Table" pair on a day-grain chart (#584).
 * Two real buttons with aria-pressed, so a keyboard or screen-reader user can
 * reach the numbers the chart only drew.
 */
const view = defineModel<'chart' | 'table'>({ required: true })
defineProps<{ label: string }>()
</script>

<template>
  <div class="flex justify-end mb-1 print:hidden" role="group" :aria-label="label" data-testid="chart-view-switch">
    <button
      v-for="v in (['chart', 'table'] as const)"
      :key="v"
      type="button"
      class="text-[11px] px-2 py-0.5 border first:rounded-l last:rounded-r -ml-px first:ml-0"
      :class="view === v ? 'border-brand-harmony text-brand-harmony font-bold bg-brand-harmony-sheer' : 'border-calm-2 text-carbon-3'"
      :aria-pressed="view === v"
      :data-testid="`chart-view-${v}`"
      @click="view = v"
    >{{ v === 'chart' ? 'Chart' : 'Table' }}</button>
  </div>
</template>
