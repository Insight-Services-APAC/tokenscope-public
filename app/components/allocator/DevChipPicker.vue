<script setup lang="ts">
/*
 * DevChipPicker — chip-list of the project's currently-assigned developers.
 * Each chip's × emits 'remove' (the page wires the DELETE). Adding a developer
 * is the separate "Add a developer" search on the page — this component is just
 * the current roster, so it carries no redundant search box or dead CSV stub.
 */
export interface AssignedDev {
  teammate_id: string
  email: string
  display_name: string | null
  role: string | null
}

defineProps<{
  devs: AssignedDev[]
}>()

const emit = defineEmits<{
  remove: [teammateId: string]
}>()
</script>

<template>
  <div data-testid="dev-chip-picker">
    <div class="flex flex-wrap gap-2">
      <span
        v-for="d in devs"
        :key="d.teammate_id"
        class="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-brand-harmony-sheer text-carbon text-xs border border-calm-2"
      >
        <span class="font-bold">{{ d.display_name ?? d.email.split('@')[0] }}</span>
        <span class="text-carbon-3">{{ d.role ?? '—' }}</span>
        <button
          type="button"
          class="text-carbon-3 hover:text-brand-hunger cursor-pointer transition-colors"
          :aria-label="`Remove ${d.display_name ?? d.email}`"
          :data-testid="`remove-${d.teammate_id}`"
          title="Remove this developer from the project."
          @click="emit('remove', d.teammate_id)"
        >
          ×
        </button>
      </span>
      <span v-if="devs.length === 0" class="text-xs text-carbon-3 italic py-1">
        No developers assigned yet — add one below.
      </span>
    </div>
  </div>
</template>
