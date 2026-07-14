<script setup lang="ts">
/*
 * EntityTable — shared chrome for the Teammates / Projects / Repos tabs.
 *
 * Toolbar: a WORKING client-side search (filters the passed rows) + a single
 * legible "+ Add" CTA that links to a real create page when `addTo` is set.
 * No dead/disabled stub buttons (the old "Upload CSV" + disabled "+ Add" read
 * as broken); when there is no create page, the parent passes guidance text via
 * the `addHint` slot instead of a dead button.
 */
import { ref, computed } from 'vue'
import UiCard from '../ui/Card.vue'
import UiButton from '../ui/Button.vue'
import UiEmptyState from '../ui/EmptyState.vue'

export interface EntityColumn<T> {
  key: keyof T | string
  label: string
  render?: (row: T) => string
}

const props = defineProps<{
  entityLabel: string
  rows: Record<string, unknown>[]
  columns: EntityColumn<Record<string, unknown>>[]
  total?: number
  // When set, the "+ Add" CTA links to a working create page (e.g. Projects →
  // /projects/new). When unset, no add button renders — pass an #addHint slot
  // explaining how that entity is created (e.g. teammates self-onboard).
  addTo?: string
}>()

const query = ref('')
const singular = computed(() => props.entityLabel.toLowerCase().replace(/s$/, ''))

function cellText(row: Record<string, unknown>, col: EntityColumn<Record<string, unknown>>): string {
  if (col.render) return col.render(row)
  const v = row[col.key as string]
  if (v === null || v === undefined) return '—'
  return String(v)
}

// Functional search: filter rows by any column's rendered text.
const filteredRows = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.rows
  return props.rows.filter((row) => props.columns.some((c) => cellText(row, c).toLowerCase().includes(q)))
})

// Whether the server returned a truncated window (more rows exist than were
// loaded). Search is client-side over the loaded window only, so when truncated
// the footer must say so — otherwise "X of {total}" reads as if all {total} rows
// were searched.
const truncated = computed(() => props.total != null && props.rows.length < props.total)
const searching = computed(() => query.value.trim().length > 0)
const footerNote = computed(() => {
  if (props.total == null) return null
  const lbl = props.entityLabel.toLowerCase()
  if (searching.value && truncated.value)
    return `${filteredRows.value.length} match in the first ${props.rows.length} of ${props.total} ${lbl} — refine on the server to search the rest.`
  if (searching.value) return `${filteredRows.value.length} of ${props.total} ${lbl} match.`
  if (truncated.value) return `Showing the first ${props.rows.length} of ${props.total} ${lbl}.`
  return null
})
</script>

<template>
  <UiCard flush :data-testid="`entity-table-${entityLabel.toLowerCase()}`">
    <div class="px-5 pt-5 pb-3 flex flex-wrap items-center gap-3">
      <input
        v-model="query"
        type="search"
        :placeholder="`Search ${entityLabel.toLowerCase()}…`"
        class="flex-1 min-w-[200px] px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
        :data-testid="`entity-search-${entityLabel.toLowerCase()}`"
      >
      <UiButton
        v-if="addTo"
        kind="primary"
        size="sm"
        :to="addTo"
        :data-testid="`entity-add-${entityLabel.toLowerCase()}`"
      >
        + Add {{ singular }}
      </UiButton>
      <span v-else class="text-xs text-carbon-3"><slot name="addHint" /></span>
    </div>
    <div v-if="rows.length === 0" class="border-t border-calm-2">
      <UiEmptyState
        :headline="`No ${entityLabel.toLowerCase()} yet`"
        :sub="`This region has no ${entityLabel.toLowerCase()} on file.`"
      />
    </div>
    <div v-else-if="filteredRows.length === 0" class="border-t border-calm-2 px-5 py-8 text-center text-sm text-carbon-3">
      No {{ entityLabel.toLowerCase() }} match “{{ query }}”.
      <span v-if="truncated" class="block text-[11px] mt-1">Only the first {{ rows.length }} of {{ total }} were searched — refine on the server for the rest.</span>
    </div>
    <div v-else class="overflow-x-auto border-t border-calm-2">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-brand-harmony-sheer/40 border-b border-calm-2">
            <th
              v-for="c in columns"
              :key="String(c.key)"
              class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3"
            >
              {{ c.label }}
            </th>
            <th v-if="$slots.rowActions" class="px-5 py-3"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-calm-2">
          <tr v-for="(row, idx) in filteredRows" :key="idx" class="hover:bg-brand-harmony-sheer/30">
            <td v-for="c in columns" :key="String(c.key)" class="px-5 py-3 text-sm text-carbon">
              {{ cellText(row, c) }}
            </td>
            <td v-if="$slots.rowActions" class="px-5 py-3 text-right whitespace-nowrap">
              <slot name="rowActions" :row="row" />
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="footerNote" class="px-5 py-3 text-xs text-carbon-3 border-t border-calm-2">
        {{ footerNote }}
      </div>
    </div>
  </UiCard>
</template>
