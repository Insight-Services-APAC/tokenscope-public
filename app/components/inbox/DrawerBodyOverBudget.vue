<script setup lang="ts">
/*
 * DrawerBodyOverBudget — body content for an over-budget inbox item.
 *
 * Per design-notes §Screen 7 drawer body: re-drawn pbar +
 * "Suggested action" copy + "How we know" with OTel coverage % and
 * Anthropic backfill %.
 *
 * Body payload fields read (all optional — render gracefully if
 * missing):
 *   - project   : string  (display name or code)
 *   - usedUsd   : number
 *   - capUsd    : number
 *   - overBy    : number  (legacy short-hand)
 *   - otelPct   : number 0..1
 *   - anthroPct : number 0..1
 */

import UiPbar from '../ui/Pbar.vue'
import { fmtUsd } from '../../composables/useFormat'

const props = defineProps<{
  body: Record<string, unknown>
}>()

function num(k: string): number | null {
  const v = props.body[k]
  return typeof v === 'number' ? v : null
}

const project = (props.body.project as string | undefined) ?? 'this project'
const usedUsd = num('usedUsd')
const capUsd = num('capUsd')
const overByRaw = num('overBy')
const overBy =
  overByRaw !== null
    ? overByRaw
    : usedUsd !== null && capUsd !== null
      ? Math.max(0, usedUsd - capUsd)
      : null
const pct = usedUsd !== null && capUsd !== null && capUsd > 0 ? usedUsd / capUsd : null
const otelPct = num('otelPct')
const anthroPct = num('anthroPct')

// The overrun rounded UP to the next $10 (so it covers it, #587); floor at $50.
const suggestedTopupUsd = overBy !== null ? Math.max(50, Math.ceil(overBy / 10) * 10) : null
</script>

<template>
  <section class="space-y-5">
    <div v-if="pct !== null && usedUsd !== null && capUsd !== null">
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Consumption
      </div>
      <UiPbar :pct="pct" size="lg" />
      <div class="text-xs text-carbon-2 mt-2 flex justify-between">
        <span>{{ Math.round(pct * 100) }}% used</span>
        <span style="font-variant-numeric: tabular-nums">
          {{ fmtUsd(usedUsd) }} of {{ fmtUsd(capUsd) }}
        </span>
      </div>
    </div>
    <div v-else class="text-xs text-carbon-3 italic">
      Consumption numbers not included in this alert; open the project view for live state.
    </div>
    <div>
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Suggested action
      </div>
      <p v-if="suggestedTopupUsd !== null && pct !== null" class="text-sm text-carbon-2 leading-relaxed">
        <!-- #587: over 100%, nothing "remains": the top-up covers the overrun. -->
        Add a {{ fmtUsd(suggestedTopupUsd, { whole: true }) }} top-up to cover the
        {{ Math.max(1, Math.round((pct - 1) * 100)) }}% over, or open the project to
        discuss with the team. TokenScope won't block sessions.
      </p>
      <p v-else class="text-sm text-carbon-2 leading-relaxed">
        Open the project to talk through next steps. TokenScope won't block
        sessions while you decide.
      </p>
    </div>
    <div v-if="otelPct !== null || anthroPct !== null">
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        How we know
      </div>
      <ul class="text-xs text-carbon-2 leading-relaxed space-y-1">
        <li v-if="otelPct !== null">
          OTel-attributed sessions: {{ Math.round(otelPct * 100) }}% of {{ project }}'s spend
        </li>
        <li v-if="anthroPct !== null">
          Anthropic Analytics API backfill: {{ Math.round(anthroPct * 100) }}% (developers not yet on the plugin)
        </li>
        <li>Actuals lag ~1 hr behind real-time.</li>
      </ul>
    </div>
  </section>
</template>
