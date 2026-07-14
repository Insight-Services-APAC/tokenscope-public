<script setup lang="ts">
/*
 * ConnectorCard — single FIN-system connector card for the admin
 * Connectors tab (design-notes §Screen 5).
 *
 * Status pill colour:
 *   planned       → harmony (Hunger-lite chip per hi-fi)
 *   unconfigured  → neutral (grey "Unconfigured" chip)
 *   available     → rag-green (Available — CSV upload card)
 *   none / err    → neutral
 */
import UiCard from '../ui/Card.vue'
import UiBadge from '../ui/Badge.vue'

export type ConnectorStatus = 'planned' | 'unconfigured' | 'available' | 'none'

const props = defineProps<{
  name: string
  scope: string
  description: string
  status: ConnectorStatus
  cta: 'configure' | 'upload-csv'
}>()

const statusLabel: Record<ConnectorStatus, string> = {
  planned: 'Planned',
  unconfigured: 'Unconfigured',
  available: 'Available',
  none: '—',
}

const statusKind = ((): 'harmony' | 'neutral' | 'rag-green' => {
  if (props.status === 'planned') return 'harmony'
  if (props.status === 'available') return 'rag-green'
  return 'neutral'
})()
</script>

<template>
  <UiCard data-testid="connector-card" :data-status="status">
    <div class="flex items-start justify-between gap-3 mb-2">
      <div>
        <div class="text-sm font-bold text-carbon">{{ name }}</div>
        <div class="text-[11px] text-carbon-3 mt-0.5">{{ scope }}</div>
      </div>
      <UiBadge :kind="statusKind">{{ statusLabel[status] }}</UiBadge>
    </div>
    <p class="text-xs text-carbon-2 leading-relaxed mb-3">{{ description }}</p>
    <button
      v-if="cta === 'configure'"
      type="button"
      class="px-3 py-1.5 text-xs font-bold text-carbon-3 border border-calm-2 rounded-md opacity-50 cursor-not-allowed"
      title="Connector configuration lands in a later MVP-Final slice."
      disabled
    >
      Configure
    </button>
    <button
      v-else
      type="button"
      class="px-3 py-1.5 text-xs font-bold text-white bg-brand-harmony rounded-md opacity-50 cursor-not-allowed"
      title="CSV upload lands in a later MVP-Final slice."
      disabled
    >
      Upload CSV
    </button>
  </UiCard>
</template>
