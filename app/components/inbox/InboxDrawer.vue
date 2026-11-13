<script setup lang="ts">
/*
 * InboxDrawer — right-side drawer for the inbox detail view.
 *
 * Per design-notes §Screen 7: drawer over sub-page (deviation
 * accepted). Header shows category + severity chips + subject; body
 * is per-kind via DrawerBodyOverBudget / Velocity / SyncConflict /
 * Untagged; footer has the category-appropriate action buttons.
 *
 * Body-routing decision lives in `./types.ts::variantForCategory`
 * (single source of truth, unit-tested separately).
 *
 * The parent owns the <Transition>; this component is a plain aside
 * so it can be unmounted/mounted by `v-if`.
 */

import { computed, ref } from 'vue'
import { useModalA11y } from '../../composables/useModalA11y'
import UiButton from '../ui/Button.vue'
import UiBadge from '../ui/Badge.vue'
import DrawerBodyOverBudget from './DrawerBodyOverBudget.vue'
import DrawerBodyVelocity from './DrawerBodyVelocity.vue'
import DrawerBodySyncConflict from './DrawerBodySyncConflict.vue'
import DrawerBodyPersonalSubscription from './DrawerBodyPersonalSubscription.vue'
import DrawerBodyOverEmission from './DrawerBodyOverEmission.vue'
import DrawerBodyProjectRequest from './DrawerBodyProjectRequest.vue'
import DrawerBodyBudgetRequest from './DrawerBodyBudgetRequest.vue'
import DrawerBodyNearlyUsed from './DrawerBodyNearlyUsed.vue'
import DrawerBodySections from './DrawerBodySections.vue'
import { fmtInstant } from '../../composables/useFormat'
import { categoryBadge, closedNote, itemSubject, variantForCategory, type InboxItem } from './types'
import { ADMIN_ROUTED_KINDS, primaryAction } from './drawer-copy'

const props = defineProps<{
  item: InboxItem
  /* The server's answer to "may this reader open admin pages" (the list
   * route's `viewer_is_admin`); absent means no. */
  viewerIsAdmin?: boolean
}>()

const emit = defineEmits<{
  close: []
  resolve: []
  dismiss: []
  snooze: []
  'mark-read': []
}>()

const variant = computed(() => variantForCategory(props.item.category))

/*
 * #630 / #631: an item the worker closed says how it ended, and offers no
 * action: there is nothing left to resolve, dismiss or top up. "Open project"
 * in the header stays.
 */
const autoClosedNote = computed(() => closedNote(props.item))

/*
 * The one primary button (#573, drawer-copy.ts). An admin page is offered only
 * to an admin: an admin-routed alert can outlive its recipient's admin role,
 * and the page would bounce them home. Without a destination the primary is
 * Resolve, as before.
 */
const primary = computed(() => {
  const a = primaryAction(props.item)
  if (!a) return null
  if (a.to.startsWith('/admin') && !(ADMIN_ROUTED_KINDS.has(props.item.category) && props.viewerIsAdmin)) return null
  return a
})

// The drawer is mounted only while an item is open (the parent's v-if), so it
// is open for its whole lifetime. Shared dialog contract: Escape closes, Tab is
// trapped in the drawer, Close takes focus on open and focus returns to the
// row that opened it when the drawer unmounts.
const dialogEl = ref<HTMLElement | null>(null)
const closeBtn = ref<HTMLButtonElement | null>(null)
useModalA11y({
  isOpen: () => true,
  dialogEl,
  firstField: closeBtn,
  onClose: () => emit('close'),
})

const severityBadgeKind = computed<
  'hunger' | 'rag-red' | 'vision' | 'neutral'
>(() => {
  switch (props.item.severity) {
    case 'urgent':
      return 'rag-red'
    case 'attention':
      return 'hunger'
    case 'info':
    default:
      return 'vision'
  }
})
</script>

<template>
  <aside
    ref="dialogEl"
    role="dialog"
    aria-modal="true"
    :aria-label="`Inbox item: ${itemSubject(item)}`"
    class="fixed top-0 right-0 h-full w-full max-w-[480px] bg-white shadow-[-8px_0_32px_rgba(88,40,115,0.16)] z-50 flex flex-col"
    data-testid="inbox-drawer"
    :data-variant="variant"
  >
    <header class="px-6 py-5 border-b border-calm-2">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-2 flex-wrap">
          <UiBadge kind="neutral">{{ categoryBadge(item.category) }}</UiBadge>
          <UiBadge :kind="severityBadgeKind">{{ item.severity }}</UiBadge>
        </div>
        <button
          ref="closeBtn"
          type="button"
          class="text-carbon-3 hover:text-carbon cursor-pointer p-1 -mr-1 rounded transition-colors"
          aria-label="Close drawer"
          data-testid="drawer-close"
          @click="emit('close')"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <h2 class="mt-3 text-lg font-bold tracking-tight text-carbon leading-tight">
        {{ itemSubject(item) }}
      </h2>
      <div class="mt-2 flex items-center justify-between gap-3 text-xs text-carbon-3">
        <span data-testid="drawer-created">Created {{ fmtInstant(item.created_at) }}</span>
        <!-- The PROJECT page, not the budget editor: a member who is not the
             manager can open the first and not the second. The server emits the
             code only when this recipient can open the page. -->
        <NuxtLink
          v-if="item.target_project_code"
          :to="`/projects/${encodeURIComponent(item.target_project_code)}`"
          class="font-bold text-brand-harmony hover:underline"
          data-testid="drawer-open-project"
        >
          Open project →
        </NuxtLink>
      </div>
    </header>
    <!-- Keyed by item: selecting another item of the same kind remounts the body,
         so no body can keep showing the first item's figures. -->
    <div :key="item.id" class="flex-1 overflow-y-auto px-6 py-5" data-testid="drawer-body">
      <div
        v-if="autoClosedNote"
        class="mb-5 rounded-md bg-calm-1 border border-calm-2 px-4 py-3 text-sm text-carbon-2 leading-relaxed"
        data-testid="drawer-closed-note"
      >
        <p>{{ autoClosedNote }}</p>
        <p v-if="item.related_entity_kind === 'project'" class="mt-1 text-xs text-carbon-3">
          Nothing was changed on the project.
        </p>
      </div>
      <DrawerBodyOverBudget v-if="variant === 'over-budget'" :body="item.body" :closed="!!autoClosedNote" />
      <DrawerBodyVelocity v-else-if="variant === 'velocity'" :body="item.body" :closed="!!autoClosedNote" />
      <DrawerBodySyncConflict v-else-if="variant === 'sync-conflict'" :body="item.body" />
      <DrawerBodyNearlyUsed v-else-if="variant === 'nearly-used'" :body="item.body" :can-top-up="!!item.target_allocation_id" :closed="!!autoClosedNote" />
      <DrawerBodySections v-else-if="variant === 'sections'" :category="item.category" :body="item.body" :device-name="item.target_device_name ?? null" :closed="!!autoClosedNote" />
      <DrawerBodyPersonalSubscription v-else-if="variant === 'personal-subscription'" :body="item.body" />
      <DrawerBodyOverEmission v-else-if="variant === 'over-emission'" :body="item.body" />
      <DrawerBodyProjectRequest v-else-if="variant === 'project-request'" :category="item.category" :body="item.body" :viewer-is-admin="viewerIsAdmin" />
      <DrawerBodyBudgetRequest v-else-if="variant === 'budget-request'" :category="item.category" :body="item.body" />
      <div v-else class="text-sm text-carbon-2 leading-relaxed" data-testid="drawer-unknown-kind">
        This alert comes from a newer version of TokenScope than this page.
        Reload the page to see its details.
      </div>
    </div>
    <footer
      v-if="!autoClosedNote"
      class="px-6 py-4 border-t border-calm-2 flex items-center justify-end gap-2 flex-wrap"
    >
      <UiButton
        v-if="item.ack_state === 'unread'"
        kind="ghost"
        size="sm"
        data-testid="drawer-action-mark-read"
        @click="emit('mark-read')"
      >
        Mark read
      </UiButton>
      <UiButton
        v-if="variant === 'velocity' || variant === 'over-budget' || variant === 'nearly-used'"
        kind="ghost"
        size="sm"
        data-testid="drawer-action-snooze"
        title="Marks it seen and keeps it open until resolved."
        @click="emit('snooze')"
      >
        Acknowledge
      </UiButton>
      <UiButton
        kind="secondary"
        size="sm"
        data-testid="drawer-action-dismiss"
        @click="emit('dismiss')"
      >
        Dismiss
      </UiButton>
      <UiButton
        :kind="primary ? 'secondary' : 'primary'"
        size="sm"
        data-testid="drawer-action-resolve"
        @click="emit('resolve')"
      >
        Resolve
      </UiButton>
      <!--
        The one way forward (#573). For a budget alert it is Add top-up (the
        allocator with the top-up form open), only when this recipient can open
        the editor; otherwise the header's Open project is the way forward.
        Resolve stays beside it: a top-up that takes the project back inside
        its budget closes the alert on the worker's next hourly run (#631),
        and the reader may close it sooner.
        Opening the button never resolves the item.
      -->
      <UiButton
        v-if="primary"
        :to="primary.to"
        kind="primary"
        size="sm"
        :data-testid="primary.label === 'Add top-up' ? 'drawer-action-add-topup' : 'drawer-action-primary'"
      >
        {{ primary.label }} →
      </UiButton>
    </footer>
  </aside>
</template>
