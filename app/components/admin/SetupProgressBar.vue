<script setup lang="ts">
/*
 * SetupProgressBar — macro "X% complete" bar above the Setup
 * checklist (design-notes §Screen 5).
 */

const props = defineProps<{
  done: number
  inProgress: number
  todo: number
}>()

const total = props.done + props.inProgress + props.todo
const pctDone = total > 0 ? (props.done / total) * 100 : 0
const pctInProgress = total > 0 ? (props.inProgress / total) * 100 : 0
</script>

<template>
  <div data-testid="setup-progress-bar">
    <div class="flex items-end justify-between gap-3 mb-3">
      <div class="text-2xl font-bold text-carbon tracking-tight">
        {{ done }} done · {{ inProgress }} in progress · {{ todo }} to start
      </div>
      <div class="text-xs text-carbon-3">
        Region setup progress · {{ Math.round(pctDone) }}% complete
      </div>
    </div>
    <div class="relative h-2 bg-calm-2 rounded-full overflow-hidden">
      <div
        class="absolute inset-y-0 left-0 bg-rag-green transition-[width] duration-300"
        :style="{ width: `${pctDone}%` }"
        aria-hidden="true"
      />
      <div
        class="absolute inset-y-0 bg-brand-hunger transition-[width,left] duration-300"
        :style="{ left: `${pctDone}%`, width: `${pctInProgress}%` }"
        aria-hidden="true"
      />
    </div>
  </div>
</template>
