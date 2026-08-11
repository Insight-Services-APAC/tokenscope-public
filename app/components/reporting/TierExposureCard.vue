<script setup lang="ts">
/*
 * TierExposureCard — "Behavioural exposure": billed spend banded by the CHOICE,
 * not the product (docs/design/reporting-consolidation/04-prototype-delta.md §5).
 *
 * WHY TWO BARS. Every band here is a PREMIUM RATE, so a spend share on its own
 * overstates how much a thing is actually used. Billed spend over consumption,
 * SAME bands, and the discrepancy between them IS the premium. A single bar
 * would say "63%" and leave the reader to guess whether that was a lot of work
 * or a dear one.
 *
 * WHY BANDS AND NOT A MODEL LIST. The list is the Model driver axis over again.
 * A band is a target you can set.
 *
 * WHY THE TREND. A share metric with no time axis cannot show that a policy
 * worked — "frontier is 63%" is not an argument until you can see it was 58%.
 *
 * DISCRIMINATED BY PROVIDER, because they do not meter the same thing. Anthropic
 * gives money AND tokens per model; Copilot gives a model dimension with NO
 * money on it (`ai_credits_used` sits at the record root, day grain), so its
 * bands carry activity mix and its credits are reported whole. Splitting a day's
 * credits across models by activity share would be a ratio, and this design does
 * not do ratios anywhere.
 *
 * Colours resolve CSS custom properties through `useChartTheme().readVar` — never
 * a hardcoded hex, so a rebrand or a dark theme flows in (charts/useChartTheme.ts).
 */
import { computed, ref } from 'vue'
import UiCard from '../ui/Card.vue'
import ChartTrend, { type TrendSeries } from './charts/ChartTrend.client.vue'
import { useChartTheme } from './charts/useChartTheme'
import {
  buildExposureView,
  contextBandToken,
  CONTEXT_REMAINDER_TOKEN,
  TIER_BAND_TOKENS,
} from './build-tier-exposure'
import { fmtUsd, fmtPct, fmtTokens } from '../../composables/useFormat'
import {
  TIER_BANDS,
  TIER_BAND_LABELS,
  type TierExposure,
  type TierExposureArm,
} from '#shared/reports/tier-exposure'
import { CONTEXT_UNBANDED_REASON_LABELS } from '#shared/reports/context-window'
import { vendorLabel } from '#shared/reports/types'

const props = defineProps<{
  exposure: TierExposure | null
  /** Window label echoed in the subtitle (rolling window or custom range). */
  windowLabel?: string
}>()

const { readVar } = useChartTheme()
const colour = (token: string) => readVar(token) || 'transparent'

/**
 * The exposure chips — BOTH real data since W0a D6. "Model tier" bands by
 * `model_catalog.tier`; "Context tier" reads
 * `provider_usage_fact.context_window`, the dimension the provider now groups
 * by (the ghost constant that used to sit here is retired — its own note said
 * "if a group_by request lands them, this constant goes"). `speed` is not
 * taken (no card needs it), so there is no third chip and no ghost.
 */
const TIER_KEY = 'tier'
const CONTEXT_KEY = 'context-window'
const selected = ref<string>(TIER_KEY)
const chips = computed(() => [
  { key: TIER_KEY, label: 'Model tier' },
  { key: CONTEXT_KEY, label: 'Context tier' },
])

const arms = computed<TierExposureArm[]>(() => props.exposure?.providers ?? [])
const views = computed(() =>
  arms.value.map((arm) => ({ arm, view: buildExposureView(arm) })),
)

/**
 * Arms whose wire CARRIES the dimension (`contextWindow` leg present). A
 * `mix-only` arm is ABSENT rather than rendered empty: Copilot has no
 * context-window dimension to collect, which is a different fact from "no
 * rows in this window" and must not be dressed as one.
 */
const contextArms = computed(() =>
  arms.value.filter(
    (arm): arm is TierExposureArm & { contextWindow: NonNullable<TierExposureArm['contextWindow']> } =>
      arm.contextWindow !== null,
  ),
)

/**
 * The trend: one stacked area per band, carrying that band's SHARE of the day's
 * banded spend. Share rather than dollars because the question the card asks is
 * "did the mix move", and a dollar series answers "did spend move" — which the
 * Spend-trend card already answers one card up.
 *
 * Only arms that band money get a trend. A `mix-only` arm has no banded money to
 * take a share OF, and drawing its activity mix in the same visual grammar would
 * invite reading it as money.
 */
const trendArm = computed(() => views.value.find((v) => v.arm.bandedSpendUsd > 0)?.arm ?? null)
const trendSeries = computed<TrendSeries[]>(() => {
  const arm = trendArm.value
  if (!arm) return []
  const byDay = new Map<string, Map<string, number>>()
  const dayTotals = new Map<string, number>()
  for (const cell of arm.series) {
    const row = byDay.get(cell.day) ?? new Map<string, number>()
    row.set(cell.band, (row.get(cell.band) ?? 0) + cell.spendUsd)
    byDay.set(cell.day, row)
    dayTotals.set(cell.day, (dayTotals.get(cell.day) ?? 0) + cell.spendUsd)
  }
  const days = [...byDay.keys()].sort()
  return TIER_BANDS.filter((band) => arm.bands.some((b) => b.band === band && b.spendUsd !== 0)).map(
    (band) => ({
      name: TIER_BAND_LABELS[band],
      key: band,
      // Bands are an ORDINAL scale, not a vendor lane, so the registry's
      // `colorForKey` would paint all six the same neutral. The token is
      // resolved here and passed through, keeping the rebrand path intact.
      color: colour(TIER_BAND_TOKENS[band]),
      // A day with no banded spend has no share to state — it is left out, so the
      // area shows a GAP rather than asserting the mix collapsed to zero.
      data: days
        .filter((day) => (dayTotals.get(day) ?? 0) > 0)
        .map((day) => ({
          x: day,
          y: (byDay.get(day)?.get(band) ?? 0) / (dayTotals.get(day) ?? 1),
        })),
    }),
  )
})

const pctAxis = (v: number) => fmtPct(v)

function consumptionLabel(arm: TierExposureArm, value: number | null): string {
  if (value === null) return 'not counted'
  return arm.unit === 'tokens' ? `${fmtTokens(value)} tokens` : `${value.toLocaleString()} interactions`
}
</script>

<template>
  <UiCard data-testid="tier-exposure-card">
    <div class="text-sm font-semibold text-carbon-1">Behavioural exposure</div>
    <div class="text-[11px] text-carbon-3 mb-3">
      Billed spend banded by the choice, not the product — each band is one thing a developer or a
      policy can change<template v-if="windowLabel"> · {{ windowLabel }}</template>
    </div>

    <div class="flex flex-wrap gap-1.5 mb-3">
      <button
        v-for="c in chips"
        :key="c.key"
        type="button"
        class="text-[11px] px-2 py-1 rounded-full border transition-colors"
        :class="
          c.key === selected
            ? 'border-carbon-3 bg-carbon-1 text-white'
            : 'border-calm text-carbon-3 hover:border-carbon-3'
        "
        :data-testid="`exposure-chip-${c.key}`"
        @click="selected = c.key"
      >
        {{ c.label }}
      </button>
    </div>

    <!-- Context tier — REAL data from provider_usage_fact.context_window
         (W0a D6): money and tokens per provider-reported band, plus the
         reason-typed un-banded remainder, never folded into a band. -->
    <div v-if="selected === CONTEXT_KEY" data-testid="exposure-context-window">
      <p v-if="!exposure" class="text-xs text-carbon-3 italic py-8 text-center">
        Loading behavioural exposure…
      </p>

      <div v-for="arm in contextArms" v-else :key="arm.provider" class="mb-5 last:mb-0">
        <div class="flex items-baseline justify-between gap-2 mb-1.5 flex-wrap">
          <div class="text-xs font-semibold text-carbon-2">
            {{ vendorLabel(arm.provider) }}
          </div>
          <div
            v-if="arm.availability === 'ok' && arm.contextWindow.bandedSpendUsd > 0"
            class="text-[11px] text-carbon-3 tabular-nums"
          >
            {{ fmtUsd(arm.contextWindow.bandedSpendUsd) }} banded
          </div>
        </div>

        <p
          v-if="arm.availability === 'no-data-yet'"
          class="text-[11px] text-carbon-2 border border-dashed border-calm rounded px-2 py-2"
          :data-testid="`exposure-no-data-${arm.provider}`"
        >
          Not banded yet — no {{ vendorLabel(arm.provider) }} rows in the normalised layer.
          This is not $0.
        </p>

        <p
          v-else-if="!arm.contextWindow.bands.length && arm.contextWindow.unbandedSpendUsd === 0"
          class="text-[11px] text-carbon-2"
          :data-testid="`exposure-context-empty-${arm.provider}`"
        >
          No {{ vendorLabel(arm.provider) }} rows in this window.
        </p>

        <template v-else>
          <div v-if="arm.contextWindow.bands.some((b) => b.spendSharePct !== null && b.spendUsd !== 0)" class="mb-2">
            <div class="text-[11px] text-carbon-3 mb-1">Billed spend</div>
            <div class="flex h-3 rounded overflow-hidden" :data-testid="`exposure-context-money-${arm.provider}`">
              <template v-for="(b, i) in arm.contextWindow.bands" :key="b.band">
                <i
                  v-if="b.spendSharePct !== null && b.spendUsd !== 0"
                  class="block h-full"
                  :style="{ width: `${(b.spendSharePct * 100).toFixed(1)}%`, background: colour(contextBandToken(i)) }"
                  :title="`${b.band} · ${fmtPct(b.spendSharePct)}`"
                />
              </template>
            </div>
          </div>

          <div v-if="arm.contextWindow.bands.some((b) => b.tokensSharePct !== null)" class="mb-2">
            <div class="text-[11px] text-carbon-3 mb-1">Tokens</div>
            <div class="flex h-3 rounded overflow-hidden" :data-testid="`exposure-context-volume-${arm.provider}`">
              <template v-for="(b, i) in arm.contextWindow.bands" :key="b.band">
                <i
                  v-if="b.tokensSharePct !== null"
                  class="block h-full"
                  :style="{ width: `${(b.tokensSharePct * 100).toFixed(1)}%`, background: colour(contextBandToken(i)) }"
                  :title="`${b.band} · ${fmtPct(b.tokensSharePct)}`"
                />
              </template>
            </div>
          </div>

          <ul class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-carbon-2 mt-2">
            <li v-for="(b, i) in arm.contextWindow.bands" :key="b.band" class="flex items-center gap-1.5">
              <span
                class="inline-block w-2 h-2 rounded-full shrink-0"
                :style="{ background: colour(contextBandToken(i)) }"
              />
              <span>
                {{ b.band }}
                · {{ fmtUsd(b.spendUsd) }}
                <template v-if="b.spendSharePct !== null"> · {{ fmtPct(b.spendSharePct) }} spend</template>
                · {{ b.tokens === null ? 'not counted' : `${fmtTokens(b.tokens)} tokens` }}
              </span>
            </li>
          </ul>

          <!-- The reason-typed remainder: shrinks as the poll window rolls,
               and is never pretended into a band. -->
          <p
            v-if="arm.contextWindow.unbandedReason !== null"
            class="mt-2 text-[11px] text-carbon-3 leading-snug flex items-center gap-1.5"
            :data-testid="`exposure-context-remainder-${arm.provider}`"
          >
            <span
              class="inline-block w-2 h-2 rounded-full shrink-0"
              :style="{ background: colour(CONTEXT_REMAINDER_TOKEN) }"
            />
            {{ fmtUsd(arm.contextWindow.unbandedSpendUsd) }}
            {{ CONTEXT_UNBANDED_REASON_LABELS[arm.contextWindow.unbandedReason] }}
          </p>
        </template>
      </div>
    </div>

    <template v-else>
      <p v-if="!exposure" class="text-xs text-carbon-3 italic py-8 text-center">
        Loading behavioural exposure…
      </p>

      <div v-for="{ arm, view } in views" v-else :key="arm.provider" class="mb-5 last:mb-0">
        <div class="flex items-baseline justify-between gap-2 mb-1.5 flex-wrap">
          <div class="text-xs font-semibold text-carbon-2">
            {{ vendorLabel(arm.provider) }}
          </div>
          <div v-if="arm.availability === 'ok' && arm.bandedSpendUsd > 0" class="text-[11px] text-carbon-3 tabular-nums">
            {{ fmtUsd(arm.bandedSpendUsd) }} banded
          </div>
        </div>

        <!-- STRUCTURALLY different from a zero, and it has to read that way: a
             zero says nobody spent, this says the arm that would carry this
             provider's model grain has not been written yet. -->
        <p
          v-if="arm.availability === 'no-data-yet'"
          class="text-[11px] text-carbon-2 border border-dashed border-calm rounded px-2 py-2"
          :data-testid="`exposure-no-data-${arm.provider}`"
        >
          Not banded yet — no {{ vendorLabel(arm.provider) }} rows in the normalised layer.
          This is not $0.
        </p>

        <template v-else>
          <div v-if="view.bars.money.length" class="mb-2">
            <div class="text-[11px] text-carbon-3 mb-1">Billed spend</div>
            <div class="flex h-3 rounded overflow-hidden" :data-testid="`exposure-money-${arm.provider}`">
              <i
                v-for="s in view.bars.money"
                :key="s.band"
                class="block h-full"
                :style="{ width: `${(s.sharePct * 100).toFixed(1)}%`, background: colour(s.token) }"
                :title="`${s.label} · ${fmtPct(s.sharePct)}`"
              />
            </div>
          </div>
          <p
            v-else-if="arm.kind === 'mix-only'"
            class="text-[11px] text-carbon-2 mb-2"
            :data-testid="`exposure-unbanded-${arm.provider}`"
          >
            {{ fmtUsd(arm.unbandedSpendUsd) }} of credits, reported whole.
            {{ arm.unbandedNote }}
          </p>

          <div v-if="view.bars.volume.length" class="mb-2">
            <div class="text-[11px] text-carbon-3 mb-1">
              {{ arm.unit === 'tokens' ? 'Tokens' : 'User-initiated interactions' }}
            </div>
            <div class="flex h-3 rounded overflow-hidden" :data-testid="`exposure-volume-${arm.provider}`">
              <i
                v-for="s in view.bars.volume"
                :key="s.band"
                class="block h-full"
                :style="{ width: `${(s.sharePct * 100).toFixed(1)}%`, background: colour(s.token) }"
                :title="`${s.label} · ${fmtPct(s.sharePct)}`"
              />
            </div>
          </div>

          <ul class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-carbon-2 mt-2">
            <li v-for="row in view.legend" :key="row.band" class="flex items-center gap-1.5">
              <span
                class="inline-block w-2 h-2 rounded-full shrink-0"
                :style="{ background: colour(row.token) }"
              />
              <span>
                {{ row.label }}
                <template v-if="arm.kind === 'cost-and-tokens'">
                  · {{ fmtUsd(row.spendUsd) }}
                  <template v-if="row.spendSharePct !== null"> · {{ fmtPct(row.spendSharePct) }} spend</template>
                </template>
                · {{ consumptionLabel(arm, row.consumption) }}
              </span>
            </li>
          </ul>

          <p v-if="view.volumeCoverageNote" class="mt-2 text-[11px] text-carbon-3 leading-snug">
            {{ view.volumeCoverageNote }}
          </p>
        </template>
      </div>

      <div v-if="trendSeries.length" class="mt-4">
        <div class="text-[11px] text-carbon-3 mb-1">
          Share of billed spend<template v-if="windowLabel"> · {{ windowLabel }}</template>
        </div>
        <ChartTrend :series="trendSeries" :value-format="pctAxis" :stacked="true" :height="180" />
      </div>
    </template>
  </UiCard>
</template>
