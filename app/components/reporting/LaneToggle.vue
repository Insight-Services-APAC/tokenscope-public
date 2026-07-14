<script setup lang="ts">
/*
 * LaneToggle — the PRIMARY LENS control for the across / regional / cost-centre
 * reporting scopes (the §A/§B "full re-lens", provider-billing-attribution-model.md).
 * Peer to the DateRangeControl: a segmented control that flips the report's primary
 * lens between USAGE (§A attributed usage — what was consumed) and CHARGEBACK (§B
 * cost-of-record — what cross-charges to cost-centres).
 *
 * Self-wires to useReportState() (the SOLE owner of the `?lane=` URL key), exactly
 * like DateRangeControl binds `?month`/`?from`/`?to`. NOT rendered on Finance (which
 * is already pure §B). A one-line caption under the control changes with the mode so
 * the lens is always self-explaining — the two concerns are NEVER conflated.
 */
import type { ReportLane } from '../../composables/useReportState'

const rs = useReportState()

const LANES: { key: ReportLane; label: string; qualifier: string }[] = [
  { key: 'usage', label: 'Usage', qualifier: 'attributed' },
  { key: 'chargeback', label: 'Chargeback', qualifier: 'billed' },
]

const CAPTION: Record<ReportLane, string> = {
  usage: 'Provider usage truth — what was consumed. Not an invoice; includes NFR/exempt.',
  chargeback:
    'Cost-of-record — what cross-charges to cost-centres. Copilot pooled per cost-centre (pending validation).',
}

function select(lane: ReportLane) {
  rs.lane.value = lane
}
</script>

<template>
  <div class="inline-flex flex-col gap-1.5" data-testid="lane-toggle">
    <div
      class="inline-flex p-0.5 bg-calm-2 rounded-lg gap-0.5 w-fit"
      role="group"
      aria-label="Report lens"
    >
      <button
        v-for="l in LANES"
        :key="l.key"
        type="button"
        :aria-pressed="rs.lane.value === l.key"
        class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap"
        :class="
          rs.lane.value === l.key
            ? 'bg-white text-brand-harmony shadow-sm'
            : 'text-carbon-2 hover:text-brand-harmony'
        "
        :data-testid="`lane-${l.key}`"
        @click="select(l.key)"
      >
        {{ l.label }}
        <span class="text-carbon-3 font-normal">· {{ l.qualifier }}</span>
      </button>
    </div>
    <p class="text-[11px] leading-snug text-carbon-3 max-w-[22rem]" data-testid="lane-caption">
      {{ CAPTION[rs.lane.value] }}
    </p>
  </div>
</template>
