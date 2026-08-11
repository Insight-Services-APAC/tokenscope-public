<script setup lang="ts">
/*
 * PlaceTeammateDialog — confirm a person's move, and decide whether the usage
 * they have already recorded moves with them.
 *
 * ── WHY A CONFIRMATION AT ALL ────────────────────────────────────────────────
 * The Business Unit picker on the users table used to apply on `change`. That is
 * fine for a placement that only affects the future, and wrong the moment the
 * same control can restate months of reported usage: a stray keystroke on a
 * focused select would re-home somebody's entire history with no way to see it
 * coming. The move itself still needs no ceremony — the ceremony is for the
 * money.
 *
 * ── WHY THE HISTORY OPTION IS OFFERED HERE AND NOWHERE ELSE ──────────────────
 * Directory sync never moves history: a person who genuinely changed team must
 * not hand February's consumption to March's Business Unit. An admin doing this
 * by hand is almost always correcting a mis-placement, so the record was always
 * wrong and history should follow. The system cannot tell those apart from the
 * data — but it knows which of the two is happening, because it knows who is
 * asking.
 *
 * ── THE SPAN WARNING ─────────────────────────────────────────────────────────
 * If this person's recorded usage already sits under several Business Units,
 * moving "everything recorded" collapses that history onto one. That is right
 * for a correction and wrong for somebody who really did move teams once, and
 * only the operator knows which. So the preview names the Business Units and
 * what each holds, and says nothing about which answer is correct.
 *
 * Deliberately the same shape as ProjectEditDialog's Migrate: same checkbox,
 * same blank-means-everything date, same "check before you apply" discipline.
 * Two controls that restate reported usage should not behave differently.
 */
import { ref, computed, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { apiErrorDetail } from '../../composables/useApiError'
import { BU_LABEL, BU_LABEL_PLURAL } from '#shared/reports/vocabulary'

interface SpanSource {
  orgUnitId: string | null
  displayName: string | null
  usd: number
  firstDay: string
  lastDay: string
}
interface PlacementSpan {
  sources: SpanSource[]
  usd: number
  spansMultipleUnits: boolean
}

const props = defineProps<{
  open: boolean
  teammateId: string
  /** What to call the person — their email; a uuid names nobody. */
  teammateLabel: string
  toUnitId: string
  toUnitName: string
}>()

const emit = defineEmits<{
  cancel: []
  /** `rehome` absent = placement only, which is the sync path's behaviour. */
  confirm: [payload: { rehome?: { from: string } }]
}>()

const moveHistory = ref(false)
/** Blank = everything recorded. Mirrors Migrate's From field exactly. */
const from = ref('')
const span = ref<PlacementSpan | null>(null)
const checking = ref(false)
const error = ref<string | null>(null)

const dialogRef = ref<HTMLElement | null>(null)
useModalA11y({
  isOpen: () => props.open,
  dialogEl: dialogRef,
  onClose: () => emit('cancel'),
  onOpen: () => {
    // Every open starts from "placement only". A checkbox that remembered its
    // last state would restate a second person's history on a single click.
    moveHistory.value = false
    from.value = ''
    span.value = null
    error.value = null
  },
})

function range() {
  return from.value ? { from: from.value } : { from: 'all' as const }
}

/*
 * A span describes ONE proposed range. Change the range and it is stale, so
 * drop it rather than let a stale figure justify a different move.
 */
watch([from, moveHistory], () => {
  span.value = null
  error.value = null
})

async function check() {
  checking.value = true
  error.value = null
  span.value = null
  try {
    span.value = await $fetch<PlacementSpan>(
      `/api/v1/admin/users/${props.teammateId}/placement-span`,
      { method: 'POST', body: { range: range() } },
    )
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Could not work out what would move')
  } finally {
    checking.value = false
  }
}

/** Applying without checking would defeat the point of checking. */
const ready = computed(() => !moveHistory.value || !!span.value)

/*
 * The Business Units the history spans, EXCLUDING the destination — history
 * already on the target is not being collapsed into anything, and listing it
 * would inflate the warning that is supposed to make the operator stop.
 */
const collapsing = computed(
  () => span.value?.sources.filter((s) => s.orgUnitId !== props.toUnitId) ?? [],
)

/*
 * WHAT WOULD ACTUALLY MOVE — the sources MINUS the destination.
 *
 * `span.usd` is the person's whole recorded history, which is the right input
 * for the span warning and the wrong number for the headline: the write skips
 * rows already on the target, so a person with $100 under the old BU and $900
 * already under the new one would be told "$1,000 would move" when $100 will.
 */
const movingUsd = computed(() => collapsing.value.reduce((a, s) => a + s.usd, 0))

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

function confirm() {
  emit('confirm', moveHistory.value ? { rehome: range() } : {})
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="place-teammate-overlay"
    @click.self="emit('cancel')"
  >
    <div
      ref="dialogRef"
      class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="place-teammate-title"
      data-testid="place-teammate-dialog"
    >
      <div class="px-6 py-4 border-b border-calm-2">
        <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Move teammate</p>
        <h2 id="place-teammate-title" class="text-lg font-bold text-carbon mt-0.5">
          {{ teammateLabel }} → {{ toUnitName }}
        </h2>
      </div>

      <div class="px-6 py-4">
        <div class="rounded-lg border border-rag-amber/40 bg-rag-amber/5 px-3 py-2.5">
          <p class="text-[12px] text-carbon">
            <strong>Usage already recorded stays on the old {{ BU_LABEL }}.</strong>
            Usage is stamped with its {{ BU_LABEL }} when it is recorded, so this
            move applies to future usage only.
          </p>

          <label class="mt-2.5 flex items-start gap-2 text-[12px] text-carbon cursor-pointer">
            <input
              v-model="moveHistory"
              type="checkbox"
              class="mt-0.5 rounded border-calm-2"
              data-testid="pt-move-history"
            >
            <span>Also move the usage already recorded for this person</span>
          </label>

          <div v-if="moveHistory" class="mt-2 pl-6">
            <label for="pt-from" class="text-[11px] font-semibold text-carbon-2">From</label>
            <input
              id="pt-from"
              v-model="from"
              type="date"
              class="ml-2 px-2 py-1 text-[12px] border border-calm-2 rounded-md"
              data-testid="pt-from"
            >
            <span class="ml-2 text-[11px] text-carbon-3">blank = everything recorded</span>

            <div class="mt-2">
              <UiButton kind="secondary" size="sm" :disabled="checking" data-testid="pt-check" @click="check">
                {{ checking ? 'Checking…' : 'Check what would move' }}
              </UiButton>
            </div>

            <p v-if="error" class="mt-2 text-[11px] text-rag-red" role="alert" data-testid="pt-error">
              {{ error }}
            </p>

            <div v-if="span" class="mt-2 text-[11px] text-carbon" data-testid="pt-span">
              <p v-if="movingUsd > 0" class="font-semibold" :data-usd="movingUsd.toFixed(2)">
                {{ money(movingUsd) }} of recorded usage would move to {{ toUnitName }}.
              </p>
              <p v-else-if="span.usd > 0" class="text-carbon-3">
                All {{ money(span.usd) }} of recorded usage in that range is already on
                {{ toUnitName }} — nothing left to move.
              </p>
              <p v-else class="text-carbon-3">
                Nothing recorded in that range — the move applies to future usage only.
              </p>

              <!--
                The warning that earns the whole preview: several Business Units'
                worth of history about to become one. Named, with what each holds,
                because "spans 3" is not something an operator can act on.
              -->
              <div v-if="collapsing.length > 1" class="mt-2" data-testid="pt-span-warning">
                <p class="font-semibold text-rag-amber">
                  This usage currently sits under {{ collapsing.length }} {{ BU_LABEL_PLURAL }}.
                </p>
                <ul class="mt-1 text-carbon-2">
                  <li v-for="s in collapsing" :key="s.orgUnitId ?? 'unplaced'">
                    {{ s.displayName ?? 'Unplaced' }} — {{ money(s.usd) }}
                    <span class="text-carbon-3">({{ s.firstDay }} to {{ s.lastDay }})</span>
                  </li>
                </ul>
                <p class="mt-1 text-carbon-3">
                  Moving all of it treats that history as a mistake. If they really
                  did change team, set a From date instead.
                </p>
              </div>

              <p class="mt-1 text-carbon-3">
                This restates reported usage. Anyone reconciling the old
                {{ BU_LABEL }} will see it change, and other people's open reports
                can take up to a minute to catch up.
              </p>
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="pt-cancel" @click="emit('cancel')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="!ready" data-testid="pt-confirm" @click="confirm">
            Move {{ moveHistory ? 'and restate' : '' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
