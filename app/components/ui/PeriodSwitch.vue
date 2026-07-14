<script setup lang="ts">
/*
 * UiPeriodSwitch — segmented control for time-range selection.
 *
 * Default options match design-notes §Cross-screen patterns:
 *   MTD / 7d / 30d / prior month.
 *
 * Controlled via v-model:value. Pass a custom `options` array to
 * override (Finance uses Apr/May/Q1/Custom; Manager uses the default).
 */

export interface PeriodOption {
  key: string
  label: string
  /**
   * When set, the option renders disabled with this text as the tooltip.
   * Per the MVP-Lite UX-polish lesson — every deferred-capability button
   * gets `disabled + title=` referencing the epic that ships it, rather
   * than silently no-op-ing on click.
   */
  disabledReason?: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    options?: PeriodOption[]
  }>(),
  {
    // Defaults match design-notes §Cross-screen patterns: MTD / 7d / 30d / prior.
    options: () => [
      { key: 'mtd', label: 'MTD' },
      { key: '7d', label: 'Last 7 days' },
      { key: '30d', label: 'Last 30 days' },
      { key: 'prior', label: 'Prior month' },
    ],
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

function select(opt: PeriodOption) {
  if (opt.disabledReason) return
  if (opt.key !== props.modelValue) emit('update:modelValue', opt.key)
}
</script>

<template>
  <div
    class="inline-flex p-0.5 bg-calm-2 rounded-lg gap-0.5"
    role="tablist"
  >
    <button
      v-for="opt in options"
      :key="opt.key"
      type="button"
      role="tab"
      :aria-selected="modelValue === opt.key"
      :disabled="!!opt.disabledReason"
      :title="opt.disabledReason"
      :aria-disabled="!!opt.disabledReason"
      class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
      :class="[
        modelValue === opt.key
          ? 'bg-white text-brand-harmony shadow-sm'
          : 'text-carbon-2 hover:text-brand-harmony',
      ]"
      @click="select(opt)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>
