<script setup lang="ts">
/*
 * ScopeRegion — the Region reporting scope, at whichever WIDTH the region selector
 * is on (04-prototype-delta.md §6).
 *
 * Region absorbed Across. This component owns the one decision that merge created —
 * "all regions, or one?" — and renders the matching view. It holds no data of its
 * own: each width's container keeps its own fetches, its own on-screen guards and
 * its own export, exactly as it did when it was a tab.
 *
 * WHERE THE WIDTH COMES FROM, in priority order:
 *   1. An explicit `?region=` — `all` is the whole-company width, a uuid is one region.
 *   2. Otherwise the caller's LANDING width from `/reports/meta` (`region.landing`),
 *      which is `regionScopeGrant(...).landing` on the server: `across` holders land
 *      on All regions, everyone else on their own region.
 *
 * The bare URL is left BARE — landing on All regions does not write `region=all` into
 * it. `?scope=region` means "my default width", and it stays true for whoever opens
 * it; materialising one caller's default into a shared link would hand the next
 * reader a width they may not hold, to be bounced off by clampScope. The URL only
 * gains a `region` when the reader actually picks one.
 *
 * `/reports/meta` is fetched under the SHELL'S key, so this is the shell's already-
 * resolved payload rather than a second request.
 */
import { computed } from 'vue'
import ScopeAcrossRegions from './ScopeAcrossRegions.vue'
import ScopeRegional from './ScopeRegional.vue'
import { useReportState } from '../../composables/useReportState'
import { ALL_REGIONS } from '#shared/reports/types'

interface RegionMeta {
  region?: { landing: 'all-regions' | 'own-region' | null; allRegions: boolean }
}

const rs = useReportState()

const { data: meta } = await useFetch<RegionMeta>('/api/v1/reports/meta', { key: 'reports-meta', retry: false })

const isAllRegions = computed<boolean>(() => {
  const region = rs.region.value
  if (region === ALL_REGIONS) return true
  if (region) return false
  // No region named ⇒ the caller's landing width. `meta` absent (a failed or
  // in-flight bootstrap) falls to the CLAMPED width: it is the one every caller
  // with the tab at all is granted, so an unknown grant can never render the
  // whole-company view.
  return meta.value?.region?.landing === 'all-regions'
})
</script>

<template>
  <ScopeAcrossRegions v-if="isAllRegions" />
  <ScopeRegional v-else />
</template>
