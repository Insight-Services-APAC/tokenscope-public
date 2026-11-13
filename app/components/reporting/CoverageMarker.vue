<script setup lang="ts">
/*
 * CoverageMarker — the GitHub enterprise-org coverage marker on a report
 * header (requirement 5 / Workstream D `meta.coverage`, ReportCoverageMeta).
 * Mirrors SettlingStateChip's role for the settlement axis: reads-only,
 * NEVER a live probe, and NEVER claims completeness it cannot back.
 *
 * `denominator == null` (any relevant enterprise unavailable/capped/stale —
 * server/reports/coverage-meta.ts's weakest-link suppression) renders an
 * explicit "coverage unknown" / "recheck needed" marker — NEVER a fabricated
 * "N of M" ratio and NEVER a bare omission that could read as "fully covered".
 * `applicable === false` (no GitHub provider_enterprise registered at all)
 * renders nothing — there is nothing to caveat.
 *
 * `compact` (D8b — the cost-centres top layer): the pill renders ALONE and the
 * descriptor sentence rides its tooltip. The sentence is relocated, not
 * reworded — the same string, from the same fields, one hover away.
 */
import { computed } from 'vue'
import UiBadge from '../ui/Badge.vue'
import type { ReportCoverageMeta } from '#shared/reports/types'

const props = withDefaults(
  defineProps<{
    coverage?: ReportCoverageMeta | null
    /** Chip-only: suppress the inline sentence and carry it as the tooltip. */
    compact?: boolean
  }>(),
  { coverage: null, compact: false },
)

const applicable = computed(() => props.coverage?.applicable === true)
const known = computed(() => applicable.value && props.coverage!.denominator != null)

const pill = computed(() => {
  if (!applicable.value) return ''
  if (known.value) return 'Coverage known'
  return props.coverage!.stale ? 'Coverage out of date' : 'Coverage unknown'
})

/*
 * #634: plain words. The stale sentence names where the count is refreshed:
 * the Recheck button on Admin, Providers (app/pages/admin/reconciliation.vue,
 * providers tab), which the route lets only the Admin role press
 * (server/api/v1/admin/reconciliation/github/coverage-recheck.post.ts).
 */
const descriptor = computed(() => {
  const c = props.coverage
  if (!c || !applicable.value) return ''
  if (known.value) return `Covers ${c.connected} of ${c.denominator} GitHub organisations.`
  return c.stale
    ? 'The count of GitHub organisations is out of date. An admin can refresh it under Admin, Providers.'
    : "We could not count this company's GitHub organisations, so we cannot say how many of them this figure covers."
})
</script>

<template>
  <span
    v-if="applicable"
    class="inline-flex items-center gap-2 flex-wrap"
    data-testid="coverage-marker"
    :data-known="known"
    :title="compact ? descriptor : undefined"
  >
    <UiBadge :kind="known ? 'neutral' : 'rag-amber'" :dot="known ? undefined : 'amber'">{{ pill }}</UiBadge>
    <span v-if="!compact" class="text-[11px] text-carbon-3">{{ descriptor }}</span>
    <!-- `title` never reaches screen readers or touch; the disclosure copy must. -->
    <span v-if="compact" class="sr-only" data-testid="coverage-marker-sr">{{ descriptor }}</span>
  </span>
</template>
