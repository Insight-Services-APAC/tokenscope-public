<script setup lang="ts">
/*
 * Admin → Policies → Report visibility. The org-wide knob over which /reports
 * scopes each role sees (mig 0087). Read by any admin; editable only org-wide —
 * the section disables its controls and the server re-narrows the write gate.
 * Split out of the old /admin/settings junk drawer.
 */
import { useAdminAccess } from '../../../composables/useAdminAccess'
import type { ReportVisibilityData } from '../../../components/admin/ReportVisibilitySection.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { isAdmin, isOrgWide } = useAdminAccess()

const { data, refresh } = await useFetch<ReportVisibilityData>('/api/v1/admin/report-visibility', {
  default: () => null as unknown as ReportVisibilityData,
  immediate: isAdmin.value,
})
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-policy-report-visibility">
    <UiPageHead
      eyebrow="Policies"
      title="Report visibility"
      sub="One org-wide knob over which reporting scopes each role can see. Change it, everything else follows."
    />
    <AdminReportVisibilitySection :data="data" :org-wide="isOrgWide" @saved="refresh()" />
  </div>
</template>
