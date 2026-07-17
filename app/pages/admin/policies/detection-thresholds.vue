<script setup lang="ts">
/*
 * Admin → Policies → Detection thresholds. The governance dials (velocity-spike
 * + reconciliation thresholds). The section GETs feed it; it PUTs and emits
 * `saved`, we re-fetch. Region list only matters for the org-wide scope picker;
 * region code is the region-admin caption. Split out of /admin/settings.
 */
import { useAdminAccess } from '../../../composables/useAdminAccess'
import type { GovernanceDialsData } from '../../../components/admin/GovernanceDialsSection.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { isAdmin, isOrgWide, regionId } = useAdminAccess()

const { data: governance, refresh: refreshGovernance } = await useFetch<GovernanceDialsData>(
  '/api/v1/admin/governance-settings',
  { default: () => null as unknown as GovernanceDialsData, immediate: isAdmin.value },
)

// Region list for the org-wide scope picker (org-wide roles only).
const { data: regionsData } = await useFetch<{
  regions: { id: string; code: string; display_name: string }[]
}>('/api/v1/admin/regions', {
  default: () => ({ regions: [] }),
  immediate: isAdmin.value && isOrgWide.value,
})

// The caller's home-region display code — used ONLY as the region-admin caption
// on the section. Org-wide admins use the scope picker instead, so skip the read
// for them. (Region code isn't on the session; the settings bundle is the
// existing source. TODO: expose regionCode via useAdminAccess to drop this read.)
const { data: settings } = await useFetch<{ region: { code: string } | null }>(
  '/api/v1/admin/settings',
  {
    default: () => null as unknown as { region: { code: string } | null },
    immediate: isAdmin.value && !isOrgWide.value,
  },
)
const regionCode = computed(() => settings.value?.region?.code ?? null)
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-policy-detection-thresholds">
    <UiPageHead
      eyebrow="Policies"
      title="Detection thresholds"
      sub="The live-detection dials — velocity-spike and reconciliation gap/epsilon/lag. A region override shadows the platform default."
    />
    <AdminGovernanceDialsSection
      :data="governance"
      :regions="regionsData?.regions ?? []"
      :org-wide="isOrgWide"
      :region-id="regionId || null"
      :region-code="regionCode"
      @saved="refreshGovernance()"
    />
  </div>
</template>
