<script setup lang="ts">
/*
 * ActivityCard — ONE list of what you did: OTel-observed sessions AND
 * provider-recorded days, in the same table (owner ruling 2026-08-05; design
 * §F4 D17-D21). It replaces RecentSessionsCard, which could only ever show
 * sessions — see shared/schemas/activity.ts for why a tagged provider day used
 * to vanish, and why this list is called Activity and not Sessions.
 *
 * TWO GRAINS, TWO RENDERINGS, ONE SORT. Every row sorts on the UTC day. A
 * SESSION then renders its real instant (`ts_last`) in the viewer's zone,
 * because it is a moment. A PROVIDER-RECORDED DAY renders the DATE and nothing
 * else — the type carries no timestamp, and this component must never invent
 * one. "00:00" here would be the NULL-as-0 defect wearing a clock.
 *
 * TWO DRAWERS, NEITHER OF THEM NEW (D21). A session row opens the session
 * drawer; a provider-day row opens the provider-day drawer (#231). Both already
 * ship, both are mounted by the pages, and this card only says WHICH — it
 * builds no details pane of its own, here or on the tagging worklist.
 *
 * The card owns its own filters, paging and fetch (a keyset list cannot be
 * driven from outside without moving the cursor there too) and exposes
 * `refresh()` so the pages keep their post-tag refresh choreography.
 */
import { computed, ref, watch } from 'vue'
import {
  ACTIVITY_EXPORT_DEFAULT,
  isRealUtcDay,
  type ActivityFilters,
  type ActivityListResponse,
  type ActivityRow,
  type ActivitySessionRow,
} from '#shared/schemas/activity'
import { deviceLabel } from '#shared/schemas/device-name'
import { fmtSessionSpan, fmtUtcDay } from '../../composables/useFormat'
import { useViewerZone } from '../../composables/useViewerZone'

const { timeZone: activityZone, isLocal: activityZoneIsLocal } = useViewerZone()

/** The tag/re-tag intent — shaped for HomeTagSessionDialog's TagTarget prop. */
export interface ActivityRetagTarget {
  session_id: string
  instance_id: string | null
  tool: string
  cost_usd: string | number
  /** NULL = the provider reported no token quantity (see the wire type). */
  tokens: number | null
  first_event?: string
  last_event: string
  device_name?: string | null
  project_id: string | null
  activity: string | null
  by_model?: { model: string; tokens: number; cost_usd: string }[]
  /** §A per-day records POST to their own assign route; the dialog is the same. */
  assign_url?: string
  subject_kind?: 'session' | 'day'
  subject_label?: string
}

const props = defineProps<{
  /** /me/quarantined-spend rows — drives the "unverified" badge on session rows. */
  quarantined?: { session_id: string; instance_id: string; cost_usd: string }[]
}>()

const emit = defineEmits<{
  /** The id is a conversation key for `open-session`, a record id for `open-provider-day`. */
  'open-session': [id: string]
  'open-provider-day': [id: string]
  retag: [target: ActivityRetagTarget]
}>()

const collapsed = ref(false) // open by default — it was too easy to miss collapsed

// ── Filters (D20). The CSV below is built from these SAME values. ────────────
const kind = ref<ActivityFilters['kind']>('all')
const tagged = ref<ActivityFilters['tagged']>('all')
const tool = ref<string>('')

/*
 * PROJECT AND DAYS (#578). The server already filters on both
 * (ActivityFilterQuery); the card now asks. The three live in the address
 * (`activity_project`, `activity_from`, `activity_to`), in BOTH directions:
 * a change writes them (replace, not push: one history entry per visit, not
 * one per keystroke), and an address change (Back or Forward to this page, a
 * shared link) sets the controls. So coming Back to the page returns the same
 * list. Days are INCLUSIVE UTC DAYS, typed as
 * dates and never converted (CLAUDE.md "The clock"); the date picker's upper
 * bound is the SERVER's today, never the browser's.
 */
const route = useRoute()
const router = useRouter()
const qs = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '')
const project = ref<string>(qs('activity_project'))
const fromDay = ref<string>(qs('activity_from'))
const toDay = ref<string>(qs('activity_to'))
const { today: serverToday } = useServerClock()

/** A field error instead of a request the server would refuse (no 400 page). */
const dayError = computed<string | null>(() => {
  if (fromDay.value && !isRealUtcDay(fromDay.value)) return 'From is not a real date.'
  if (toDay.value && !isRealUtcDay(toDay.value)) return 'To is not a real date.'
  if (fromDay.value && toDay.value && fromDay.value > toDay.value) return 'From is after To.'
  return null
})

const { data: projData, error: projError, refresh: refreshProjects } = useLazyFetch<{
  projects: { id: string; code: string; display_name: string }[]
}>('/api/v1/me/projects', { key: 'activity-card-projects', default: () => ({ projects: [] }) })
/*
 * A project named in the address that is not one of yours today (you left it)
 * stays a real choice: the filter still works on its code, so it is listed.
 */
const projectOptions = computed(() => {
  const list = projData.value?.projects ?? []
  if (project.value && !list.some((p) => p.code === project.value)) {
    return [...list, { id: `addr-${project.value}`, code: project.value, display_name: '' }]
  }
  return list
})

const filtersActive = computed(
  () => kind.value !== 'all' || tagged.value !== 'all' || !!tool.value || !!project.value || !!fromDay.value || !!toDay.value,
)

function clearFilters() {
  kind.value = 'all'
  tagged.value = 'all'
  tool.value = ''
  project.value = ''
  fromDay.value = ''
  toDay.value = ''
}

const activeFilters = computed(() => {
  const q: Record<string, string> = {}
  if (kind.value !== 'all') q.kind = kind.value
  if (tagged.value !== 'all') q.tagged = tagged.value
  if (tool.value) q.tool = tool.value
  if (project.value) q.project = project.value
  // A day the field marks wrong is not sent; the error says why.
  if (!dayError.value) {
    if (fromDay.value) q.from = fromDay.value
    if (toDay.value) q.to = toDay.value
  }
  return q
})

/** What the filtered list holds, said once under the table (design F4). */
/** When a session ran, in the viewer's zone (#597). The id stays in the tooltip, drawer and CSV. */
function sessionSpan(r: ActivitySessionRow): string {
  return fmtSessionSpan(r.ts_first, r.ts_last, activityZone.value, { utcLabel: !activityZoneIsLocal.value })
}

const filterSummary = computed<string | null>(() => {
  if (!project.value && !fromDay.value && !toDay.value) return null
  const who = project.value ? `Sessions and days that touched ${project.value}` : 'Sessions and days'
  let when = ''
  if (fromDay.value && toDay.value) when = ` from ${fmtUtcDay(fromDay.value, { year: true })} to ${fmtUtcDay(toDay.value, { year: true })} (UTC days)`
  else if (fromDay.value) when = ` from ${fmtUtcDay(fromDay.value, { year: true })} (UTC day)`
  else if (toDay.value) when = ` up to ${fmtUtcDay(toDay.value, { year: true })} (UTC day)`
  return `${who}${when}. A session that touched several projects can show another one here. Export CSV uses these same filters, up to the newest ${ACTIVITY_EXPORT_DEFAULT.toLocaleString('en-US')} rows.`
})

// Keep the address in step, so Back and a shared link return to this list.
const OWN_QUERY = new Set(['activity_project', 'activity_from', 'activity_to'])
watch([project, fromDay, toDay], ([p, f, t]) => {
  if (p === qs('activity_project') && f === qs('activity_from') && t === qs('activity_to')) return
  const rest = Object.fromEntries(Object.entries(route.query).filter(([k]) => !OWN_QUERY.has(k)))
  void router.replace({
    query: {
      ...rest,
      ...(p ? { activity_project: p } : {}),
      ...(f ? { activity_from: f } : {}),
      ...(t ? { activity_to: t } : {}),
    },
  })
})
// ...and the other way: an address that changes under the card sets the controls.
watch(
  () => [qs('activity_project'), qs('activity_from'), qs('activity_to')] as const,
  ([p, f, t]) => {
    if (project.value !== p) project.value = p
    if (fromDay.value !== f) fromDay.value = f
    if (toDay.value !== t) toDay.value = t
  },
)
const exportHref = computed(() => {
  const q = new URLSearchParams(activeFilters.value)
  const qs = q.toString()
  return `/api/v1/me/activity/export${qs ? `?${qs}` : ''}`
})

function exportCsv() {
  // Direct navigation — the browser handles the Content-Disposition. The URL
  // carries the ACTIVE filters, so the file is what the reader is looking at.
  if (import.meta.client) window.location.href = exportHref.value
}

// ── The keyset page (D18). `cursor` is opaque; only the server mints it. ─────
const PAGE_SIZE = 25
const rows = ref<ActivityRow[]>([])
const nextCursor = ref<string | null>(null)
const hasMore = ref(false)
const pending = ref(false)
const loadError = ref(false)

/*
 * ONLY THE NEWEST REQUEST MAY WRITE (external review). Three things call `load`
 * — a filter change, "Load more", and the page's post-tag `refresh()` — and
 * nothing stopped their responses landing out of order. Flip a filter twice
 * quickly and the FIRST response could arrive last and replace the list with
 * rows that do not match the controls above them; a `refresh()` racing a "Load
 * more" could append a page cut under different filters. On a list whose whole
 * job is "what did I do", a row that does not belong is indistinguishable from a
 * data error.
 *
 * A monotonic token is the whole mechanism: every call claims the next number,
 * and a response whose number is no longer current is DISCARDED — rows, cursor,
 * error and the pending flag alike. The last request wins because it is the last
 * request, not because it happened to be quickest.
 */
let requestSeq = 0

async function load(opts: { append: boolean }) {
  const seq = ++requestSeq
  pending.value = true
  if (!opts.append) loadError.value = false
  try {
    const res = await $fetch<ActivityListResponse>('/api/v1/me/activity', {
      query: {
        ...activeFilters.value,
        limit: PAGE_SIZE,
        ...(opts.append && nextCursor.value ? { cursor: nextCursor.value } : {}),
      },
    })
    if (seq !== requestSeq) return
    rows.value = opts.append ? [...rows.value, ...res.rows] : res.rows
    nextCursor.value = res.next_cursor
    hasMore.value = res.has_more
  } catch {
    if (seq !== requestSeq) return
    loadError.value = true
    if (!opts.append) rows.value = []
  } finally {
    // A superseded request must not clear the flag the CURRENT one is holding up.
    if (seq === requestSeq) pending.value = false
  }
}

/** Re-read from the first page — the pages call this after a tag or a resolve. */
async function refresh() {
  nextCursor.value = null
  await load({ append: false })
}

/*
 * THIS CARD ANSWERS NOTHING ABOUT ONBOARDING, AND NO LONGER PRETENDS TO
 * (external review r2). It briefly published `loaded`/`hasRows` so `/` could
 * decide its new-user CTA from this list instead of a second probe. Both facts
 * are about the CURRENT PAGE of the CURRENT FILTER — an active filter matching
 * nothing, or a failed refresh, read identically to "has never emitted" — and
 * the list is a UNION of OTel sessions and API-reported provider days, so it
 * cannot speak for the OTel lane the CTA is about at all. The page now reads a
 * server fact (`/me/home.has_ever_emitted`); only `refresh` is exposed.
 */
defineExpose({ refresh })

// A filter change is a NEW list, never an extension of the old one: appending
// across a cursor minted under different filters is how a paged list starts
// showing rows that do not match its own controls.
watch(() => JSON.stringify(activeFilters.value), () => void refresh(), { immediate: true })

// ── Rendering ────────────────────────────────────────────────────────────────
const quarantinedKeys = computed(
  () => new Set((props.quarantined ?? []).map((q) => `${q.session_id}|${q.instance_id}`)),
)
function isQuarantined(r: ActivityRow): boolean {
  return (
    r.kind === 'session' &&
    r.instance_id != null &&
    quarantinedKeys.value.has(`${r.id}|${r.instance_id}`)
  )
}

/*
 * A TOKEN COUNT THAT WAS NEVER MEASURED IS NOT A ZERO (external review).
 * GitHub's AI-credit usage API reports credits, not tokens, so a Copilot
 * provider-day genuinely has no token quantity — and this column printed "0" for
 * it, which reads as "measured, and it was nothing" beside a non-zero cost. It
 * is the same NULL-as-0 defect the `day` cell below refuses to commit with a
 * fabricated "00:00".
 *
 * The wire type is `number | null` (`ActivityRowBase.tokens`), and the retag
 * target this card emits carries the null through rather than flattening it —
 * the dialog states absence in its own subject row too. The formatting stays in
 * the template: `fmtTokens` is a Nuxt auto-import and is not in module scope.
 */
function tokensMissing(r: ActivityRow): boolean {
  return r.tokens == null
}

/** How the row's device reads: its name, else tool and short id (#576). */
function rowDevice(r: ActivityRow): string | null {
  if (r.kind !== 'session' || !r.instance_id) return null
  return deviceLabel({ instance_id: r.instance_id, tool: r.tool, display_name: r.device_name })
}

function toolPillProp(t: string): 'CC' | 'Cop' | 'Mixed' {
  if (t === 'copilot-cli') return 'Cop'
  if (t === 'mixed') return 'Mixed'
  return 'CC'
}

function openDetail(r: ActivityRow) {
  if (r.kind === 'session') emit('open-session', r.id)
  else emit('open-provider-day', r.id)
}

function retag(r: ActivityRow) {
  if (r.kind === 'session') {
    emit('retag', {
      session_id: r.id,
      instance_id: r.instance_id,
      tool: r.tool,
      cost_usd: r.cost_usd,
      tokens: r.tokens,
      first_event: r.ts_first,
      last_event: r.ts_last,
      device_name: r.device_name,
      project_id: r.project_id,
      activity: r.activity,
      by_model: r.by_model,
      subject_kind: 'session',
    })
  } else {
    emit('retag', {
      session_id: r.id,
      instance_id: null,
      tool: r.tool,
      cost_usd: r.cost_usd,
      tokens: r.tokens,
      // The day IS the subject. No instant is invented to fill this field.
      last_event: r.day,
      project_id: r.project_id,
      activity: r.activity,
      assign_url: `/api/v1/me/unaccounted/${r.id}/assign`,
      subject_kind: 'day',
      subject_label: r.day,
    })
  }
}
</script>

<template>
  <UiCard flush data-testid="activity-card">
    <div class="px-6 pt-6 pb-4 border-b border-calm-2">
      <div class="flex items-center justify-between gap-4">
        <button
          class="flex items-center gap-2.5 text-left group"
          data-testid="activity-toggle"
          :aria-expanded="!collapsed"
          @click="collapsed = !collapsed"
        >
          <Icon
            name="tabler:chevron-down"
            class="text-lg text-carbon-3 transition-transform group-hover:text-carbon"
            :class="collapsed ? '-rotate-90' : ''"
          />
          <div>
            <div class="text-lg font-bold text-carbon group-hover:text-brand-harmony transition-colors">Activity</div>
            <div class="text-xs text-carbon-3 mt-0.5">
              Your sessions and your provider-recorded days, newest first. A record of what
              happened, decided or not.
            </div>
          </div>
        </button>
        <UiButton v-if="!collapsed" kind="ghost" size="sm" data-testid="export-csv" @click="exportCsv">
          Export CSV
        </UiButton>
      </div>
      <!-- Filters (D20). The CSV above is built from these same values. -->
      <div v-if="!collapsed" class="flex flex-wrap items-center gap-2 mt-3" data-testid="activity-filters">
        <select
          v-model="kind"
          class="text-[11px] border border-calm-2 rounded px-2 py-1 text-carbon-2 bg-white"
          aria-label="Filter by record kind"
          data-testid="activity-filter-kind"
        >
          <option value="all">All records</option>
          <option value="session">Sessions</option>
          <option value="provider-day">Provider-recorded days</option>
        </select>
        <select
          v-model="tagged"
          class="text-[11px] border border-calm-2 rounded px-2 py-1 text-carbon-2 bg-white"
          aria-label="Filter by budget state"
          data-testid="activity-filter-tagged"
        >
          <option value="all">On or off a budget</option>
          <option value="tagged">On a budget</option>
          <option value="untagged">Not on a budget</option>
        </select>
        <select
          v-model="tool"
          class="text-[11px] border border-calm-2 rounded px-2 py-1 text-carbon-2 bg-white"
          aria-label="Filter by client"
          data-testid="activity-filter-tool"
        >
          <option value="">Every client</option>
          <option value="claude-code">Claude Code</option>
          <option value="copilot-cli">Copilot CLI</option>
        </select>
        <!-- #578: project and UTC-day range, kept in the address. -->
        <span class="inline-flex flex-col">
          <select
            v-model="project"
            class="text-[11px] border border-calm-2 rounded px-2 py-1 text-carbon-2 bg-white max-w-[16rem]"
            aria-label="Filter by project"
            data-testid="activity-filter-project"
          >
            <option value="">Any project</option>
            <option v-for="p in projectOptions" :key="p.id" :value="p.code">
              {{ p.display_name ? `${p.code} · ${p.display_name}` : p.code }}
            </option>
          </select>
          <UiAuxFetchError :error="projError" label="your projects" testid="activity-projects-error" @retry="refreshProjects" />
        </span>
        <label class="inline-flex items-center gap-1 text-[11px] text-carbon-3">
          From
          <input
            v-model="fromDay"
            type="date"
            class="text-[11px] border border-calm-2 rounded px-2 py-1 text-carbon-2 bg-white"
            :max="toDay || serverToday || undefined"
            :aria-invalid="dayError ? 'true' : undefined"
            aria-describedby="activity-day-help"
            data-testid="activity-filter-from"
          >
        </label>
        <label class="inline-flex items-center gap-1 text-[11px] text-carbon-3">
          To
          <input
            v-model="toDay"
            type="date"
            class="text-[11px] border border-calm-2 rounded px-2 py-1 text-carbon-2 bg-white"
            :min="fromDay || undefined"
            :max="serverToday || undefined"
            :aria-invalid="dayError ? 'true' : undefined"
            aria-describedby="activity-day-help"
            data-testid="activity-filter-to"
          >
        </label>
        <span id="activity-day-help" class="text-[11px] text-carbon-3">UTC days</span>
        <button
          v-if="filtersActive"
          type="button"
          class="text-[11px] font-semibold text-brand-harmony underline-offset-2 hover:underline"
          data-testid="activity-clear-filters"
          @click="clearFilters"
        >Clear filters</button>
      </div>
      <p v-if="!collapsed && dayError" role="alert" class="text-[11px] font-semibold text-brand-hunger mt-1" data-testid="activity-day-error">
        {{ dayError }} The list still shows the other filters.
      </p>
    </div>

    <UiEmptyState
      v-if="!collapsed && loadError"
      headline="Couldn't load your activity"
      sub="Something went wrong fetching this list. Change a filter or refresh to try again."
      data-testid="activity-error"
    />
    <!--
      #579: TWO empty states. With no filter, an empty FIRST page of the whole
      list is a fact about the account: nothing at all is recorded, sessions or
      provider days. With a filter, it only says the filter matched nothing,
      and must never suggest connecting a tool.
    -->
    <UiEmptyState
      v-else-if="!collapsed && !rows.length && !pending && filtersActive"
      headline="Nothing matches these filters"
      data-testid="activity-empty-filtered"
    >
      <UiButton kind="secondary" size="sm" data-testid="activity-empty-clear" @click="clearFilters">
        Clear filters
      </UiButton>
    </UiEmptyState>
    <UiEmptyState
      v-else-if="!collapsed && !rows.length && !pending"
      headline="No activity yet"
      sub="Connect Claude Code or Copilot on this computer; sessions appear here a few minutes after you use them."
      data-testid="activity-empty-none"
    >
      <NuxtLink
        to="/account#connect-a-tool"
        class="inline-flex items-center px-3 py-1.5 rounded-md bg-brand-harmony text-white text-sm font-semibold hover:opacity-90"
        data-testid="activity-empty-connect"
      >Connect a tool</NuxtLink>
    </UiEmptyState>
    <!-- #591: until the first page arrives, a loading line, never bare headers
         that read as "nothing here". -->
    <p
      v-else-if="!collapsed && !rows.length && pending"
      class="px-6 py-6 text-sm text-carbon-3"
      role="status"
      data-testid="activity-loading"
    >Loading…</p>
    <div v-else-if="!collapsed" class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-[11px] text-carbon-3 uppercase tracking-[1.2px]">
          <tr class="bg-brand-harmony-sheer/40">
            <th scope="col" class="text-left font-bold px-6 py-3">Record</th>
            <th scope="col" class="text-left font-bold px-6 py-3">Device</th>
            <th scope="col" class="text-left font-bold px-6 py-3">Project</th>
            <th scope="col" class="text-left font-bold px-6 py-3">Tool</th>
            <th scope="col" class="text-left font-bold px-6 py-3">When</th>
            <th scope="col" class="text-right font-bold px-6 py-3">Tokens</th>
            <th scope="col" class="text-right font-bold px-6 py-3">Cost</th>
            <th scope="col" class="px-6 py-3"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-calm-2">
          <tr v-for="r in rows" :key="r.kind + '|' + r.id" :data-testid="`activity-row-${r.id}`">
            <td class="px-6 py-3">
              <button
                type="button"
                class="text-carbon hover:text-brand-harmony hover:underline underline-offset-2 transition-colors text-[12px] font-semibold text-left"
                :data-testid="`activity-open-${r.id}`"
                :title="r.kind === 'session' ? `Session ${r.id}` : `View what the provider counted on ${r.day}`"
                @click="openDetail(r)"
              >
                <template v-if="r.kind === 'session'">{{ sessionSpan(r) }}</template>
                <template v-else>Provider-recorded day</template>
              </button>
              <span
                class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                :class="r.kind === 'session' ? 'bg-brand-harmony-sheer text-carbon-2' : 'bg-brand-vision/15 text-carbon-2'"
                :data-testid="`activity-kind-${r.id}`"
              >{{ r.kind === 'session' ? 'session' : 'provider day' }}</span>
            </td>
            <td
              class="px-6 py-3 text-[12px]"
              :class="r.kind === 'session' && r.device_name ? 'text-carbon-2' : 'font-mono text-[11px] text-carbon-3'"
              :title="(r.kind === 'session' && r.instance_id) || ''"
              :data-testid="`activity-device-${r.id}`"
            >
              {{ rowDevice(r) ?? '—' }}
            </td>
            <td class="px-6 py-3">
              <span v-if="r.project_code" class="block font-semibold text-carbon" :data-testid="`activity-project-name-${r.id}`">{{ r.project_display_name ?? r.project_code }}</span>
              <span v-if="r.project_code && r.project_display_name" class="block text-[11px] text-carbon-3 font-mono">{{ r.project_code }}</span>
              <span v-if="!r.project_code" class="font-semibold text-carbon">—</span>
              <span
                v-if="!r.attributed"
                class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-calm/50 text-carbon-3"
                title="No budget, so unallocated. Tag it to assign it."
              >unallocated</span>
              <span
                v-if="r.kind === 'provider-day' && r.dismissed"
                class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-calm-2 text-carbon-2"
                title="You decided to leave this unallocated. The spend is untouched, and the decision is reversible."
                data-testid="activity-dismissed-badge"
              >dismissed</span>
              <span
                v-if="r.kind === 'session' && r.partly_ended"
                class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-calm-2 text-carbon-2"
                :title="`Part of this conversation ran on ${r.ended_project_code ?? 'an ended project'} (now ended). Re-tagging moves only the spilled portion.`"
                data-testid="partly-ended-badge"
              >partly on ended {{ r.ended_project_code ?? 'project' }}</span>
              <span
                v-if="r.activity"
                class="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand-zeal-lite/60 text-carbon-2"
                :title="`Activity: ${r.activity}`"
              >{{ r.activity }}</span>
              <span
                v-if="isQuarantined(r)"
                class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-rag-amber/10 text-rag-amber"
                title="Unverified spend: this session claims an instance with no covering emit heartbeat. It's pending reconciliation (which confirms or removes it). Nothing is revoked or deleted; this is an early heads-up, not an enforcement action."
                data-testid="quarantined-badge"
              >unverified</span>
            </td>
            <td class="px-6 py-3">
              <span class="inline-flex items-center gap-1.5">
                <UiToolPill :tool="toolPillProp(r.tool)" />
                <UsageModelBadge v-if="r.kind === 'session'" :by-model="r.by_model" />
              </span>
            </td>
            <!--
              THE GRAIN RULE, in one cell. A session is an instant and renders
              in the viewer's zone; a provider-recorded day has no instant and
              renders its UTC date, never a fabricated time.
            -->
            <td class="px-6 py-3 text-carbon-2 text-[12px]" :data-testid="`activity-when-${r.id}`">
              <template v-if="r.kind === 'session'">{{ fmtTimeAgo(r.ts_last) }}</template>
              <template v-else>{{ r.day }}</template>
            </td>
            <!-- "not reported" ≠ 0: some providers count credits, not tokens. -->
            <td
              class="px-6 py-3 text-right text-carbon-2"
              style="font-variant-numeric: tabular-nums"
              :class="tokensMissing(r) ? 'italic text-carbon-3' : ''"
              :title="tokensMissing(r) ? 'This provider reports no token quantity for a recorded day: the cost is real, the token count was never measured.' : undefined"
              :data-testid="`activity-tokens-${r.id}`"
            >
              {{ tokensMissing(r) ? 'not reported' : fmtTokens(r.tokens) }}
            </td>
            <td class="px-6 py-3 text-right font-bold text-carbon" style="font-variant-numeric: tabular-nums">
              {{ fmtUsd(r.cost_usd) }}
            </td>
            <td class="px-6 py-3 text-right whitespace-nowrap">
              <UiButton kind="ghost" size="sm" :data-testid="`details-${r.id}`" @click="openDetail(r)">
                Details
              </UiButton>
              <UiButton kind="ghost" size="sm" :data-testid="`retag-${r.id}`" @click="retag(r)">
                {{ r.attributed ? 'Re-tag' : 'Tag' }}
              </UiButton>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="hasMore" class="px-6 py-4 border-t border-calm-2 text-center">
        <UiButton kind="ghost" size="sm" :disabled="pending" data-testid="activity-load-more" @click="load({ append: true })">
          {{ pending ? 'Loading…' : 'Load more' }}
        </UiButton>
      </div>
      <p v-if="filterSummary" class="px-6 py-3 border-t border-calm-2 text-[11px] text-carbon-3" data-testid="activity-filter-summary">
        {{ filterSummary }}
      </p>
    </div>
  </UiCard>
</template>
