<script setup lang="ts">
/*
 * CcOverSoftCap — "Unallocated spend over the soft cap", the cost-centre lead's
 * conversation list (docs/design/reporting-consolidation/04-prototype-delta.md §5).
 *
 * THE ONE SENTENCE: over the cap, spend should be on a budget.
 *
 * ── WHAT THIS CARD IS FOR, AND WHY IT HAS NO BUTTONS ────────────────────────
 * `tagUnaccountedTx` (server/utils/tag-unaccounted.ts) permits only a record's OWN
 * teammate to tag it, so a cost-centre owner cannot action a single row here. This
 * card's job is that the owner knows WHO to contact and ABOUT WHAT — so the copy
 * carries no verb the reader cannot perform. "Nudge them" and "allocate to
 * projects" describe the conversation; neither is a control.
 *
 * ── THE SPLIT IS BY WHAT THE READER CAN ACT ON ──────────────────────────────
 * Both groups are over the cap. They differ only in whether a budget already
 * exists to put the spend on:
 *   - ON PROJECTS   → a budget exists; the conversation is with the person.
 *   - ON NO PROJECT → nothing exists to tag to; the action is a PM's.
 * Someone whose projects have all ENDED is in the second group, not the first —
 * the server gates "active" on the same predicate the tag write path does, so a
 * row in the first group is one whose owner would actually be permitted to tag.
 *
 * ── THE RATE IS CONTEXT, NEVER A GATE ───────────────────────────────────────
 * The per-row tagging percentage answers "is this person trying and short, or not
 * tagging at all?" once the reader is already in the conversation. It is not what
 * puts them on the list. Someone tagging 88% of a large total can still leave 8×
 * the cap unallocated, and filtering on the rate would hide exactly them.
 *
 * ── THE DENOMINATOR IS NOT THE BURN, AND SAYS SO ────────────────────────────
 * These figures are ROSTER-anchored: the people PLACED in this cost centre, and
 * each person's OWN unallocated total wherever it was homed. The burn headline
 * above this card is a different question over a different population (usage
 * homed to this centre's projects). The copy names both so a reader cannot try to
 * reconcile them and conclude one is broken.
 *
 * EMPTY IS A SENTENCE, NOT A ZERO. With nobody over the cap the card renders "all
 * within allowance" — never a $0 headline, which reads as missing data on a
 * surface whose whole point is that money is not going unnoticed.
 */
import { computed } from 'vue'
import ExportCsvButton from '../ExportCsvButton.vue'
import DrillName from '../DrillName.vue'
import {
  teammateDrillTarget,
  NO_DRILL_GRANTS,
  type DrillFrame,
  type DrillGrants,
} from '../drill-contract'
import { fmtUsd, fmtPct } from '../../../composables/useFormat'
import type { OverSoftCap, OverSoftCapGroup, OverSoftCapRow } from '#shared/reports/types'
import { BU_LABEL_LOWER } from '#shared/reports/vocabulary'

const props = withDefaults(
  defineProps<{
    data: OverSoftCap
    /** Grid/CSV params for this card's own export (report=over-soft-cap). */
    exportParams?: Record<string, string | number | boolean | null | undefined>
    exportFilename?: string
    /*
     * THE DRILL CONTRACT (D29, fix 7). This card names people, so each name is a
     * link or plain text BY GRANT. The card still has NO row buttons — nothing
     * here is actionable by this reader (see the header) — and a drill is not an
     * action on the row, it is a different question about the person.
     */
    drillGrants?: DrillGrants
    drillFrame?: DrillFrame
  }>(),
  {
    exportParams: undefined,
    exportFilename: undefined,
    drillGrants: () => NO_DRILL_GRANTS,
    drillFrame: () => ({ src: null }),
  },
)

/*
 * BOTH FACTS COME OFF THE ROW (r5-H1) — this card infers neither.
 *
 * It used to hard-code `isActive: true`, justified by the roster CTE's
 * `WHERE t.is_active = TRUE` (engine/over-soft-cap.ts). Two things were wrong
 * with that. The small one: a CLIENT decision was pinned to a SERVER predicate
 * nothing rechecks, so loosening the roster would silently start rendering live
 * links onto pages that 403. The large one: `provisional` was not considered at
 * all, and a provisional SHADOW identity IS active — so an unauthenticated email
 * claim rendered as a live link on the cost-centre lead's own page.
 */
function targetFor(r: OverSoftCapRow) {
  return teammateDrillTarget(
    props.drillGrants,
    { id: r.teammateId, isActive: r.isActive, isProvisional: r.isProvisional },
    props.drillFrame,
  )
}

const d = computed(() => props.data)

const onProjects = computed(() => d.value.over.filter((r) => r.group === 'on-projects'))
const onNoProject = computed(() => d.value.over.filter((r) => r.group === 'on-no-project'))

/** Σ over BOTH groups — the headline. Zero only when `over` is empty, which takes the other branch. */
const overUsd = computed(() => d.value.over.reduce((a, r) => a + r.unallocatedUsd, 0))
const anyOver = computed(() => d.value.over.length > 0)

/** Bar scale — the largest row across both groups, so the two are visually comparable. */
const maxUnallocated = computed(() =>
  d.value.over.reduce((m, r) => Math.max(m, r.unallocatedUsd), 0),
)
const barPct = (r: OverSoftCapRow): string =>
  maxUnallocated.value > 0 ? `${((r.unallocatedUsd / maxUnallocated.value) * 100).toFixed(1)}%` : '0%'

const people = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`
const groupUsd = (rows: OverSoftCapRow[]): number => rows.reduce((a, r) => a + r.unallocatedUsd, 0)

interface GroupSpec {
  key: OverSoftCapGroup
  title: string
  sub: string
  pill: string
  rows: OverSoftCapRow[]
  /* rag-amber = a conversation; brand-vision = a PM allocation. Never red: nothing
     here is a breach, and colouring it as one would misstate the policy. */
  accent: string
}
const groups = computed<GroupSpec[]>(() =>
  [
    {
      key: 'on-projects' as const,
      title: 'On projects',
      sub: 'a budget exists to put this on',
      pill: 'nudge them',
      rows: onProjects.value,
      accent: 'var(--rag-amber)',
    },
    {
      key: 'on-no-project' as const,
      title: 'On no project',
      sub: 'no budget to put this on',
      pill: 'allocate to projects',
      rows: onNoProject.value,
      accent: 'var(--brand-vision)',
    },
  ].filter((g) => g.rows.length > 0),
)

const showExport = computed(() => Boolean(props.exportParams && props.exportFilename))
</script>

<template>
  <section
    class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] p-5"
    data-testid="cc-over-soft-cap"
  >
    <div class="text-sm font-semibold text-carbon-1">Unallocated spend over the soft cap</div>
    <p class="text-[12px] text-carbon-2 mt-0.5">Over the cap, spend should be on a budget</p>

    <!-- ═══════════ Somebody is over the cap ═══════════ -->
    <template v-if="anyOver">
      <div class="flex items-baseline gap-3.5 flex-wrap mt-3" data-testid="cc-osc-headline">
        <span class="text-[34px] leading-none font-extrabold tracking-[-0.03em] tabular-nums text-carbon">
          {{ fmtUsd(overUsd, { whole: true }) }}
        </span>
        <span class="text-[13px] text-carbon-2">
          across <b>{{ d.over.length }}</b>
          {{ d.over.length === 1 ? 'person' : 'people' }} over the
          {{ fmtUsd(d.softCapUsd, { whole: true }) }} soft cap
        </span>
      </div>

      <!-- The denominator, named. `rosterUsd` is NOT the burn headline above: this
           is the placed roster's own §A spend, wherever it was homed. -->
      <!-- The prototype's own line is "Soft cap is each teammate's base allowance,
           configured." The clause about their own usage page, and the explanation
           of how the burn's denominator differs from this one, were mechanism —
           what a reader needs is that this total is not the burn above. -->
      <p class="text-[11px] text-carbon-3 mt-1.5" data-testid="cc-osc-denominator">
        Soft cap is each teammate's base allowance, configured. Measured over
        <span class="font-semibold">{{ people(d.rosterCount) }} placed in this {{ BU_LABEL_LOWER }}</span>,
        whose own spend this period totals
        <span class="font-semibold tabular-nums">{{ fmtUsd(d.rosterUsd) }}</span> — not the burn
        above.
      </p>

      <div
        v-for="g in groups"
        :key="g.key"
        class="mt-5"
        :data-testid="`cc-osc-group-${g.key}`"
      >
        <div
          class="flex items-baseline gap-2.5 flex-wrap pl-2.5 border-l-[3px]"
          :style="{ borderColor: g.accent }"
        >
          <b class="text-[13.5px] text-carbon-1">{{ g.title }}</b>
          <span class="text-[11px] text-carbon-3">
            {{ people(g.rows.length) }} · {{ fmtUsd(groupUsd(g.rows)) }} · {{ g.sub }}
          </span>
          <span
            class="ml-auto text-[10.5px] font-semibold rounded-full px-2 py-0.5"
            :style="{ color: g.accent, background: `color-mix(in srgb, ${g.accent} 14%, transparent)` }"
            :data-testid="`cc-osc-pill-${g.key}`"
          >{{ g.pill }}</span>
        </div>

        <ul class="mt-2 space-y-1.5">
          <li
            v-for="r in g.rows"
            :key="r.teammateId"
            class="flex items-center gap-3 text-[12px]"
            data-testid="cc-osc-row"
          >
            <span class="shrink-0 w-[170px] truncate font-medium">
            <DrillName :target="targetFor(r)" :label="r.teammate" />
          </span>
            <span class="flex-1 min-w-[40px] h-2 rounded-full bg-calm-2/70 overflow-hidden">
              <i class="block h-full rounded-full" :style="{ width: barPct(r), background: g.accent }" />
            </span>
            <span class="shrink-0 w-[92px] text-right tabular-nums font-semibold text-carbon">
              {{ fmtUsd(r.unallocatedUsd) }}
            </span>
            <!-- `null` when the cap is $0: there is no multiple of zero to state. -->
            <span class="shrink-0 w-[70px] text-right text-carbon-2 tabular-nums">
              <template v-if="r.capMultiple != null"><b>{{ r.capMultiple.toFixed(1) }}×</b> cap</template>
              <template v-else>—</template>
            </span>
            <span class="shrink-0 w-[150px] text-carbon-3">
              <template v-if="r.projects > 0">
                {{ fmtPct(r.taggedRate) }} tagged · {{ r.projects }}
                {{ r.projects === 1 ? 'project' : 'projects' }}
              </template>
              <template v-else>on no project</template>
            </span>
          </li>
        </ul>
      </div>

      <p class="text-[11px] text-carbon-3 mt-4" data-testid="cc-osc-within">
        Within allowance: <b>{{ fmtUsd(d.withinAllowance.unallocatedUsd) }}</b> across
        {{ people(d.withinAllowance.teammates) }}, not shown.
        {{ d.withinAllowance.fullyAllocated }} fully allocated.
      </p>
    </template>

    <!-- ═══════════ Nobody is over the cap ═══════════
         A sentence, not a $0. The distinction matters: "$0" beside a card about
         unnoticed money reads as a failed fetch. -->
    <!--
      A VERDICT AND ITS EVIDENCE, not a 32-word sentence. This read "All within
      allowance. No one of the 24 people placed in this {{ BU_LABEL_LOWER }} is over the
      $100 soft cap this period. $53.22 is unallocated between them, under the
      cap." — three facts (nobody over, the cap, the unallocated total) the
      reader had to extract from prose. The sentence-not-a-$0 rule the old
      comment protected still holds: the verdict leads, and it is a WORD.
    -->
    <div
      v-else
      class="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px]"
      style="font-variant-numeric: tabular-nums"
      data-testid="cc-osc-all-within"
    >
      <span class="font-semibold text-rag-green">✓ All within allowance</span>
      <span class="text-carbon-3">{{ people(d.rosterCount) }} · cap
        {{ fmtUsd(d.softCapUsd, { whole: true }) }}</span>
      <span v-if="d.withinAllowance.unallocatedUsd > 0" class="text-carbon-2">
        <b class="text-carbon-1">{{ fmtUsd(d.withinAllowance.unallocatedUsd) }}</b> unallocated
      </span>
    </div>

    <!-- NO "nothing to action from here — this is who to talk to" NOTE. It told the
         reader how to interpret a list of names and defended the absence of a
         button. The card is a list of people and what they have left untagged;
         that is legible without being told what to do with it. -->

    <div v-if="showExport" class="flex justify-end mt-3">
      <ExportCsvButton
        endpoint="/api/v1/reports/export"
        :params="exportParams!"
        :filename="exportFilename!"
      />
    </div>
  </section>
</template>
