<script setup lang="ts">
/*
 * Admin → Regions. The list of regions, each owning its own Business Unit
 * tree, projects, and teammates. "Manage" deep-links into the per-region
 * page (/admin/regions/:id).
 *
 * Platform-admins get a "+ New region" CTA that opens an accessible create
 * dialog (role=dialog, aria-modal, aria-labelledby, Escape closes, first
 * field focused on open, focus trap). Non-platform-admins see a note that
 * region creation is platform-admin only — the server enforces the 403.
 *
 * RBAC: client-side guard via useSession() — server middleware still
 * 401/403s a non-admin's API calls; the page just hides itself.
 */

import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { consola } from 'consola'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface RegionRow {
  id: string
  code: string
  display_name: string
}

const { session, ensure } = useSession()
await ensure()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'global-finops' || r === 'platform-admin'
})
const isPlatformAdmin = computed(() => session.value?.role === 'platform-admin')

const { data, refresh } = await useFetch<{ regions: RegionRow[] }>(
  '/api/v1/admin/regions',
  {
    default: () => ({ regions: [] }),
    immediate: isAdmin.value,
  },
)
const regions = computed(() => data.value?.regions ?? [])

// ── Create dialog ─────────────────────────────────────────────────────
// a11y modelled on TagSessionDialog: role=dialog + aria-modal +
// aria-labelledby, Escape closes, first field focused on open, focus trap.
const open = ref(false)
const code = ref('')
const displayName = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const firstField = ref<HTMLInputElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'region-create-title'
let lastFocused: HTMLElement | null = null

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeDialog()
    return
  }
  if (e.key === 'Tab' && dialogEl.value) {
    const focusable = Array.from(
      dialogEl.value.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null)
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

function openDialog() {
  code.value = ''
  displayName.value = ''
  error.value = null
  open.value = true
}

function closeDialog() {
  open.value = false
}

watch(
  open,
  async (isOpen) => {
    // DOM-only (listeners + focus). The immediate watch fires during SSR
    // setup where `document` is undefined — skip on the server. The dialog
    // only ever opens via a client click, so nothing is lost by deferring.
    if (!import.meta.client) return
    if (isOpen) {
      lastFocused = (document.activeElement as HTMLElement) ?? null // restore on close
      document.addEventListener('keydown', onKeydown)
      await nextTick()
      firstField.value?.focus()
    } else {
      document.removeEventListener('keydown', onKeydown)
      lastFocused?.focus()
      lastFocused = null
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))

async function createRegion() {
  saving.value = true
  error.value = null
  try {
    await $fetch('/api/v1/admin/regions', {
      method: 'POST',
      body: { code: code.value.trim(), display_name: displayName.value.trim() },
    })
    await refresh()
    closeDialog()
  } catch (err) {
    error.value = apiErrorDetail(err, 'Region create refused.')
    consola.warn('region create failed', err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-regions">
    <UiPageHead
      eyebrow="Administration"
      title="Regions"
      sub="Each region owns its Business Unit tree, projects, and teammates."
    />

    <div class="mb-4 flex items-center justify-between gap-3">
      <p v-if="!isPlatformAdmin" class="text-xs text-carbon-3">
        Only a platform admin can add regions.
      </p>
      <span v-else />
      <UiButton
        v-if="isPlatformAdmin"
        kind="primary"
        size="sm"
        data-testid="region-create-open"
        @click="openDialog"
      >
        + New region
      </UiButton>
    </div>

    <UiCard flush data-testid="regions-list">
      <div v-if="regions.length === 0">
        <UiEmptyState
          headline="No regions yet"
          sub="No regions are on file."
        />
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-brand-harmony-sheer/40 border-b border-calm-2">
              <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">
                Code
              </th>
              <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">
                Name
              </th>
              <th class="px-5 py-3"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-calm-2">
            <tr
              v-for="r in regions"
              :key="r.id"
              :data-testid="`region-row-${r.code}`"
              class="hover:bg-brand-harmony-sheer/30"
            >
              <td class="px-5 py-3 text-sm text-carbon font-mono">{{ r.code }}</td>
              <td class="px-5 py-3 text-sm text-carbon font-medium">{{ r.display_name }}</td>
              <td class="px-5 py-3 text-right whitespace-nowrap">
                <NuxtLink
                  :to="`/admin/regions/${r.id}`"
                  :data-testid="`region-manage-${r.code}`"
                  class="text-sm font-semibold text-brand-harmony hover:underline"
                >
                  Manage →
                </NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
      data-testid="region-create-modal"
      @click.self="closeDialog"
    >
      <div
        ref="dialogEl"
        class="w-full max-w-md bg-white rounded-xl shadow-xl"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
      >
        <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
          <div>
            <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">
              New region
            </p>
            <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">
              Add a region
            </h2>
          </div>
          <UiButton kind="ghost" size="sm" data-testid="region-create-close" @click="closeDialog">Close</UiButton>
        </div>
        <div class="px-6 py-4">
          <label for="region-create-code" class="text-[12px] font-semibold text-carbon">Code</label>
          <input
            id="region-create-code"
            ref="firstField"
            v-model="code"
            placeholder="e.g. apac, emea"
            class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white font-mono focus:border-brand-harmony focus:outline-none"
            data-testid="region-create-code"
          >

          <label for="region-create-name" class="text-[12px] font-semibold text-carbon">Display name</label>
          <input
            id="region-create-name"
            v-model="displayName"
            placeholder="e.g. Asia-Pacific"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
            data-testid="region-create-name"
            @keyup.enter="createRegion"
          >

          <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="region-create-error" role="alert">{{ error }}</p>

          <div class="flex justify-end gap-2 mt-5">
            <UiButton kind="ghost" data-testid="region-create-cancel" @click="closeDialog">Cancel</UiButton>
            <UiButton kind="primary" :disabled="saving" data-testid="region-create-submit" @click="createRegion">
              {{ saving ? 'Saving…' : 'Create region' }}
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
