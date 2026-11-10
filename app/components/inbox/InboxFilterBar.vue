<script setup lang="ts">
/*
 * InboxFilterBar: Category / Severity / Status, in its own card above the
 * list (design-notes §Screen 7).
 *
 * Category is one of six groups people recognise (#546), not a category key:
 * every category the server writes sits in exactly one group
 * (shared/inbox/categories.ts), so nothing is unfilterable. Status opens on
 * Open (unread, read, acknowledged); Closed is resolved and dismissed, the
 * list route's `open` / `closed` shorthands.
 *
 * Each row of buttons is a labelled group and every button carries
 * aria-pressed, like the app's other toggles (WindowToggle, RegionSelector).
 */
import UiCard from '../ui/Card.vue'
import { INBOX_CATEGORY_GROUPS, INBOX_GROUP_LABELS, type InboxCategoryGroup } from '#shared/inbox/categories'

export type InboxCategoryFilter = 'all' | InboxCategoryGroup

export type InboxSeverityFilter = 'all' | 'info' | 'attention' | 'urgent'

export type InboxStatusFilter = 'open' | 'unread' | 'closed' | 'all'

const CATEGORY_OPTIONS: Array<{ key: InboxCategoryFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...INBOX_CATEGORY_GROUPS.map((g) => ({ key: g, label: INBOX_GROUP_LABELS[g] })),
]

const SEVERITY_OPTIONS: Array<{ key: InboxSeverityFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'info', label: 'Info' },
  { key: 'attention', label: 'Attention' },
  { key: 'urgent', label: 'Urgent' },
]

const STATUS_OPTIONS: Array<{ key: InboxStatusFilter; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'unread', label: 'Unread' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
]

defineProps<{
  category: InboxCategoryFilter
  severity: InboxSeverityFilter
  status: InboxStatusFilter
  /** Items per group under the current status and severity; absent until loaded. */
  groupCounts?: Partial<Record<InboxCategoryGroup, number>> | null
}>()

const emit = defineEmits<{
  (e: 'update:category', value: InboxCategoryFilter): void
  (e: 'update:severity', value: InboxSeverityFilter): void
  (e: 'update:status', value: InboxStatusFilter): void
}>()

const BUTTON = 'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap'
const ON = 'bg-white text-brand-harmony shadow-sm'
const OFF = 'text-carbon-2 hover:text-brand-harmony'
</script>

<template>
  <UiCard class="mb-5" data-testid="inbox-filter-bar">
    <div class="flex flex-wrap items-start gap-x-10 gap-y-4">
      <div>
        <div id="inbox-filter-category-label" class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
          Category
        </div>
        <div role="group" aria-labelledby="inbox-filter-category-label" class="inline-flex flex-wrap p-0.5 bg-calm-2 rounded-lg gap-0.5">
          <button
            v-for="opt in CATEGORY_OPTIONS"
            :key="opt.key"
            type="button"
            :class="[BUTTON, category === opt.key ? ON : OFF]"
            :aria-pressed="category === opt.key"
            :data-testid="`filter-category-${opt.key}`"
            @click="emit('update:category', opt.key)"
          >
            {{ opt.label }}
            <span
              v-if="opt.key !== 'all' && groupCounts && groupCounts[opt.key]"
              class="ml-1 tabular-nums text-carbon-3"
              :data-testid="`filter-category-count-${opt.key}`"
            >{{ groupCounts[opt.key] }}</span>
          </button>
        </div>
      </div>
      <div>
        <div id="inbox-filter-severity-label" class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
          Severity
        </div>
        <div role="group" aria-labelledby="inbox-filter-severity-label" class="inline-flex p-0.5 bg-calm-2 rounded-lg gap-0.5">
          <button
            v-for="opt in SEVERITY_OPTIONS"
            :key="opt.key"
            type="button"
            :class="[BUTTON, severity === opt.key ? ON : OFF]"
            :aria-pressed="severity === opt.key"
            :data-testid="`filter-severity-${opt.key}`"
            @click="emit('update:severity', opt.key)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
      <div>
        <div id="inbox-filter-status-label" class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
          Status
        </div>
        <div role="group" aria-labelledby="inbox-filter-status-label" class="inline-flex p-0.5 bg-calm-2 rounded-lg gap-0.5">
          <button
            v-for="opt in STATUS_OPTIONS"
            :key="opt.key"
            type="button"
            :class="[BUTTON, status === opt.key ? ON : OFF]"
            :aria-pressed="status === opt.key"
            :data-testid="`filter-status-${opt.key}`"
            @click="emit('update:status', opt.key)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </div>
  </UiCard>
</template>
