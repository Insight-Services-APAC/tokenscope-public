<script setup lang="ts">
/*
 * My projects (brief §5.6) — one card per project the caller is currently
 * a member of: burn vs allocation, run-rate exhaustion, velocity flag, end
 * state. Project transparency: every current member sees the same card a
 * PM sees.
 */
import type { ProjectCard } from '../../../shared/schemas/usage'

const { session, ensure } = useSession()
await ensure()

const { data, pending, error } = await useFetch<{ projects: ProjectCard[]; total: number }>(
  '/api/v1/me/projects/summary',
  { lazy: true },
)

function endState(p: ProjectCard): string | null {
  if (p.ended) return 'ended'
  if (p.end_date) return `ends ${p.end_date.slice(0, 10)}`
  return null
}
function exhaustionNote(p: ProjectCard): string | null {
  // No allocation → no projection line at all.
  if (Number(p.allocation_usd) <= 0) return null
  // exhaustionDate (server) is month-capped: a date means it lands THIS
  // month; null means this month's pace won't exhaust the budget.
  return p.projected_exhaustion_date
    ? `on pace to reach allocation ~${p.projected_exhaustion_date}`
    : 'allocation comfortable at the current pace'
}
</script>

<template>
  <div v-if="session" class="max-w-[1400px] mx-auto px-10 py-8 pb-20" data-testid="my-projects">
    <UiPageHead
      eyebrow="My projects"
      title="My projects"
      sub="Burn, budget and team health for every project you're on — the same view your whole team sees."
      :crumbs="['My projects']"
    />

    <div v-if="data?.projects?.length" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
      <NuxtLink
        v-for="p in data.projects"
        :key="p.id"
        :to="`/projects/${encodeURIComponent(p.code)}`"
        class="block group"
        :data-testid="`project-card-${p.code}`"
      >
        <UiCard class="h-full transition-shadow group-hover:shadow-lg">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-base font-bold text-carbon truncate group-hover:text-brand-harmony transition-colors">
                {{ p.display_name }}
              </div>
              <div class="text-[11px] text-carbon-3 mt-0.5">
                {{ p.code }} · {{ p.type }}<template v-if="p.wbs_code"> · WBS {{ p.wbs_code }}</template> ·
                {{ p.member_count }} member{{ p.member_count === 1 ? '' : 's' }}
              </div>
            </div>
            <div class="flex flex-col items-end gap-1 shrink-0">
              <UiBadge v-if="p.velocity.is_flagged" kind="rag-amber" data-testid="velocity-flag">
                velocity ↑
              </UiBadge>
              <UiBadge v-if="endState(p)" :kind="p.ended ? 'neutral' : 'outline'">
                {{ endState(p) }}
              </UiBadge>
            </div>
          </div>

          <div class="mt-4">
            <ChartsUtilBar
              :used="Number(p.mtd_cost_usd)"
              :total="Number(p.allocation_usd) > 0 ? Number(p.allocation_usd) : null"
              :label="`${fmtUsd(p.mtd_cost_usd)} of ${Number(p.allocation_usd) > 0 ? fmtUsd(p.allocation_usd) : 'no allocation'} MTD`"
            />
            <p v-if="exhaustionNote(p)" class="text-[11px] text-carbon-3 mt-2">
              {{ exhaustionNote(p) }}
            </p>
          </div>
        </UiCard>
      </NuxtLink>
    </div>
    <UiEmptyState
      v-else-if="error"
      headline="Couldn't load your projects"
      sub="Something went wrong fetching this page. Refresh to try again."
      data-testid="my-projects-error"
    />
    <UiEmptyState
      v-else-if="!pending"
      headline="No project memberships"
      sub="You'll see a card here for every project you're assigned to."
    />
    <div v-else class="text-center text-sm text-carbon-3 py-12">Loading…</div>
  </div>
</template>
