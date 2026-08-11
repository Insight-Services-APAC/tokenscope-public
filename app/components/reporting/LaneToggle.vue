<script setup lang="ts">
/*
 * LaneToggle — the PRIMARY LENS control (the §A/§B re-lens,
 * provider-billing-attribution-model.md). A segmented control that flips a
 * surface's primary lens between USAGE (§A — what was consumed) and CHARGEBACK
 * (§B cost-of-record — what cross-charges to cost-centres). A one-line caption
 * under the control changes with the mode so the lens is always
 * self-explaining — the two concerns are NEVER conflated.
 *
 * TWO OWNERS, ONE CONTROL:
 *
 *   - Uncontrolled (no `model-value` bound) — self-wires to useReportState(),
 *     the SOLE owner of the reporting `?lane=` key, exactly like
 *     DateRangeControl binds `?month`/`?from`/`?to`. This is how the across /
 *     regional / cost-centre scopes use it. NOT rendered on Finance (which is
 *     already pure §B).
 *   - Controlled (`v-model`) — the personal surfaces (ADR 0012), which own
 *     their own lane through usePersonalLens() because useReportState writes
 *     the whole reporting query and the dashboard has no report scope.
 *
 * `captions` is overridable for the same reason the surfaces differ: the
 * reporting area answers `usage` from provider usage truth while the personal
 * surfaces answer it from attributed telemetry, so one caption cannot be true
 * of both. The LENS is shared; the sentence explaining the source is not.
 *
 * `showCaption` exists because the /reporting header no longer prints the
 * explainer under the control: the sentence moved into that page's notes
 * disclosure (ReportHeaderNotes), with the control — a CONTROL, not commentary —
 * left above the fold. The personal surfaces keep the inline caption, so the
 * default is `true` and nothing changes for them.
 */
import { computed } from 'vue'
import { PERSONAL_LENS_COPY, SPEND_LENSES } from '#shared/usage/lens'
import { REPORT_LANE_CAPTIONS } from './lane-captions'
import type { ReportLane } from '../../composables/useReportState'

const props = withDefaults(
  defineProps<{
    /** Bind to take ownership of the lane; omit to self-wire to the report URL state. */
    modelValue?: ReportLane
    /** Per-surface explanation of each lens. Defaults to the reporting-area copy. */
    captions?: Record<ReportLane, string>
    /** Render the explainer under the control. Off where the page shows it elsewhere. */
    showCaption?: boolean
  }>(),
  { modelValue: undefined, captions: undefined, showCaption: true },
)
const emit = defineEmits<{ 'update:modelValue': [ReportLane] }>()

const rs = useReportState()

// Derived from the shared lens vocabulary, so a lens added there cannot be
// silently unreachable from the control that selects it.
const LANES = SPEND_LENSES.map((key) => ({
  key,
  label: PERSONAL_LENS_COPY[key].label,
  qualifier: PERSONAL_LENS_COPY[key].qualifier,
}))

const active = computed<ReportLane>(() => props.modelValue ?? rs.lane.value)
const caption = computed(() => (props.captions ?? REPORT_LANE_CAPTIONS)[active.value])

function select(lane: ReportLane) {
  if (props.modelValue !== undefined) emit('update:modelValue', lane)
  else rs.lane.value = lane
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
        :aria-pressed="active === l.key"
        class="px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap"
        :class="
          active === l.key
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
    <p
      v-if="showCaption"
      class="text-[11px] leading-snug text-carbon-3 max-w-[22rem]"
      data-testid="lane-caption"
    >
      {{ caption }}
    </p>
  </div>
</template>
