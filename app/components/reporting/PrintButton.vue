<script setup lang="ts">
/*
 * PrintButton — beside Export CSV (#583). Opens the browser's print dialog;
 * the print stylesheet (main.css) drops the app chrome and controls and the
 * page's ReportPrintHeader states what the figures are.
 */
import UiButton from '../ui/Button.vue'

// A click handler only ever runs in the browser; the guard keeps it safe to
// call anywhere else.
function print() {
  if (typeof window !== 'undefined' && typeof window.print === 'function') window.print()
}
</script>

<template>
  <UiButton kind="secondary" size="sm" class="print:hidden" data-testid="print-button" title="Print this report" @click="print">
    Print
  </UiButton>
</template>
