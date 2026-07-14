<script setup lang="ts">
/*
 * DriversTable — the ranked driver breakdown with a visible sum-back check.
 *
 * build-design §3/§5 + owner-decisions D-Q6:
 *  - `update:axis` re-pivots the breakdown (region / practice / teammate / …).
 *  - `drill` fires when a row is activated (accessible <button> per row).
 *  - A sum-back CHECK ROW compares Σ(rows) to `headlineUsd` and goes RED on any
 *    mismatch — drivers must reconcile to the headline in the same lane.
 *  - ANY `spendClass:'pooled-usage'` row FORCES the footer
 *    "per-seat share is informational — billing is pooled" (Copilot per-seat
 *    share is never a charge). Informational rows (indicative / pooled-usage /
 *    estimated) render muted so they never read like a hard dollar — this is also the
 *    Overage-Drivers presentation (a proportional INDICATIVE share, never a
 *    charge; D-Q6 layer 3).
 */
import { computed } from 'vue'
import UiBadge from '../ui/Badge.vue'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import type { DriverRow, SpendClass } from '#shared/reports/types'

export interface AxisOption {
  value: string
  label: string
}

const props = withDefaults(
  defineProps<{
    rows: DriverRow[]
    /** The lane headline the rows must sum back to. */
    headlineUsd: number
    /** Currently selected axis (v-model of `update:axis`). */
    axis: string
    axisOptions: AxisOption[]
    /** e.g. "region usage" — rendered as "share of {denominatorLabel}". */
    denominatorLabel: string
    /** Extra footer copy (a pooled-usage row overrides this with the forced copy). */
    pooledFooter?: string
  }>(),
  { pooledFooter: undefined },
)

const emit = defineEmits<{
  (e: 'update:axis', value: string): void
  (e: 'drill', row: DriverRow): void
}>()

const POOLED_FOOTER = 'per-seat share is informational — billing is pooled'

const sum = computed(() => props.rows.reduce((a, r) => a + r.usd, 0))
// Sub-cent tolerance absorbs float noise; anything larger is a real mismatch.
const mismatch = computed(() => Math.abs(sum.value - props.headlineUsd) > 0.005)

const hasPooled = computed(() => props.rows.some((r) => r.spendClass === 'pooled-usage'))
const footer = computed(() => (hasPooled.value ? POOLED_FOOTER : (props.pooledFooter ?? '')))

// `estimated` is ALSO informational (shared/reports/types: "emitted, not the billed P&L
// figure") — an inference/run-rate $, never a hard charge. It must render muted + badged like
// `indicative`/`pooled-usage`, not identical to a real billed row.
function isInformational(sc: SpendClass): boolean {
  return sc === 'indicative' || sc === 'pooled-usage' || sc === 'estimated'
}
function badgeFor(sc: SpendClass): { kind: 'neutral' | 'vision'; label: string } | null {
  if (sc === 'pooled-usage') return { kind: 'neutral', label: 'pooled' }
  if (sc === 'indicative') return { kind: 'vision', label: 'indicative' }
  if (sc === 'estimated') return { kind: 'neutral', label: 'estimated' }
  return null
}

function onAxis(e: Event) {
  const value = (e.target as HTMLSelectElement).value
  if (value !== props.axis) emit('update:axis', value)
}
</script>

<template>
  <div data-testid="drivers-table">
    <div class="flex items-center justify-between gap-4 mb-3 flex-wrap">
      <div class="text-[11px] text-carbon-3">share of {{ denominatorLabel }}</div>
      <label class="flex items-center gap-2 text-[12px] text-carbon-2">
        <span>Break down by</span>
        <select
          :value="axis"
          class="text-[12px] border border-calm-2 rounded-md px-2 py-1 bg-white text-carbon-1"
          data-testid="drivers-axis"
          aria-label="Break down drivers by"
          @change="onAxis"
        >
          <option v-for="o in axisOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
    </div>

    <table class="w-full text-sm">
      <thead>
        <tr class="text-[11px] uppercase tracking-wide text-carbon-3 border-b border-calm-2">
          <th class="text-left font-semibold py-2">Driver</th>
          <th class="text-right font-semibold py-2">Spend</th>
          <th class="text-right font-semibold py-2 w-[80px]">Share</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.key" class="border-b border-calm-1 last:border-0 hover:bg-calm-1/40">
          <td class="py-2.5">
            <button
              type="button"
              class="font-medium text-left text-carbon-1 hover:text-brand-harmony hover:underline"
              data-testid="drivers-drill"
              @click="emit('drill', r)"
            >{{ r.label }}</button>
            <UiBadge
              v-if="badgeFor(r.spendClass)"
              :kind="badgeFor(r.spendClass)!.kind"
              class="ml-2 align-middle"
            >{{ badgeFor(r.spendClass)!.label }}</UiBadge>
          </td>
          <td
            class="py-2.5 text-right tabular-nums"
            :class="isInformational(r.spendClass) ? 'text-carbon-3 italic' : 'text-carbon-1'"
            :title="isInformational(r.spendClass) ? 'informational — not a charge' : undefined"
          >{{ fmtUsd(r.usd) }}</td>
          <td class="py-2.5 text-right tabular-nums text-carbon-2">{{ fmtPct(r.sharePct) }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="3" class="py-8 text-center text-carbon-3 text-sm">No drivers in this lane.</td>
        </tr>
      </tbody>
      <tfoot>
        <tr
          class="border-t-2"
          :class="mismatch ? 'border-rag-red text-rag-red' : 'border-calm-2 text-carbon-2'"
          data-testid="drivers-sumback"
          :data-mismatch="mismatch"
        >
          <td class="py-2.5 font-semibold">
            Σ drivers
            <span v-if="mismatch" class="ml-1 text-[11px] font-bold">≠ headline — does not reconcile</span>
            <span v-else class="ml-1 text-[11px] text-carbon-3">reconciles to headline</span>
          </td>
          <td class="py-2.5 text-right tabular-nums font-semibold">{{ fmtUsd(sum) }}</td>
          <td class="py-2.5 text-right tabular-nums text-[11px]">/ {{ fmtUsd(headlineUsd) }}</td>
        </tr>
      </tfoot>
    </table>

    <p v-if="footer" class="mt-2 text-[11px] text-carbon-3 italic" data-testid="drivers-pooled-footer">
      {{ footer }}
    </p>
  </div>
</template>
