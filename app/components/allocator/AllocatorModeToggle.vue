<script setup lang="ts">
/*
 * AllocatorModeToggle — two-card mode selector for the allocation
 * editor (Shared pool / Per-developer fixed).
 *
 * Per design-notes §Screen 4: bigger touch target than a radio, with
 * room for an inline explanation. Selected card gets a Harmony-tinted
 * border + "Selected" pill.
 *
 * Both modes are selectable: shared-pool draws all assigned devs from
 * one project budget; per-developer-fixed gives each assignee an
 * explicit cap (edited in the allocation editor's per-dev split card).
 */
import UiBadge from '../ui/Badge.vue'

export type AllocatorMode = 'shared-pool' | 'per-dev-fixed'

defineProps<{
  modelValue: AllocatorMode
}>()

const emit = defineEmits<{
  'update:modelValue': [AllocatorMode]
}>()

function pick(mode: AllocatorMode) {
  emit('update:modelValue', mode)
}
</script>

<template>
  <div class="grid grid-cols-2 gap-3" data-testid="allocator-mode-toggle">
    <button
      type="button"
      class="text-left p-5 rounded-xl border-2 transition-colors cursor-pointer"
      :class="
        modelValue === 'shared-pool'
          ? 'border-brand-harmony bg-brand-harmony-lite/30'
          : 'border-calm-2 bg-white hover:border-brand-harmony/40'
      "
      data-testid="mode-shared-pool"
      @click="pick('shared-pool')"
    >
      <div class="flex items-center justify-between mb-2">
        <div class="text-sm font-bold text-carbon">Shared pool</div>
        <UiBadge v-if="modelValue === 'shared-pool'" kind="harmony">Selected</UiBadge>
      </div>
      <p class="text-xs text-carbon-2 leading-relaxed">
        All assigned developers draw from one project budget. Best for
        normal engagements.
      </p>
    </button>
    <button
      type="button"
      class="text-left p-5 rounded-xl border-2 transition-colors cursor-pointer"
      :class="
        modelValue === 'per-dev-fixed'
          ? 'border-brand-harmony bg-brand-harmony-lite/30'
          : 'border-calm-2 bg-white hover:border-brand-harmony/40'
      "
      data-testid="mode-per-dev-fixed"
      @click="pick('per-dev-fixed')"
    >
      <div class="flex items-center justify-between mb-2">
        <div class="text-sm font-bold text-carbon">Per-developer fixed</div>
        <UiBadge v-if="modelValue === 'per-dev-fixed'" kind="harmony">Selected</UiBadge>
      </div>
      <p class="text-xs text-carbon-2 leading-relaxed">
        Each developer has their own cap. Used when budget control is
        explicit, e.g. fixed-bid.
      </p>
    </button>
  </div>
</template>
