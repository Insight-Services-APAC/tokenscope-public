<script setup lang="ts">
/*
 * Admin → Policies → Directory exclusions. UPN patterns that hide privileged /
 * service accounts from people-pickers so they can't be assigned as owners or
 * members. Editable only org-wide (the section + server enforce). Split out of
 * /admin/settings.
 */
import { useAdminAccess } from '../../../composables/useAdminAccess'
import type { DirectoryExclusionRow } from '../../../components/admin/DirectoryExclusionsSection.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { isAdmin, isOrgWide } = useAdminAccess()

const { data: exclusions, refresh: refreshExclusions } = await useFetch<{
  patterns: DirectoryExclusionRow[]
}>('/api/v1/admin/directory-exclusions', {
  default: () => ({ patterns: [] }),
  immediate: isAdmin.value,
})
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-policy-directory-exclusions">
    <UiPageHead
      eyebrow="Policies"
      title="Directory exclusions"
      sub="Hide privileged / service accounts from people-pickers so they can't be assigned as owners or members."
    />
    <AdminDirectoryExclusionsSection
      :rows="exclusions?.patterns ?? []"
      :org-wide="isOrgWide"
      @changed="refreshExclusions()"
    />
  </div>
</template>
