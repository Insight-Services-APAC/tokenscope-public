<script setup lang="ts">
/*
 * TopupLog — append-only top-up log + inline "Add top-up" form
 * (per design-notes §Screen 4).
 *
 * The list is read-only — top-ups never edit or delete (the
 * underlying allocation row is immutable once written). The inline
 * form reveals on click; submit emits `add` with the form payload.
 */
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import UiButton from '../ui/Button.vue'
import { fmtInstant, fmtUsd } from '../../composables/useFormat'
import { budgetPeriodWords } from '#shared/budgets/period-words'

export interface TopupRow {
  id: string
  budget_usd: string
  effective: string
  created_at: string | null
  actor_display_name: string | null
  reason: string | null
  /* #633: the period, parsed by the server; the browser never reads the range text. */
  effective_from?: string | null
  effective_to?: string | null
}

const props = withDefaults(
  defineProps<{
    topups: TopupRow[]
    /*
     * Inbox-driven deep-link: when an over-budget alert's "Add top-up"
     * action navigates here with ?focus=topup, the allocator page
     * forwards `initiallyExpanded=true` so the form opens immediately
     * + the amount input gets focus + the section scrolls into view.
     */
    initiallyExpanded?: boolean
    /*
     * FE-6: the parent owns the POST. While `submitting` is true the form is
     * locked; when it flips back to false the form resets + collapses ONLY if
     * `submitError` is null — a rejected POST keeps the user's input visible
     * alongside the error.
     */
    submitting?: boolean
    submitError?: string | null
  }>(),
  { initiallyExpanded: false, submitting: false, submitError: null },
)

const emit = defineEmits<{
  add: [{ budget_usd: string; effective_from: string; effective_to: string; reason: string }]
}>()

const expanded = ref(props.initiallyExpanded)
const sectionRef = ref<HTMLElement | null>(null)

/*
 * Used when ?focus=topup is in the URL: once the form is on screen, scroll the
 * section into view and focus the amount input. The form waits for the server
 * clock (#633), so this runs when the form first renders, whether the clock was
 * ready at mount or arrives later (Copilot, PR 639).
 */
let deepLinkFocused = false
function focusDeepLink() {
  if (!props.initiallyExpanded || deepLinkFocused || !serverToday.value || !expanded.value) return
  void nextTick(() => {
    // This component's own input, and the flag only once it is focused, so a
    // cancel while the clock was pending cannot spend the deep link.
    const amount = sectionRef.value?.querySelector<HTMLInputElement>('[data-testid="topup-amount"]')
    if (!amount) return
    deepLinkFocused = true
    sectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    amount.focus()
  })
}
onMounted(focusDeepLink)
watch(expanded, focusDeepLink)
/*
 * #633: the default period is the SERVER's current UTC month (first day to the
 * first day of the next), never the browser's clock (CLAUDE.md "The clock").
 * The form opens only once the clock has answered; until then it says so.
 */
const { today: serverToday, error: clockError, refresh: refreshClock } = useServerClock()
function defaultFromIso(): string {
  const t = serverToday.value
  return t ? `${t.slice(0, 7)}-01` : ''
}
function defaultToIso(): string {
  const t = serverToday.value
  if (!t) return ''
  const y = Number(t.slice(0, 4))
  const m = Number(t.slice(5, 7))
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}
const form = ref({
  budget_usd: '',
  effective_from: defaultFromIso(),
  effective_to: defaultToIso(),
  reason: '',
})
// Fill the defaults when the clock answers, unless the person already chose dates.
watch(serverToday, () => {
  if (!form.value.effective_from) form.value.effective_from = defaultFromIso()
  if (!form.value.effective_to) form.value.effective_to = defaultToIso()
  focusDeepLink()
})

const canSubmit = computed(() => {
  return (
    /^\d+(\.\d{1,2})?$/.test(form.value.budget_usd) &&
    Number(form.value.budget_usd) > 0 &&
    form.value.effective_from &&
    form.value.effective_to &&
    form.value.effective_from < form.value.effective_to
  )
})

function submit() {
  if (!canSubmit.value || props.submitting) return
  emit('add', { ...form.value })
}

// Reset + collapse only after the parent signals success (FE-6): submitting
// flipped true→false with no error. On failure the input stays put so the
// user can fix and retry.
watch(
  () => props.submitting,
  (now, was) => {
    if (!was || now || props.submitError) return
    form.value = {
      budget_usd: '',
      effective_from: defaultFromIso(),
      effective_to: defaultToIso(),
      reason: '',
    }
    expanded.value = false
  },
)

/* The top-up's period in UTC days: "1 to 31 Oct 2026". Absent bounds (an older server) show nothing. */
function periodWords(t: TopupRow): string | null {
  return t.effective_from || t.effective_to ? budgetPeriodWords(t.effective_from, t.effective_to) : null
}
</script>

<template>
  <section ref="sectionRef" data-testid="topup-log">
    <header class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-carbon">Top-ups</div>
      <UiButton
        kind="secondary"
        size="sm"
        data-testid="topup-toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? '× Cancel' : '+ Add top-up' }}
      </UiButton>
    </header>

    <!-- The clock read failed: say so and offer a retry; the form stays
         hidden until the server has answered (Copilot, PR 639). -->
    <div
      v-if="expanded && !serverToday && clockError"
      class="border border-brand-hunger/40 bg-brand-hunger-sheer rounded-lg p-4 mb-3 text-xs text-brand-heart flex items-center justify-between gap-3"
      role="alert"
      data-testid="topup-clock-error"
    >
      <span>We couldn't get the current month from the server, so the top-up form can't open yet.</span>
      <UiButton kind="secondary" size="sm" type="button" data-testid="topup-clock-retry" @click="refreshClock()">
        Try again
      </UiButton>
    </div>
    <div
      v-else-if="expanded && !serverToday"
      class="border border-calm-2 rounded-lg p-4 mb-3 text-xs text-carbon-3"
      role="status"
      data-testid="topup-form-waiting"
    >
      Getting the current month from the server…
    </div>
    <form
      v-else-if="expanded"
      class="border border-calm-2 rounded-lg p-4 mb-3 bg-brand-harmony-sheer/40 space-y-3"
      data-testid="topup-form"
      @submit.prevent="submit"
    >
      <div class="grid grid-cols-3 gap-3">
        <label class="text-xs">
          <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Amount (USD)</span>
          <input
            v-model="form.budget_usd"
            type="text"
            inputmode="decimal"
            placeholder="500.00"
            class="w-full px-2.5 py-1.5 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
            data-testid="topup-amount"
          >
        </label>
        <label class="text-xs">
          <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">From</span>
          <input
            v-model="form.effective_from"
            type="date"
            class="w-full px-2.5 py-1.5 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
            data-testid="topup-from"
          >
        </label>
        <label class="text-xs">
          <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Until (UTC, not included)</span>
          <input
            v-model="form.effective_to"
            type="date"
            class="w-full px-2.5 py-1.5 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
            data-testid="topup-to"
          >
        </label>
      </div>
      <label class="text-xs block">
        <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Reason (optional)</span>
        <input
          v-model="form.reason"
          type="text"
          placeholder="Q2 scope extension, embeddings POC, …"
          maxlength="500"
          class="w-full px-2.5 py-1.5 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
          data-testid="topup-reason"
        >
      </label>
      <div
        v-if="submitError"
        class="px-3 py-2 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-xs text-brand-heart"
        data-testid="topup-error"
        role="alert"
      >
        Top-up failed: {{ submitError }}
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <UiButton kind="ghost" size="sm" type="button" @click="expanded = false">Cancel</UiButton>
        <UiButton
          kind="primary"
          size="sm"
          type="submit"
          :disabled="!canSubmit || submitting"
          data-testid="topup-submit"
        >
          {{ submitting ? 'Adding…' : 'Add' }}
        </UiButton>
      </div>
    </form>

    <ul v-if="topups.length > 0" class="border border-calm-2 rounded-lg overflow-hidden" data-testid="topup-list">
      <li
        v-for="t in topups"
        :key="t.id"
        class="grid grid-cols-[150px_1fr_100px] items-center gap-3 px-4 py-3 border-b border-calm-2 last:border-b-0 bg-white"
      >
        <span class="text-xs text-carbon-2" data-testid="topup-period">{{ periodWords(t) ?? '—' }}</span>
        <div class="text-sm text-carbon">
          {{ t.reason ?? '—' }}
          <div class="text-[11px] text-carbon-3">
            Added by {{ t.actor_display_name ?? 'system' }}<template v-if="t.created_at">, {{ fmtInstant(t.created_at) }}</template>
          </div>
        </div>
        <span class="text-right text-sm font-bold text-rag-green" style="font-variant-numeric: tabular-nums">
          +{{ fmtUsd(t.budget_usd) }}
        </span>
      </li>
    </ul>
    <div v-else class="text-xs text-carbon-3 italic">
      No top-ups yet. Add one if the project needs more headroom this period.
    </div>
  </section>
</template>
