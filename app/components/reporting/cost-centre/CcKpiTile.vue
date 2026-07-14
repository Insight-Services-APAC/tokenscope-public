<script setup lang="ts">
/*
 * CcKpiTile — the quiet, legible KPI tile for the Cost-Centre summary strip.
 *
 * Matches the Across flagship's AcrossKpiTile design language exactly: hairline
 * border, NO coloured top-bar, an uppercase eyebrow label + a big tabular-nums
 * value + a one-line sub. Two cost-centre-specific affordances:
 *   - `rag` renders a small RAG STATUS dot beside the label (over / near /
 *     on-track / none) — the summary's over/near/no-budget counts ARE a budget
 *     status, the one place RAG is legitimate (a delta would be neutral instead).
 *   - `muted` greys the value for the "no budget set" tile so a zero-risk count
 *     never shouts.
 */
import { computed } from 'vue'
import { useChartTheme, type RagState } from '../charts/useChartTheme'

const props = withDefaults(
  defineProps<{
    label: string
    value: string
    sub?: string
    /** A smaller muted caption under `sub` (e.g. what "Burn" counts). Optional. */
    hint?: string
    /** RAG status dot beside the label. `none` = a neutral (muted) dot. */
    rag?: RagState | 'none'
    /** Grey the value (the zero-emphasis "no budget set" tile). */
    muted?: boolean
  }>(),
  { sub: undefined, hint: undefined, rag: undefined, muted: false },
)

const { ragColor, readVar } = useChartTheme()

// Resolve the dot colour from the shared RAG source (never a hardcoded hex), with
// `none` falling to a recessive neutral so an empty risk bucket stays quiet.
const dotColor = computed(() => {
  if (props.rag == null) return null
  if (props.rag === 'none') return readVar('--carbon-3')
  return ragColor(props.rag)
})
</script>

<template>
  <div
    class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] px-5 py-4 flex flex-col gap-1.5 min-w-0"
    data-testid="cc-kpi-tile"
  >
    <div class="flex items-center gap-2 min-w-0">
      <span
        v-if="dotColor"
        class="inline-block w-2 h-2 rounded-full shrink-0"
        :style="{ background: dotColor }"
        aria-hidden="true"
      />
      <span class="text-[10.5px] font-bold uppercase tracking-[1.1px] text-carbon-3 truncate">
        {{ label }}
      </span>
    </div>

    <div
      class="text-[26px] leading-none font-bold tracking-[-0.5px] tabular-nums"
      :class="muted ? 'text-carbon-3' : 'text-carbon'"
    >
      {{ value }}
    </div>

    <div v-if="sub" class="text-[12px] leading-snug text-carbon-2">{{ sub }}</div>
    <div v-if="hint" class="text-[11px] leading-snug text-carbon-3">{{ hint }}</div>
  </div>
</template>
