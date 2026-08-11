<script setup lang="ts">
/*
 * BulkPlaceDialog — pick one Business Unit, place the selected teammates into it.
 * POST /api/v1/admin/users/bulk-place.
 *
 * WHAT IT MUST NOT DO IS HIDE A PARTIAL FAILURE. The endpoint returns per-id
 * outcomes precisely so one bad id cannot discard 39 good placements, and a
 * dialog that collapses that into "done" throws the distinction away. So a
 * response with any refusal keeps the dialog OPEN and lists what was refused,
 * with the server's own sentence per row. A clean run closes and hands the
 * parent a summary for the toast.
 *
 * STAYING OPEN IS NOT THE SAME AS NOTHING HAVING HAPPENED. The 38 that succeeded
 * are COMMITTED, so the dialog emits `partial` and the parent refreshes: without
 * it, the placed rows sit on screen as unplaced behind the dialog and the region
 * counts disagree with the database until something else reloads them. The same
 * event carries the FAILED ids, which become the new selection — a retry that
 * resubmits the 38 that already worked earns 38 no-ops, and the button would
 * offer to "Place 40" when there are two left to place.
 *
 * The picker offers only cost-owning units — the server refuses anything else
 * (422), and offering a destination the write will reject teaches an admin the
 * feature is broken.
 */
import { computed, ref, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'
import { BU_LABEL } from '#shared/reports/vocabulary'

interface TargetUnit {
  id: string
  code: string
  display_name: string
  depth: number
}

interface PlaceResult {
  teammate_id: string
  /**
   * 'noop' = already in that Business Unit; nothing was written for them.
   * 'history-repaired' = already there, and their stranded history moved.
   */
  status: 'placed' | 'noop' | 'history-repaired' | 'failed'
  reason?: string
}

const props = defineProps<{
  open: boolean
  teammateIds: string[]
  targets: TargetUnit[]
  /** id → label, so a refusal names the person rather than a uuid. */
  labelFor: (teammateId: string) => string
}>()
const emit = defineEmits<{
  close: []
  /*
   * `placedIds` is what makes C5's rule offer possible: the offer must be built
   * from the teammates whose placement actually COMMITTED, not from the selection
   * (which can contain refusals) and not from a count (which names nobody).
   */
  placed: [
    summary: {
      placed: number
      noop: number
      historyRepaired: number
      unitName: string
      unitId: string
      placedIds: string[]
    },
  ]
  /*
   * Some placed, some refused. The dialog stays open on this one — the parent's
   * job is to make the rest of the page agree with what DID commit, and to hand
   * the selection back as just the ids still to place.
   */
  partial: [summary: { placed: number; noop: number; failed: number; unitName: string; failedIds: string[] }]
}>()

const targetId = ref('')
/*
 * MOVE WHAT THEY ALREADY SPENT, TOO.
 *
 * The server has accepted `rehome` on this door since the correction shipped,
 * and this dialog never sent it — so the bulk workflow, which is the ONE that
 * matters when finance finds hundreds of people mis-placed, still left every
 * dollar of history behind.
 *
 * No per-person span preview here, deliberately: N previews is N round trips
 * and a wall of figures nobody reads. The single-teammate door on the users
 * table is where you check one person's history before moving it; this door
 * states the effect plainly and applies it to each person in the batch.
 */
const moveHistory = ref(false)
/*
 * The server refuses a history batch above this (BULK_REHOME_MAX): six tables
 * per teammate in one transaction is a far bigger write than a placement, and
 * an oversized one outlives the browser's patience while still committing.
 * Offering a checkbox that will 400 teaches an admin the feature is broken.
 */
const REHOME_MAX = 50
const tooManyForHistory = computed(() => props.teammateIds.length > REHOME_MAX)
const saving = ref(false)
const error = ref<string | null>(null)
const failures = ref<PlaceResult[]>([])

const targetName = computed(
  () => props.targets.find((t) => t.id === targetId.value)?.display_name ?? 'that Business Unit',
)

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    targetId.value = ''
    // Every open starts from "placement only" — a remembered checkbox would
    // restate a second batch's history on one click.
    moveHistory.value = false
    error.value = null
    failures.value = []
  },
  { immediate: true },
)

async function submit() {
  if (!targetId.value || !props.teammateIds.length) return
  saving.value = true
  error.value = null
  failures.value = []
  try {
    const res = await $fetch<{
      placed: number
      noop: number
      historyRepaired?: number
      failed: number
      results: PlaceResult[]
    }>(
      '/api/v1/admin/users/bulk-place',
      {
        method: 'POST',
        body: {
          teammate_ids: props.teammateIds,
          org_unit_id: targetId.value,
          // Absent unless asked for: the sync path's behaviour is the default.
          ...(moveHistory.value ? { rehome: { from: 'all' } } : {}),
        },
      },
    )
    const noop = res.noop ?? 0
    if (res.failed > 0) {
      // Stay open. The good placements ARE committed — say so, and name what
      // was not, rather than implying the whole batch failed or the whole
      // batch worked.
      failures.value = res.results.filter((r) => r.status === 'failed')
      error.value = `${res.placed} placed${noop ? `, ${noop} already there` : ''}, ${res.failed} refused. The placements below did not happen; everything else did.`
      // The parent owns the page behind this dialog and the selection: tell it
      // what committed, and hand back exactly the ids still to place.
      emit('partial', {
        placed: res.placed,
        noop,
        failed: res.failed,
        unitName: targetName.value,
        failedIds: failures.value.map((f) => f.teammate_id),
      })
      return
    }
    emit('placed', {
      placed: res.placed,
      noop,
      // Reported separately in the toast: on the estate this exists to fix,
      // most of a batch can be repairs rather than moves, and calling those
      // "placed" would claim placements that did not happen.
      historyRepaired: res.historyRepaired ?? 0,
      unitName: targetName.value,
      unitId: targetId.value,
      placedIds: res.results.filter((r) => r.status === 'placed').map((r) => r.teammate_id),
    })
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Placement failed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="bulk-place-overlay"
    @click.self="emit('close')"
  >
    <div
      class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-place-title"
      data-testid="bulk-place-dialog"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Place teammates</p>
          <h2 id="bulk-place-title" class="text-lg font-bold text-carbon mt-0.5">
            {{ teammateIds.length }} {{ teammateIds.length === 1 ? 'teammate' : 'teammates' }}
          </h2>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="bulk-place-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <label for="bulk-place-target" class="text-[12px] font-semibold text-carbon">Business Unit</label>
        <select
          id="bulk-place-target"
          v-model="targetId"
          class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
          data-testid="bulk-place-target"
        >
          <option value="">Choose a Business Unit…</option>
          <option v-for="t in targets" :key="t.id" :value="t.id">
            {{ '— '.repeat(Math.max(0, t.depth - 1)) }}{{ t.display_name }} ({{ t.code }})
          </option>
        </select>
        <p class="text-[11px] text-carbon-3 mt-1">
          Only cost-owning units are listed. Their spend then rolls up to this
          unit's P&amp;L instead of stopping at the region.
        </p>

        <div class="mt-3 rounded-lg border border-rag-amber/40 bg-rag-amber/5 px-3 py-2.5">
          <p class="text-[12px] text-carbon">
            <strong>Usage already recorded stays where it is.</strong>
            Usage is stamped with its {{ BU_LABEL }} when it is recorded, so this
            applies to future usage only.
          </p>
          <p v-if="tooManyForHistory" class="mt-2 text-[11px] text-carbon-2" data-testid="bulk-place-history-capped">
            Bringing the recorded usage across is limited to {{ REHOME_MAX }} teammates
            at a time. Place these {{ teammateIds.length }} now, then move the history
            in smaller batches.
          </p>
          <label
            v-else
            class="mt-2 flex items-start gap-2 text-[12px] text-carbon cursor-pointer"
          >
            <input
              v-model="moveHistory"
              type="checkbox"
              class="mt-0.5 rounded border-calm-2"
              data-testid="bulk-place-move-history"
            >
            <span>
              Also move everything these {{ teammateIds.length }} already recorded.
              <span class="text-carbon-3">
                Restates reported usage, and repairs anyone already in this
                {{ BU_LABEL }} whose history was left behind by an earlier move.
              </span>
            </span>
          </label>
        </div>

        <p v-if="!targets.length" class="text-xs text-rag-amber mt-3" data-testid="bulk-place-no-targets">
          This region has no cost-owning units yet — create one on the Business Units
          tab first, otherwise there is nowhere for this spend to land.
        </p>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="bulk-place-error" role="alert">{{ error }}</p>
        <ul
          v-if="failures.length"
          class="mt-2 border border-calm-2 rounded-md divide-y divide-calm-2 max-h-52 overflow-y-auto"
          data-testid="bulk-place-failures"
        >
          <li v-for="f in failures" :key="f.teammate_id" class="px-3 py-2">
            <div class="text-sm text-carbon truncate">{{ labelFor(f.teammate_id) }}</div>
            <div class="text-[11px] text-carbon-3">{{ f.reason }}</div>
          </li>
        </ul>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="bulk-place-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton
            kind="primary"
            :disabled="saving || !targetId || !teammateIds.length"
            data-testid="bulk-place-submit"
            @click="submit"
          >
            {{ saving ? 'Placing…' : `Place ${teammateIds.length}` }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
