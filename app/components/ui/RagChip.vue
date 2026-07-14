<script setup lang="ts">
/*
 * UiRagChip — RAG-coloured chip derived from a 0..1 percentage.
 *
 * Threshold rules live in `useRagState.ts::ragOf()` so UiPbar, UiKpi,
 * and any external consumer share one source of truth.
 */

import UiBadge from './Badge.vue'
import { ragOf, ragLabel } from '../../composables/useRagState'

const props = defineProps<{
  pct: number
  label?: string
}>()

const sev = ragOf(props.pct)
const kind = `rag-${sev}` as const
// "Over" only when actually over budget (pct > 1); 90–100% is "Critical".
const display = props.label ?? ragLabel(props.pct)
</script>

<template>
  <UiBadge :kind="kind" :dot="sev">
    {{ display }}
  </UiBadge>
</template>
