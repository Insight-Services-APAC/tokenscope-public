<script setup lang="ts">
/*
 * UsageWindowToggle — the 30/90-day trailing-window selector shared by the
 * consumption and project dashboards (one definition; the windows mirror
 * shared/schemas/usage.ts::WindowQuery).
 */
const model = defineModel<30 | 90>({ required: true })
const WINDOWS = [30, 90] as const
</script>

<template>
  <div class="flex items-center gap-2">
    <slot />
    <button
      v-for="w in WINDOWS"
      :key="w"
      class="text-[11px] px-2 py-0.5 rounded border"
      :class="model === w ? 'border-brand-harmony text-brand-harmony font-bold' : 'border-calm-2 text-carbon-3'"
      :aria-pressed="model === w"
      :data-testid="`window-${w}`"
      @click="model = w"
    >{{ w }}d</button>
  </div>
</template>
