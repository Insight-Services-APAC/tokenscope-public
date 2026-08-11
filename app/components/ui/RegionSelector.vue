<script setup lang="ts">
/*
 * UiRegionSelector — the region width control for the reporting surfaces.
 *
 * IT IS A PILL ROW, NOT A DROPDOWN. The prototype renders the widths as chips
 * ("All regions · APAC · EMEA · North America · Unassigned") with the active one
 * filled, and this is the same fix already applied to the drivers axis
 * (`note('fix 4')`): every width a reader may pick is on screen, so choosing one
 * is a click rather than open-read-choose-close. The region selector was simply
 * missed in that pass.
 *
 * ONE IDIOM PER PAGE. The markup, the ARIA and the classes deliberately mirror
 * DriversTable's axis chips — `role="group"` + `aria-pressed` on each button (a
 * toggle group, not navigation) — so the two chip rows on the same page are the
 * same control to both a reader and a screen reader.
 *
 * Contract:
 *   - `options`: the widths this caller may pick, already ordered and already
 *     including the "All regions" sentinel when granted (region-options.ts).
 *     This component neither derives nor sorts the list.
 *   - `modelValue` (v-model): the selected option's `id`.
 *
 * Visibility is the CALLER's decision (`regionSelectorVisible`): a caller with no
 * genuine choice renders no control at all. This component renders the row it is
 * given.
 *
 * The pills WRAP rather than scroll: the list grows with the estate, and a
 * horizontally-clipped width is a width the reader cannot discover.
 */

export interface RegionOption {
  id: string
  code: string
  displayName: string
}

defineProps<{
  modelValue: string
  options: RegionOption[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()
</script>

<template>
  <div
    class="flex flex-wrap gap-1.5"
    role="group"
    aria-label="Region"
    data-testid="region-select"
  >
    <button
      v-for="r in options"
      :key="r.id"
      type="button"
      class="text-[12px] rounded-full px-3 py-1 border transition-colors"
      :class="
        r.id === modelValue
          ? 'border-brand-harmony bg-brand-harmony text-white font-semibold'
          : 'border-calm-2 bg-white text-carbon-2 hover:border-brand-harmony hover:text-carbon-1'
      "
      :aria-pressed="r.id === modelValue"
      :data-testid="`region-pill-${r.code}`"
      @click="emit('update:modelValue', r.id)"
    >{{ r.displayName }}</button>
  </div>
</template>
