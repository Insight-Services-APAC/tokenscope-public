<script setup lang="ts">
/*
 * ChartsUtilBar — quota/allocation utilisation bar (AEUF's pool bar).
 * Factual colour signal: green <80%, amber 80–100%, red >100%. A null
 * total renders an unbounded (no-allocation) neutral bar.
 */
import { computed } from 'vue'

const props = defineProps<{
  used: number
  total: number | null
  label?: string
}>()

const frac = computed(() =>
  props.total && props.total > 0 ? props.used / props.total : null,
)
const width = computed(() => (frac.value === null ? 100 : Math.min(100, frac.value * 100)))
const color = computed(() => {
  if (frac.value === null) return 'bg-calm-2'
  if (frac.value > 1) return 'bg-rag-red'
  if (frac.value >= 0.8) return 'bg-rag-amber'
  return 'bg-rag-green'
})
</script>

<template>
  <div data-testid="util-bar">
    <div class="flex items-baseline justify-between text-[11px] text-carbon-3 mb-1">
      <span>{{ label }}</span>
      <span v-if="frac !== null" style="font-variant-numeric: tabular-nums">
        {{ Math.round(frac * 100) }}%
      </span>
      <span v-else>no allocation set</span>
    </div>
    <div class="h-2 rounded-full bg-calm-2/60 overflow-hidden">
      <div class="h-full rounded-full transition-all" :class="color" :style="{ width: width + '%' }" />
    </div>
  </div>
</template>
