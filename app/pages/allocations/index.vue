<script setup lang="ts">
/*
 * Project allocation editor / list (Journey 4 / design-notes §Screen 4).
 *
 * Lists allocations; per-row "Edit" navigates to a deeper editor
 * (deferred — single-row form is Epic 9 polish). For Epic 8 the list
 * surface + create-CTA placeholder satisfy the verifiable end state.
 */
interface AllocRow {
  id: string
  scope_type: string
  scope_id: string
  budget_usd: string
  effective: string
  allocation_kind: string
  project_code: string | null
  project_display_name: string | null
}

const { data } = useFetch<{ allocations: AllocRow[] }>('/api/v1/allocations', {
  default: () => ({ allocations: [] }),
})

// Org-wide roles see every region's projects here (the /admin/region tabs are
// region-scoped) — label the scope so the two views don't look contradictory.
const { session } = useSession()
// Org-wide (unbounded) roles per the live allocation-scope predicate
// (server/auth/allocation-scope.ts: app.user_role IN ('admin','global-finops'),
// + platform-admin super-admin). Only managers are clamped to their org subtree,
// so only they see a region-scoped slice. Mislabelling admin as region-scoped
// re-creates the contradiction this note exists to dispel.
const scopeNote = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'global-finops' || r === 'platform-admin'
    ? 'Showing projects across all regions (org-wide).'
    : "Showing the projects in your part of the org."
})

// Money cells use the shared guarded formatter from ~/composables/useFormat
// (auto-imported, SYS-5) — the local no-separator clone is gone.
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20">
    <UiPageHead
      eyebrow="Allocations"
      title="Project budgets"
      :sub="`Baseline budgets + top-ups + bursts. ${scopeNote}`"
    >
      <template #actions>
        <NuxtLink to="/projects/new" data-testid="new-project-link">
          <UiButton kind="primary" size="sm">
            + New project
          </UiButton>
        </NuxtLink>
      </template>
    </UiPageHead>

    <UiCard flush data-testid="allocation-list">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-brand-harmony-sheer border-b border-calm-2">
            <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">Project</th>
            <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">Kind</th>
            <th class="text-right text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">Budget</th>
            <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">Effective</th>
            <th class="px-5 py-3"/>
          </tr>
        </thead>
        <tbody>
          <tr v-if="(data?.allocations.length ?? 0) === 0">
            <td colspan="5" class="p-10 text-center text-carbon-3 text-sm">
              No allocations yet — create one to begin governing.
            </td>
          </tr>
          <tr
            v-for="r in data?.allocations ?? []"
            :key="r.id"
            class="border-b border-calm-2 last:border-b-0 hover:bg-brand-harmony-sheer/40"
          >
            <td class="px-5 py-4">
              <div class="font-bold text-carbon">
                {{ r.project_display_name ?? r.scope_id }}
              </div>
              <div class="text-[11px] text-carbon-3 font-mono mt-0.5">
                {{ r.project_code ?? r.scope_type }}
              </div>
            </td>
            <td class="px-5 py-4">
              <UiBadge :kind="r.allocation_kind === 'top-up' ? 'hunger' : 'harmony'">
                {{ r.allocation_kind }}
              </UiBadge>
            </td>
            <td class="text-right px-5 py-4" style="font-variant-numeric: tabular-nums">
              {{ fmtUsd(r.budget_usd) }}
            </td>
            <td class="px-5 py-4 text-xs text-carbon-3 font-mono">
              {{ r.effective }}
            </td>
            <td class="px-5 py-4">
              <NuxtLink
                :to="`/allocations/${r.id}`"
                class="inline-flex items-center gap-2 rounded-lg font-bold tracking-tight whitespace-nowrap px-3 py-1.5 text-xs bg-transparent text-carbon-2 hover:bg-brand-harmony-sheer hover:text-brand-harmony transition-colors cursor-pointer"
                data-testid="allocations-edit-link"
              >
                Edit →
              </NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
    </UiCard>
  </div>
</template>
