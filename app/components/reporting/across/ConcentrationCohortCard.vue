<script setup lang="ts">
/*
 * ConcentrationCohortCard — "Concentration: how few people the spend actually
 * sits with" (prototype.html, the `Concentration` card).
 *
 * THE QUESTION IT ANSWERS, and why the KPI row cannot. Every other card on this
 * page answers HOW MUCH. None of them answers HOW MANY, so a reader seeing
 * "spend is up" has no way to tell whether to change a policy or ring two
 * people. The Median-per-person tile publishes the three percentiles
 * (26% / 48% / 63%) but a percentile is not a population: it says what share the
 * top decile holds, never how many humans that decile IS.
 *
 * IT SHARES THE KPI'S ARITHMETIC RATHER THAN RE-DERIVING IT. `cohorts` is cut
 * server-side at the SAME indices as `top1` / `top10` (across-regions.ts), so
 * cohort[0] IS the top-1% share and the first two cohorts sum to the top-10%
 * share EXACTLY. This card nearly shipped once as a second, disagreeing answer —
 * an earlier draft's cohorts were off the KPI's by seven points — which is the
 * "one fact, one home" defect wearing a detail view's clothes. The headline
 * sentence below therefore quotes `top10` itself, not a sum this component did.
 *
 * WHAT IS NOT HERE. The prototype also shows a model-tier cross-tab per cohort
 * ("TOP 10%: Frontier 74% / Mid 19% / Economy 7%" against "EVERYONE ELSE:
 * 51% / 26% / 23%") — what the heavy decile does DIFFERENTLY. That is not
 * buildable from this payload: `ConcentrationStats` carries no tier axis, and
 * joining cohorts to `model_catalog.tier` needs a new server measure. It is NOT
 * approximated from the Behavioural-exposure card, whose denominator is billed
 * spend over a different (rolling) window and a different lane — an approximation
 * there would be a fabricated cross-tab, which is worse than an absent one.
 *
 * MINIMUM POPULATION. Below `MIN_COHORT` people a decile is one or two named
 * individuals, so the card is a leaderboard wearing the clothes of a
 * distribution. It renders nothing rather than pointing at a person.
 *
 * §A ATTRIBUTED in both lenses — a cohort of PEOPLE's consumption.
 * `provider_usage_fact` carries no equivalent cohort, so this is never re-lensed
 * onto billed money (consistency contract C2).
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import { useChartTheme } from '../charts/useChartTheme'
import { fmtUsd, fmtPct } from '../../../composables/useFormat'
import type { ConcentrationStats } from '../across-report-types'

const props = defineProps<{ stats: ConcentrationStats | null }>()

/*
 * Thirty, not five. The Median tile suppresses at five because below that a
 * "median" names an individual; a DECILE needs an order of magnitude more before
 * "the top 1%" is a band rather than one person (the prototype gates this card
 * at 30 for the same reason). The two thresholds differ because the two
 * statistics fail at different sizes, not by oversight.
 */
const MIN_COHORT = 30

const { readVar } = useChartTheme()

/*
 * Heaviest cohort in the brand's lead hue, decreasing to the neutral kit grey —
 * a SEQUENTIAL ramp, because these bands are ordered (dataviz: a categorical
 * cycle here would imply the cohorts are unrelated kinds). Colour is never the
 * only carrier: every band is labelled in the legend beneath it.
 */
const BAND_TOKENS = ['--brand-hunger', '--brand-harmony', '--brand-vision', '--calm'] as const

const cohorts = computed(() => props.stats?.cohorts ?? [])

const show = computed(
  () =>
    props.stats != null &&
    props.stats.activeUsers >= MIN_COHORT &&
    props.stats.totalUsd > 0 &&
    cohorts.value.length > 0,
)

const bands = computed(() =>
  cohorts.value.map((c, i) => ({
    ...c,
    colour: readVar(BAND_TOKENS[Math.min(i, BAND_TOKENS.length - 1)]!) || 'transparent',
  })),
)

/*
 * "21 of 207 active developers — the top 10% — account for 63% of attributed
 * spend ($25,012.49)."
 *
 * The COUNT is Σ of the cohorts that make up the top decile (the ones cut inside
 * `top10`), and the SHARE is `top10` itself rather than a re-sum, so the sentence
 * cannot drift from the KPI tile even by a rounding step. The money is
 * `totalUsd × top10` — a share OF a measured total, which is the one arithmetic
 * the lane contract permits here; it is not a figure derived from a ratio of two
 * different lanes.
 */
const headline = computed(() => {
  const s = props.stats
  if (!s) return null
  // The cohorts inside the top decile are exactly those before the "Next 40%"
  // cut — i.e. "Top 1%" + "Next 9%" — by the server's own partition order.
  const topDecile = cohorts.value.slice(0, 2)
  const people = topDecile.reduce((a, c) => a + c.count, 0)
  if (people === 0) return null
  return {
    people,
    of: s.activeUsers,
    sharePct: s.top10,
    usd: s.totalUsd * s.top10,
  }
})
</script>

<template>
  <UiCard v-if="show && headline" data-testid="concentration-cohort-card">
    <div class="text-sm font-semibold text-carbon-1 mb-0.5">Concentration</div>
    <p class="text-[11px] text-carbon-3 mb-3">How few people the spend actually sits with</p>

    <p class="text-[15px] leading-snug text-carbon mb-1" data-testid="concentration-headline">
      <b class="font-bold tabular-nums">{{ headline.people }} of {{ headline.of }}</b>
      active developers — the top 10% — account for
      <b class="font-bold tabular-nums">{{ fmtPct(headline.sharePct) }}</b>
      of attributed spend
      <span class="tabular-nums">({{ fmtUsd(headline.usd) }})</span>.
    </p>

    <div class="flex h-6 rounded-md overflow-hidden mt-2.5" data-testid="concentration-bar">
      <i
        v-for="b in bands"
        :key="b.key"
        class="block h-full"
        :style="{ width: `${(b.sharePct * 100).toFixed(1)}%`, background: b.colour }"
        :title="`${b.label} · ${b.count} people · ${fmtPct(b.sharePct)} · ${fmtUsd(b.totalUsd)}`"
      />
    </div>

    <ul class="flex flex-wrap gap-x-4 gap-y-1.5 mt-2.5 text-[11px] text-carbon-2 tabular-nums">
      <li
        v-for="b in bands"
        :key="b.key"
        class="flex items-center gap-1.5"
        :data-testid="`concentration-cohort-${b.key}`"
      >
        <span
          class="inline-block w-2 h-2 rounded-sm shrink-0"
          :style="{ background: b.colour }"
          aria-hidden="true"
        />
        <span>
          {{ b.label }} · {{ b.count }} {{ b.count === 1 ? 'person' : 'people' }} ·
          {{ fmtPct(b.sharePct) }} · {{ fmtUsd(b.totalUsd) }}
        </span>
      </li>
    </ul>
  </UiCard>
</template>
