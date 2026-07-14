<script setup lang="ts">
/*
 * UiRegionSelector — shared region dropdown for the reporting surfaces.
 *
 * Both the Team rollup (/rollups) and Practices rollup (/org-rollup) hand-rolled
 * the same "Region" <select> bound to a `region` ref that drives the data query.
 * Extracted here so the two pages share one control.
 *
 * Contract:
 *   - `options`: the region list as { id, code, displayName }. The rollups page
 *     maps its snake_case `display_name` at the call-site.
 *   - `modelValue` (v-model): the selected region id; '' means "all regions"
 *     when `allowAll` is on, otherwise it's the resolved/locked region id.
 *   - `allowAll`: org-rollup locks to a real region (no "all" choice); rollups
 *     offers an "All regions" option. The two pages differ only by this flag.
 *
 * Visibility: each page kept its own rule, so the caller decides whether to
 * render the selector at all (org-rollup: >1 option; rollups: >0 options). This
 * component just renders the control when mounted.
 */

export interface RegionOption {
  id: string
  code: string
  displayName: string
}

withDefaults(
  defineProps<{
    modelValue: string
    options: RegionOption[]
    /** When true, prepend an "All regions" ('' value) option. */
    allowAll?: boolean
  }>(),
  {
    allowAll: false,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()
</script>

<template>
  <label class="flex items-center gap-2 text-[12px] text-carbon-2 select-none">
    <span>Region</span>
    <select
      :value="modelValue"
      class="text-[12px] border border-calm-2 rounded-md px-2 py-1 bg-white text-carbon-1"
      data-testid="region-select"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-if="allowAll" value="">All regions</option>
      <option v-for="r in options" :key="r.id" :value="r.id">{{ r.displayName }}</option>
    </select>
  </label>
</template>
