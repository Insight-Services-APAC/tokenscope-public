<script setup lang="ts">
/*
 * Admin → Policies → Report access. Per-teammate report-access grants (mig
 * 0129, task #19) — replaces the retired org-wide report-visibility dial.
 *
 * ORG-WIDE ONLY, end to end (post external design review, amendment B1): the
 * server-side endpoints are requireRole(event, 'global-finops') with no
 * region-admin read access at all (a per-teammate grant list is a narrower,
 * more sensitive surface than the retired org-wide dial was). The sidebar
 * item is 'org-wide' too, so a region admin sees this page locked with a hint
 * rather than a page whose every action 403s — same pattern as
 * /admin/department-map.
 */
import { useAdminAccess } from '../../../composables/useAdminAccess'
import type { ReportAccessData } from '../../../components/admin/ReportAccessSection.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { isOrgWide } = useAdminAccess()

const { data, refresh } = await useFetch<ReportAccessData>('/api/v1/admin/report-access', {
  default: () => null as unknown as ReportAccessData,
  immediate: isOrgWide.value,
})
</script>

<template>
  <div v-if="isOrgWide" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-policy-report-access">
    <UiPageHead
      eyebrow="Policies"
      title="Report access"
      sub="Grant a named teammate company-wide reporting access, on top of what their role already sees."
    />
    <AdminReportAccessSection :data="data" @changed="refresh()" />
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center">
    <div class="text-lg font-bold text-carbon">Global finance access required.</div>
  </div>
</template>
