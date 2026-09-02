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

// Lazy, client-only, null default: docs/design/admin-nav-responsiveness.md D1/D2.
const {
  data: governance,
  error: governanceError,
  refresh: refreshGovernance,
} = useLazyFetch<GovernanceDialsData | null>('/api/v1/admin/governance-settings', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

// Region list for the org-wide scope picker (org-wide roles only). It keeps its
// `error`: collapsed into `[]` the picker offers "Platform default" alone, which
// reads as "there are no region overrides to make" — the false empty D2 forbids.
const {
  data: regionsData,
  error: regionsError,
  refresh: refreshRegions,
} = useLazyFetch<{
  regions: { id: string; code: string; display_name: string }[]
} | null>('/api/v1/admin/regions', {
  server: false,
  default: () => null,
  immediate: isAdmin.value && isOrgWide.value,
})

// The caller's home-region display code — used ONLY as the region-admin caption
// on the section. Org-wide admins use the scope picker instead, so skip the read
// for them. (Region code isn't on the session; the settings bundle is the
// existing source. TODO: expose regionCode via useAdminAccess to drop this read.)
const { data: settings } = useLazyFetch<{ region: { code: string } | null } | null>(
  '/api/v1/admin/settings',
  { server: false, default: () => null, immediate: isAdmin.value && !isOrgWide.value },
)
const regionCode = computed(() => settings.value?.region?.code ?? null)
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-policy-detection-thresholds" data-admin-page="/admin/policies/detection-thresholds">
    <UiPageHead
      eyebrow="Policies"
      title="Detection thresholds"
      sub="The live-detection dials — velocity-spike and reconciliation gap/epsilon/lag. A region override shadows the platform default."
    />
    <UiFetchErrorBanner v-if="governanceError" :error="governanceError" label="detection thresholds" @retry="refreshGovernance" />
    <AdminPageSkeleton v-else-if="governance == null" :rows="5" :toolbar="false" />
    <AdminGovernanceDialsSection
      v-else
      :data="governance"
      :regions="regionsData?.regions ?? []"
      :regions-error="regionsError"
      :org-wide="isOrgWide"
      :region-id="regionId || null"
      :region-code="regionCode"
      @saved="refreshGovernance()"
      @retry-regions="refreshRegions"
    />
  </div>
</template>
