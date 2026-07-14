<script setup lang="ts">
/*
 * AdminTabs — 6-tab switcher for the admin region page.
 *
 * Tab keys are encoded in the URL as `?tab=...` so deep-linking
 * works and reload restores the active tab.
 */

export interface AdminTab {
  key: string
  label: string
  count?: number
}

defineProps<{
  tabs: AdminTab[]
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [string]
}>()

function pick(key: string) {
  emit('update:modelValue', key)
}
</script>

<template>
  <div
    class="flex gap-1 border-b border-calm-2 mb-6 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    data-testid="admin-tabs"
  >
    <button
      v-for="t in tabs"
      :key="t.key"
      type="button"
      class="px-[18px] py-3 text-sm font-semibold text-carbon-2 cursor-pointer border-b-2 border-transparent -mb-px tracking-tight whitespace-nowrap hover:text-brand-harmony"
      :class="[modelValue === t.key && 'text-brand-harmony border-b-brand-harmony font-bold']"
      :data-testid="`admin-tab-${t.key}`"
      :aria-current="modelValue === t.key ? 'true' : 'false'"
      @click="pick(t.key)"
    >
      {{ t.label }}
      <span v-if="t.count != null" class="ml-2 text-carbon-3 font-medium">{{ t.count }}</span>
    </button>
  </div>
</template>
