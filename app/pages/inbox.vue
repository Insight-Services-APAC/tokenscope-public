<script setup lang="ts">
/*
 * Per-actor inbox (design-notes §Screen 7).
 *
 * Filter bar (Category / Severity / Status) sits in its own card.
 * List rows use the hi-fi grid layout (severity icon / subject +
 * meta / category badge / timestamp / chevron) with unread = Hunger
 * dot + bold copy. Click opens a right-side drawer (per design-notes,
 * promoted over the prior inline panel) with a per-kind body.
 */
import { ref, computed, nextTick, watch } from 'vue'
import { consola } from 'consola'
import InboxFilterBar, {
  type InboxCategoryFilter,
  type InboxSeverityFilter,
  type InboxStatusFilter,
} from '../components/inbox/InboxFilterBar.vue'
import InboxDrawer from '../components/inbox/InboxDrawer.vue'
import { apiErrorDetail, isConfirmedRejection } from '../composables/useApiError'
import { categoryBadge, closedNote, itemSubject, type InboxItem } from '../components/inbox/types'
import { inboxAckStateLabel, inboxEntityLabel, type InboxCategoryGroup } from '#shared/inbox/categories'
import { INBOX_BULK_MAX_IDS } from '#shared/schemas/inbox'

const category = ref<InboxCategoryFilter>('all')
const severity = ref<InboxSeverityFilter>('all')
// Opens on Open: resolved and dismissed items wait under Closed (#546).
const status = ref<InboxStatusFilter>('open')
const drawerId = ref<string | null>(null)

const fetchUrl = computed(() => {
  const params = new URLSearchParams()
  if (status.value !== 'all') {
    params.set('ack_state', status.value)
  }
  if (category.value !== 'all') {
    params.set('group', category.value)
  }
  if (severity.value !== 'all') {
    params.set('severity', severity.value)
  }
  const qs = params.toString()
  return `/api/v1/me/inbox${qs ? `?${qs}` : ''}`
})

interface InboxPage {
  items: InboxItem[]
  total: number
  next_cursor?: string | null
  viewer_is_admin?: boolean
  group_counts?: Partial<Record<InboxCategoryGroup, number>>
}
const { data, refresh, pending, error } = useFetch<InboxPage>(fetchUrl, {
  default: () => ({ items: [], total: 0, next_cursor: null }),
})

/*
 * Older pages (#569, #574). The first page is `data`; "Load more" appends the
 * next one under the SAME filters, from the server's `next_cursor`. Any filter
 * change drops them (a page from other filters must never mix in), and so does
 * the first page reloading.
 */
const olderItems = ref<InboxItem[]>([])
const olderCursor = ref<string | null | undefined>(undefined)
const loadingMore = ref(false)
/*
 * Bumped whenever the list is replaced (a filter change, or a reload after an
 * action). A "Load more" answer that started under an older generation is
 * dropped: appending it would duplicate rows the reload already shows.
 */
let listGen = 0
watch(fetchUrl, () => {
  listGen += 1
  olderItems.value = []
  olderCursor.value = undefined
})
/*
 * One row per id: while a reload replaces the first page, the older pages are
 * kept until their replacement lands (so an open drawer on an older item does
 * not vanish), and a row can briefly be in both.
 */
const allItems = computed<InboxItem[]>(() => {
  const seen = new Set<string>()
  const out: InboxItem[] = []
  for (const i of [...(data.value?.items ?? []), ...olderItems.value]) {
    if (seen.has(i.id)) continue
    seen.add(i.id)
    out.push(i)
  }
  return out
})
const nextCursor = computed(() =>
  olderCursor.value === undefined ? (data.value?.next_cursor ?? null) : olderCursor.value,
)
const remaining = computed(() => Math.max(0, (data.value?.total ?? 0) - allItems.value.length))

const OLDER_PAGE_TIMEOUT_MS = 15_000
async function fetchOlder(cursor: string, url: string): Promise<InboxPage> {
  // Bounded: list operations run one at a time, so a hung page would hold
  // back the reload after an action.
  return await $fetch<InboxPage>(`${url}${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`, {
    timeout: OLDER_PAGE_TIMEOUT_MS,
  })
}
/*
 * Paging and reloading run one at a time (Copilot review on PR 586): a Load
 * more started while a reload replays the older pages would fetch a cursor the
 * replay also fetches, and append that page twice.
 */
let listOp: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = listOp.then(fn, fn)
  listOp = run.catch(() => {})
  return run
}

function loadMore() {
  if (loadingMore.value) return Promise.resolve()
  loadingMore.value = true
  return serialize(loadMoreNow).finally(() => { loadingMore.value = false })
}
async function loadMoreNow() {
  const cursor = nextCursor.value
  if (!cursor) return
  const url = fetchUrl.value
  const gen = listGen
  try {
    const page = await fetchOlder(cursor, url)
    // The list was replaced while this was in flight: its page is stale.
    if (gen !== listGen || url !== fetchUrl.value) return
    const have = new Set(olderItems.value.map((i) => i.id))
    olderItems.value = [...olderItems.value, ...page.items.filter((i) => !have.has(i.id))]
    olderCursor.value = page.next_cursor ?? null
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Older items did not load. Try again.'))
  }
}

/*
 * After an action, reload the first page and as many older pages as were
 * loaded, so the list keeps its place instead of snapping back to 50.
 */
function reloadList() {
  return serialize(reloadListNow)
}
async function reloadListNow() {
  const keep = olderItems.value.length
  const url = fetchUrl.value
  listGen += 1
  const gen = listGen
  await refresh()
  // The older pages stay as they are until their replacement has loaded: an
  // open drawer on an older item stays open, and a failed replay loses nothing.
  let cursor = data.value?.next_cursor ?? null
  const reloaded: InboxItem[] = []
  try {
    while (cursor && reloaded.length < keep && gen === listGen) {
      const page = await fetchOlder(cursor, url)
      reloaded.push(...page.items)
      cursor = page.next_cursor ?? null
    }
  } catch (err) {
    // The old pages may hold items that changed, and their cursor may skip
    // rows: drop them and page again from the refreshed first page. An open
    // drawer keeps its item (drawerSnapshot).
    consola.warn('inbox: reloading older pages failed', { err })
    if (gen === listGen) {
      olderItems.value = []
      olderCursor.value = undefined
      flashToast('err', 'Older items did not reload. Use Load more to see them again.')
    }
    return
  }
  if (gen !== listGen || url !== fetchUrl.value) return
  olderItems.value = reloaded
  olderCursor.value = reloaded.length > 0 ? cursor : undefined
}

/*
 * Empty, refused and failed are three different answers, and only the first
 * means "nothing is waiting". `default` fills `data` with an empty list even
 * when the read failed, so the error is checked BEFORE the list: a failed load
 * must never read as an empty inbox. Refused = the server answered with a 4xx
 * and a reason (isConfirmedRejection); anything else (no answer, a 5xx) is a
 * failure, and then we cannot know what is in the inbox.
 */
const loadState = computed<'refused' | 'failed' | null>(() => {
  if (!error.value) return null
  return isConfirmedRejection(error.value) ? 'refused' : 'failed'
})
const refusedDetail = computed(() =>
  apiErrorDetail(error.value, 'none').replace(/\.$/, ''),
)

/*
 * The inbox opens on Open, so an empty list is not "an empty inbox": it can be
 * holding closed items, or the filters can be hiding the rest.
 */
const emptyCopy = computed(() => {
  if (category.value !== 'all' || severity.value !== 'all') {
    return { headline: 'Nothing matches these filters.', sub: 'Choose All in Category or Severity to see the rest.' }
  }
  if (status.value === 'open') {
    return {
      headline: 'Nothing open.',
      sub: 'Resolved and dismissed items are under Closed. Alerts, conflicts and requests routed to you appear in this inbox, and only here.',
    }
  }
  if (status.value === 'unread') {
    return { headline: 'Nothing unread.', sub: 'Items you have opened stay under Open until they are resolved or dismissed.' }
  }
  if (status.value === 'closed') {
    return { headline: 'Nothing closed yet.', sub: 'Items you resolve or dismiss move here.' }
  }
  return {
    headline: 'Nothing to see here.',
    sub: 'Alerts, conflicts and requests routed to you appear in this inbox, and only here. Check back when you want to see them.',
  }
})

/*
 * The list is the newest page the server returns (50 by default), plus any
 * older pages loaded under it, with the full match count in `total`. When more
 * match than are shown the page says so and offers the next page (#569): an
 * older item past the cut is otherwise silently missing.
 */
const truncationNote = computed(() => {
  const shown = allItems.value.length
  const total = data.value?.total ?? 0
  if (total <= shown) return null
  return `Showing the newest ${shown} of ${total} matching items.`
})
const PAGE_SIZE = 50
const loadMoreLabel = computed(() => `Load ${Math.min(PAGE_SIZE, remaining.value)} more`)

/*
 * The open item, as last listed. Kept apart from the list so a reload that
 * drops the older pages does not close a drawer on one of their items.
 */
const drawerSnapshot = ref<InboxItem | null>(null)
const drawerItem = computed<InboxItem | null>(() => {
  if (!drawerId.value) return null
  const listed = allItems.value.find((i) => i.id === drawerId.value)
  if (listed) return listed
  return drawerSnapshot.value?.id === drawerId.value ? drawerSnapshot.value : null
})

// FE-5: action failures surface as a toast (the admin-pages flashToast house
// pattern) instead of an unhandled rejection from a template handler.
const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

/**
 * PATCH the ack state. Never throws — failures toast + return false so
 * callers (resolve/dismiss/snooze) only close the drawer on success.
 */
async function ack(id: string, newState: InboxItem['ack_state']): Promise<boolean> {
  try {
    await $fetch(`/api/v1/me/inbox/${id}`, {
      method: 'PATCH',
      body: { ack_state: newState },
    })
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Inbox update failed. Try again.'))
    consola.warn('inbox: ack failed', { id, newState, err })
    return false
  }
  await reloadList()
  await refreshUnread()
  // The header bell (keyed 'inbox-open-count', it counts UNREAD since #574)
  // must re-sync now, not on the next reload.
  await refreshNuxtData('inbox-open-count')
  return true
}

// Track the element that opened the drawer so we restore focus there on
// close: focus comes back to the row.
const lastFocusedEl = ref<HTMLElement | null>(null)

function openDrawer(item: InboxItem, originEl?: HTMLElement | null) {
  drawerId.value = item.id
  drawerSnapshot.value = item
  if (originEl) lastFocusedEl.value = originEl
  if (item.ack_state === 'unread') {
    // ack never rejects — a failed auto-mark-read toasts + logs internally.
    void ack(item.id, 'read')
  }
  // Move focus to the drawer close button so keyboard users can dismiss
  // with one keystroke. Wait for the next tick so the drawer is mounted.
  void nextTick(() => {
    const closeBtn = document.querySelector<HTMLElement>('[data-testid="drawer-close"]')
    closeBtn?.focus()
  })
}

function closeDrawer() {
  const closedId = drawerId.value
  drawerId.value = null
  drawerSnapshot.value = null
  // Restore focus to the row that opened the drawer. A reload may have
  // re-rendered it, so find the row by id when the saved element is detached.
  void nextTick(() => {
    const saved = lastFocusedEl.value
    const row = saved?.isConnected
      ? saved
      : closedId
        ? document.querySelector<HTMLElement>(`[data-item-id="${closedId}"]`)
        : null
    ;(row ?? selectAllEl.value)?.focus()
    lastFocusedEl.value = null
  })
}

// Escape and the Tab focus trap belong to the drawer (useModalA11y in
// InboxDrawer.vue), which emits `close` into closeDrawer above.
watch(drawerId, (v) => {
  // Defensive: if the underlying item disappears (refresh), close.
  if (v && !drawerItem.value) drawerId.value = null
})

// FE-5: the drawer closes ONLY when the PATCH succeeded — a failed action
// keeps it open with the toast explaining why.
async function handleResolve(id: string) {
  if (await ack(id, 'resolved')) closeDrawer()
}

async function handleDismiss(id: string) {
  if (await ack(id, 'dismissed')) closeDrawer()
}

async function handleSnooze(id: string) {
  // Snooze is "ack + reopen 24h later" in the full model; for the
  // pilot, treat as acknowledged so the bell badge clears without
  // closing the inbox row.
  if (await ack(id, 'acknowledged')) closeDrawer()
}

/*
 * ── Selection and bulk actions (#574) ──────────────────────────────────────
 * A checkbox per row and an action bar: Mark read, Resolve, Dismiss for the
 * ticked rows, through POST /api/v1/me/inbox/bulk. The selection clears when
 * the filters change, so an action never reaches rows the list no longer shows.
 */
const selected = ref<Set<string>>(new Set())
watch(fetchUrl, () => { selected.value = new Set() })
const selectedCount = computed(() => allItems.value.filter((i) => selected.value.has(i.id)).length)
const allSelected = computed(() => allItems.value.length > 0 && selectedCount.value === allItems.value.length)
function toggleRow(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(allItems.value.map((i) => i.id))
}
const selectAllEl = ref<HTMLInputElement | null>(null)
function clearSelection() {
  selected.value = new Set()
  // The bar's actions go away with the selection: keep focus on the list.
  void nextTick(() => selectAllEl.value?.focus())
}

const bulkBusy = ref(false)
const BULK_WORDS: Record<'read' | 'resolved' | 'dismissed', string> = {
  read: 'marked read',
  resolved: 'resolved',
  dismissed: 'dismissed',
}
async function bulk(ackState: 'read' | 'resolved' | 'dismissed') {
  const ids = allItems.value.filter((i) => selected.value.has(i.id)).map((i) => i.id)
  if (ids.length === 0 || bulkBusy.value) return
  bulkBusy.value = true
  let changed = 0
  let skipped = 0
  const done: string[] = []
  try {
    // The route takes at most INBOX_BULK_MAX_IDS per call; four loaded pages
    // and a select-all can be more.
    for (let i = 0; i < ids.length; i += INBOX_BULK_MAX_IDS) {
      const chunk = ids.slice(i, i + INBOX_BULK_MAX_IDS)
      const res = await $fetch<{ changed: number; not_changed: string[] }>('/api/v1/me/inbox/bulk', {
        method: 'POST',
        body: { ids: chunk, ack_state: ackState },
      })
      changed += res.changed
      skipped += res.not_changed.length
      done.push(...chunk)
    }
    flashToast(
      'ok',
      `${changed} ${changed === 1 ? 'item' : 'items'} ${BULK_WORDS[ackState]}.` +
        (skipped ? ` ${skipped} left unchanged: Mark read changes only unread items, and an item already in that state stays as it is.` : ''),
    )
    if (drawerId.value && ids.includes(drawerId.value) && ackState !== 'read') closeDrawer()
  } catch (err) {
    flashToast(
      'err',
      done.length
        ? `${changed} ${changed === 1 ? 'item' : 'items'} ${BULK_WORDS[ackState]} before an error; the rest are unchanged and still selected. ${apiErrorDetail(err, '')}`.trim()
        : apiErrorDetail(err, 'Inbox update failed. Try again.'),
    )
    consola.warn('inbox: bulk failed', { ackState, err })
  } finally {
    // Unselect only what was sent and applied: nothing else can have been
    // ticked meanwhile (the checkboxes are disabled while busy), and a failed
    // remainder stays selected for another try.
    const sent = new Set(done)
    selected.value = new Set([...selected.value].filter((id) => !sent.has(id)))
    bulkBusy.value = false
  }
  await reloadList()
  await refreshUnread()
  await refreshNuxtData('inbox-open-count')
  restoreListFocus()
}

/*
 * After a bulk action the button that ran it is gone with the selection: put
 * focus back on Select all shown, or on the filters when no rows remain, so
 * the next Tab continues through the inbox (Copilot review on PR 586).
 */
const pageEl = ref<HTMLElement | null>(null)
function restoreListFocus() {
  void nextTick(() => {
    // Only when focus was lost (on the body, or still in this page) and no
    // drawer has opened since: never pull it out of a drawer or another page.
    if (!pageEl.value?.isConnected || drawerId.value) return
    const active = document.activeElement
    if (active && active !== document.body && !pageEl.value.contains(active)) return
    if (active && active !== document.body && active.isConnected) return
    const target =
      selectAllEl.value ??
      document.querySelector<HTMLElement>('[data-testid="inbox-filter-bar"] button')
    target?.focus()
  })
}

/*
 * "Mark all read" for the current Category and Severity (#574): every unread
 * item they match, including the ones past the pages loaded. Its count comes
 * from the server under the same filters, whatever the Status filter shows.
 */
const unreadUrl = computed(() => {
  const params = new URLSearchParams({ ack_state: 'unread', limit: '1' })
  if (category.value !== 'all') params.set('group', category.value)
  if (severity.value !== 'all') params.set('severity', severity.value)
  return `/api/v1/me/inbox?${params.toString()}`
})
const { data: unreadData, refresh: refreshUnread } = useFetch<{ total: number }>(unreadUrl, {
  default: () => ({ total: 0 }),
  lazy: true,
})
const unreadMatching = computed(() => unreadData.value?.total ?? 0)
const markingAll = ref(false)
async function markAllRead() {
  if (markingAll.value || unreadMatching.value === 0) return
  markingAll.value = true
  try {
    const body: { ack_state: 'read'; all_unread: { group?: string; severity?: string } } = {
      ack_state: 'read',
      all_unread: {},
    }
    if (category.value !== 'all') body.all_unread.group = category.value
    if (severity.value !== 'all') body.all_unread.severity = severity.value
    const res = await $fetch<{ changed: number }>('/api/v1/me/inbox/bulk', { method: 'POST', body })
    flashToast('ok', `${res.changed} ${res.changed === 1 ? 'item' : 'items'} marked read.`)
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Inbox update failed. Try again.'))
    consola.warn('inbox: mark all read failed', { err })
  } finally {
    markingAll.value = false
  }
  await reloadList()
  await refreshUnread()
  await refreshNuxtData('inbox-open-count')
  restoreListFocus()
}

function severityIconColor(sev: string): string {
  if (sev === 'urgent') return 'bg-[#FEE2E2] text-rag-red'
  if (sev === 'attention') return 'bg-brand-hunger-lite text-brand-heart'
  return 'bg-brand-vision-lite text-brand-vision-ink'
}

</script>

<template>
  <div ref="pageEl" class="max-w-[1440px] mx-auto px-10 py-8 pb-20">
    <UiPageHead
      eyebrow="Inbox"
      title="What needs your attention"
      sub="Conflicts, alerts and action requests routed to you. They appear only here: TokenScope does not send them by Teams or email."
    >
      <template #actions>
        <UiButton
          v-if="unreadMatching > 0"
          kind="secondary"
          size="sm"
          :disabled="markingAll"
          data-testid="inbox-mark-all-read"
          @click="markAllRead"
        >
          {{ markingAll ? 'Marking…' : `Mark all ${unreadMatching} read` }}
        </UiButton>
      </template>
    </UiPageHead>

    <div
      v-if="toast"
      :data-testid="`inbox-toast-${toast.kind}`"
      role="alert"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <InboxFilterBar
      :category="category"
      :severity="severity"
      :status="status"
      :group-counts="error ? null : (data?.group_counts ?? null)"
      @update:category="(v) => (category = v)"
      @update:severity="(v) => (severity = v)"
      @update:status="(v) => (status = v)"
    />

    <UiCard v-if="pending" flush>
      <div class="p-10 text-center text-carbon-3 text-sm">Loading…</div>
    </UiCard>

    <UiCard v-else-if="loadState === 'refused'" flush data-testid="inbox-refused">
      <UiEmptyState
        headline="The server refused to list your inbox."
        :sub="`Reason given: ${refusedDetail}. Your items are not shown here, and none of them has been cleared.`"
      />
    </UiCard>

    <UiCard v-else-if="loadState === 'failed'" flush data-testid="inbox-failed">
      <UiEmptyState
        headline="Your inbox didn't load."
        sub="We couldn't get an answer from the server, so we can't tell whether anything is waiting for you. Nothing has been cleared."
      >
        <UiButton kind="secondary" size="sm" data-testid="inbox-retry" @click="refresh()">
          Try again
        </UiButton>
      </UiEmptyState>
    </UiCard>

    <UiCard v-else-if="allItems.length === 0" flush data-testid="inbox-empty">
      <UiEmptyState :headline="emptyCopy.headline" :sub="emptyCopy.sub" />
    </UiCard>

    <template v-else>
      <!-- #574: select all, always there; the actions appear with a selection. -->
      <div
        class="mb-3 flex items-center gap-3 flex-wrap rounded-lg border px-4 py-2.5"
        :class="selectedCount > 0 ? 'border-calm bg-brand-harmony-sheer' : 'border-calm-2 bg-white'"
        role="region"
        aria-label="Select items"
        data-testid="inbox-bulk-bar"
      >
        <label class="flex items-center gap-2 cursor-pointer">
          <input
            ref="selectAllEl"
            type="checkbox"
            class="w-4 h-4 accent-brand-harmony cursor-pointer"
            :checked="allSelected"
            :indeterminate.prop="selectedCount > 0 && !allSelected"
            :disabled="bulkBusy"
            data-testid="inbox-select-all"
            @change="toggleAll"
          >
          <span class="text-sm font-bold text-carbon" data-testid="inbox-selected-count" aria-live="polite">
            {{ selectedCount > 0 ? `${selectedCount} selected` : 'Select all shown' }}
          </span>
        </label>
        <template v-if="selectedCount > 0">
          <span class="flex-1" />
          <UiButton kind="secondary" size="sm" :disabled="bulkBusy" data-testid="inbox-bulk-read" @click="bulk('read')">Mark read</UiButton>
          <UiButton kind="secondary" size="sm" :disabled="bulkBusy" data-testid="inbox-bulk-resolve" @click="bulk('resolved')">Resolve</UiButton>
          <UiButton kind="secondary" size="sm" :disabled="bulkBusy" data-testid="inbox-bulk-dismiss" @click="bulk('dismissed')">Dismiss</UiButton>
          <UiButton kind="ghost" size="sm" :disabled="bulkBusy" data-testid="inbox-bulk-clear" @click="clearSelection">Clear</UiButton>
        </template>
      </div>
      <UiCard flush>
        <ul class="divide-y divide-calm-2" data-testid="inbox-list">
          <li
            v-for="item in allItems"
            :key="item.id"
            class="flex items-center"
            :data-testid="`inbox-row-${item.ack_state}`"
          >
            <label class="pl-5 py-4 pr-1 flex items-center cursor-pointer self-stretch">
              <input
                type="checkbox"
                class="w-4 h-4 accent-brand-harmony cursor-pointer"
                :checked="selected.has(item.id)"
                :disabled="bulkBusy"
                :aria-label="`Select ${itemSubject(item)}`"
                data-testid="inbox-row-select"
                @change="toggleRow(item.id)"
              >
            </label>
            <button
              type="button"
              class="flex-1 min-w-0 grid grid-cols-[28px_1fr_auto_auto_16px] items-center gap-4 pl-3 pr-5 py-4 hover:bg-brand-harmony-sheer transition-colors text-left cursor-pointer"
              :data-item-id="item.id"
              :aria-label="`Open ${itemSubject(item)}. ${categoryBadge(item.category)}. ${inboxAckStateLabel(item.ack_state)}`"
              @click="(ev) => openDrawer(item, ev.currentTarget as HTMLElement)"
            >
              <span class="flex items-center gap-1.5">
                <span
                  v-if="item.ack_state === 'unread'"
                  class="inline-block w-1.5 h-1.5 rounded-full bg-brand-hunger shrink-0"
                  aria-hidden="true"
                />
                <span
                  class="w-6 h-6 rounded-full inline-flex items-center justify-center text-[10px] font-bold shrink-0"
                  :class="severityIconColor(item.severity)"
                  :title="item.severity"
                >
                  {{ item.severity[0]?.toUpperCase() ?? '?' }}
                </span>
              </span>
              <div class="min-w-0">
                <div
                  class="text-sm text-carbon"
                  :class="[
                    item.ack_state === 'unread' ? 'font-bold' : 'font-medium',
                    ['dismissed', 'resolved'].includes(item.ack_state) ? 'text-carbon-2' : '',
                  ]"
                >
                  {{ itemSubject(item) }}
                </div>
                <div class="text-[11px] text-carbon-3 mt-1">
                  <template v-if="inboxEntityLabel(item.related_entity_kind)">{{ inboxEntityLabel(item.related_entity_kind) }} · </template>{{ inboxAckStateLabel(item.ack_state) }}
                </div>
                <!-- #630 / #631: how an item the worker closed ended. -->
                <div
                  v-if="closedNote(item)"
                  class="text-[11px] text-carbon-3 mt-0.5"
                  data-testid="inbox-row-closed-note"
                >
                  {{ closedNote(item) }}
                </div>
              </div>
              <UiBadge kind="neutral">{{ categoryBadge(item.category) }}</UiBadge>
              <span class="text-[11px] text-carbon-3 whitespace-nowrap">
                {{ fmtTimeAgo(item.created_at) }}
              </span>
              <svg
                class="w-4 h-4 text-carbon-3 shrink-0"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </li>
        </ul>
        <div
          v-if="truncationNote"
          class="px-5 py-3 text-xs text-carbon-3 border-t border-calm-2 flex items-center justify-between gap-3 flex-wrap"
        >
          <span data-testid="inbox-truncated">{{ truncationNote }}</span>
          <UiButton
            v-if="nextCursor"
            kind="secondary"
            size="sm"
            :disabled="loadingMore"
            data-testid="inbox-load-more"
            @click="loadMore"
          >
            {{ loadingMore ? 'Loading…' : loadMoreLabel }}
          </UiButton>
        </div>
      </UiCard>
    </template>

    <Transition
      enter-active-class="transition-transform duration-200 ease-out"
      enter-from-class="translate-x-full"
      enter-to-class="translate-x-0"
      leave-active-class="transition-transform duration-150 ease-in"
      leave-from-class="translate-x-0"
      leave-to-class="translate-x-full"
    >
      <InboxDrawer
        v-if="drawerItem"
        :item="drawerItem"
        :viewer-is-admin="data?.viewer_is_admin === true"
        @close="closeDrawer"
        @resolve="handleResolve(drawerItem.id)"
        @dismiss="handleDismiss(drawerItem.id)"
        @snooze="handleSnooze(drawerItem.id)"
        @mark-read="ack(drawerItem.id, 'read')"
      />
    </Transition>
  </div>
</template>
