<script setup lang="ts">
/*
 * ExportCsvButton — real, month-bounded CSV download (owner-decisions D-Q8).
 *
 * The label is "Export CSV" — NOT "Excel" (the Excel/scheduled pack is a
 * deferred fast-follow; mislabelling this as Excel was the exact confusion the
 * decision kills). The caller supplies a real month-bounded `filename`; the
 * download honours it via the anchor `download` attribute. Reuses UiButton for
 * styling.
 */
import UiButton from '../ui/Button.vue'
import { buildExportUrl, type ExportParams } from './export-url'

const props = defineProps<{
  /** The export API path, e.g. "/api/v1/reports/export". */
  endpoint: string
  /** Query params (scope, report, month, scope filters). */
  params: ExportParams
  /** Month-bounded download name, e.g. "tokenscope-finance-2026-05.csv". */
  filename: string
}>()

function download() {
  if (!import.meta.client) return
  const url = buildExportUrl(props.endpoint, props.params)
  const a = document.createElement('a')
  a.href = url
  a.download = props.filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
</script>

<template>
  <UiButton
    kind="secondary"
    size="sm"
    data-testid="export-csv-button"
    :title="`Download ${filename}`"
    @click="download"
  >
    Export CSV
  </UiButton>
</template>
