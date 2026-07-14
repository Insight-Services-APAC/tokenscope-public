<script setup lang="ts">
/*
 * ProviderFreshnessBar — per-vendor provenance strip (AEUF meta-pattern).
 *
 * build-design §3: always renders on data — an attribution product must show
 * WHERE each number came from and how settled it is. One row per vendor:
 * settling chip (reused) + "as of" point-in-time + the invoice-reconciled
 * honesty flag (owner-decisions: the GitHub bill lane stays unreconciled until
 * a real invoice lands).
 */
import SettlingStateChip from './SettlingStateChip.vue'
import type { ProviderState } from '#shared/reports/types'

defineProps<{ providers: ProviderState[] }>()
</script>

<template>
  <div
    v-if="providers.length"
    class="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-carbon-3 py-2"
    data-testid="provider-freshness-bar"
    aria-label="Data provenance by provider"
  >
    <div
      v-for="p in providers"
      :key="p.vendor"
      class="inline-flex items-center gap-2 flex-wrap"
      :data-vendor="p.vendor"
    >
      <SettlingStateChip :state="p.state" :horizon-date="p.settlesAt" :vendor="p.vendor" />
      <span v-if="p.asOfDate" class="text-carbon-3">· as of {{ p.asOfDate }}</span>
      <span
        v-if="p.invoiceReconciled === false"
        class="text-carbon-3 italic"
        data-testid="invoice-unreconciled"
      >· invoice not yet reconciled</span>
    </div>
  </div>
</template>
