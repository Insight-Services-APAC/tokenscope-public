<script setup lang="ts">
/*
 * ReportBand — a labelled group of cards that all answer over ONE window
 * (docs/design/reporting-consolidation/prototype.html, the `.band` / `.bh` shell).
 *
 * WHAT IT FIXES. The reporting page carries figures over two different windows:
 * the selected PERIOD (month-to-date or a custom range) and a decoupled ROLLING
 * window the trend cards use. Nothing on screen said so, so a $409.00 60-day
 * donut sat directly under a $12,855.00 month-to-date headline and the page
 * contradicted itself. Every attempted repair was per-card — a paragraph under
 * each visual explaining why its number differed from the one above it — which
 * is the "a chart that needs a paragraph is broken" defect one card at a time.
 *
 * The window is stated ONCE for the whole group. That is the only reason the
 * cards inside may stop restating it: a reader who has crossed that statement
 * knows which window they are in, so a card's own caption can go back to naming
 * one thing.
 *
 * WHERE THE STATEMENT LIVES IS THE CALLER'S CHOICE, and the period band does not
 * use this header. Its hero already opens with the whole sentence — "August 2026
 * · $5,741.89 · attributed usage · the whole company · month to date · day 3 of
 * 31" — so a header above it repeated the month, the lane and the scope one line
 * earlier and added only a second thing to keep in step. ONE line, and it is the
 * one carrying the figure. The rolling band DOES pass a header, because it says
 * something no card inside it says ("does not sum into August").
 *
 * So `windowLabel` is OPTIONAL: omit it and the band is a pure grouping element,
 * keeping its `data-testid` (membership is asserted through it) and its card
 * rhythm, with no chrome of its own.
 *
 * IT MAKES NO CLAIM OF ITS OWN. Every string is passed in by the scope view that
 * knows which window it fetched — this component computes nothing, sums nothing
 * and holds no figure. In particular it deliberately does NOT re-state a money
 * total: the hero inside the period band already publishes that, and one fact
 * gets one home.
 */
defineProps<{
  /**
   * The window every card in this band is measured over, in the reader's words —
   * "July 2026", "Last 60 days", "2026-06-01 → 2026-06-30". Never a grain.
   *
   * OMITTED ⇒ no header at all. The caller is then asserting that something else
   * on screen (the period band's hero) already states this band's window; the
   * component cannot check that, which is why the decision is the caller's and
   * is documented at both call sites.
   */
  windowLabel?: string
  /**
   * What the figures inside ARE: lane, scope and grain, e.g.
   * "attributed usage · the whole company · month to date" or "rolling · daily".
   */
  basis?: string
  /**
   * A caveat about how this band relates to the OTHER one — the rolling band's
   * "does not sum into July". Rendered only when the caller passes it, because
   * when the two bands share a window (a custom range) the sentence would be
   * false.
   */
  note?: string
}>()
</script>

<template>
  <section class="space-y-5">
    <div
      v-if="windowLabel"
      class="flex items-baseline gap-x-3 gap-y-1 flex-wrap pb-2 border-b-2 border-calm"
    >
      <span
        class="text-[17px] font-extrabold tracking-[-0.2px] text-carbon"
        data-testid="report-band-window"
      >{{ windowLabel }}</span>
      <span
        v-if="basis"
        class="text-[12.5px] text-carbon-2"
        data-testid="report-band-basis"
      >{{ basis }}</span>
      <span
        v-if="note"
        class="ml-auto text-[11.5px] text-carbon-3"
        data-testid="report-band-note"
      >{{ note }}</span>
    </div>

    <div class="space-y-6">
      <slot />
    </div>
  </section>
</template>
