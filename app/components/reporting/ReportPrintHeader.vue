<script setup lang="ts">
/*
 * ReportPrintHeader — the one line a printed report carries (#583). Hidden on
 * screen; shown only in print. Facts come from the active view (print-facts.ts);
 * the time is the server clock's `now`, an instant, so it renders in the
 * viewer's zone. It is the server's time when the page loaded, and says so: a
 * figure fetched later (a changed window) was read after it, so "figures as
 * of" would overclaim. The browser's own clock is never consulted.
 */
import { computed } from 'vue'
import { LENS_WORD, printPeriod, settlingLine, type ReportPrintFacts } from './print-facts'

const props = defineProps<{
  facts: ReportPrintFacts | null
  /** The server clock's `now` (ISO instant), or null until it lands. */
  asOf: string | null
}>()

const asOfText = computed(() =>
  props.asOf
    ? new Date(props.asOf).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : null,
)
const settling = computed(() => (props.facts ? settlingLine(props.facts.settling) : ''))
</script>

<template>
  <div v-if="facts" class="hidden print:block mb-4 pb-2 border-b border-carbon-3 text-[11px] text-carbon" data-testid="report-print-header">
    <span class="font-bold">{{ facts.scope }}</span>
    · <span data-testid="report-print-period">{{ printPeriod(facts.from, facts.to) }}</span>
    · <span class="font-bold" data-testid="report-print-lens">{{ LENS_WORD[facts.lens] }}</span>
    <template v-if="settling"> · <span data-testid="report-print-settling">{{ settling }}</span></template>
     · <span data-testid="report-print-as-of">{{ asOfText ? `Page loaded ${asOfText}` : 'Page load time unavailable' }}</span>
  </div>
</template>
