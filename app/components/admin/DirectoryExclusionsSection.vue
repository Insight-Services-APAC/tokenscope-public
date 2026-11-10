<script setup lang="ts">
/*
 * DirectoryExclusionsSection — the editable directory-exclusion policy on
 * Admin → Settings, backed by GET/POST/DELETE /api/v1/admin/directory-exclusions
 * (mig 0083, server/utils/directory-exclusions.ts).
 *
 * Org-wide config: accounts whose sign-in name (UPN) matches a pattern are
 * hidden from every people-picker and refused on assign — the mechanism for
 * keeping privileged/service accounts (e.g. an admin's `-cld@…onmicrosoft.com`)
 * from ever becoming teammates. Portable: a fresh install has NO patterns and
 * excludes nobody; each org opts in to its own conventions.
 *
 * Extracted so the render logic is unit-testable with the plain
 * @vue/test-utils harness: rows arrive via props; only the mutations use $fetch.
 */
import AdminResultToast from './AdminResultToast.vue'
import ConfirmActionDialog from './ConfirmActionDialog.vue'
import { focusIfLost } from '../../utils/focus-fallback'
import { useResultToast } from '../../composables/useResultToast'
import { nextTick, ref } from 'vue'
import UiCard from '../ui/Card.vue'
import UiEyebrow from '../ui/Eyebrow.vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'

export interface DirectoryExclusionRow {
  id: string
  pattern: string
  note: string | null
  created_at: string
}

defineProps<{
  rows: DirectoryExclusionRow[]
  /** platform-admin — only they may edit (org-wide config). */
  orgWide: boolean
}>()

const emit = defineEmits<{ changed: [] }>()

const draftPattern = ref('')
const draftNote = ref('')
const busy = ref(false)
const { toast, flashToast: flash, dismissToast } = useResultToast()

async function add() {
  const pattern = draftPattern.value.trim()
  if (!pattern) return
  busy.value = true
  toast.value = null
  try {
    const res = await $fetch<{ pattern: string; matched_existing_count: number }>(
      '/api/v1/admin/directory-exclusions',
      { method: 'POST', body: { pattern, note: draftNote.value.trim() || undefined } },
    )
    draftPattern.value = ''
    draftNote.value = ''
    const warn =
      res.matched_existing_count > 0
        ? ` — heads up: it matches ${res.matched_existing_count} existing teammate(s), who will be hidden from pickers (run privileged-identity-cleanup to retire inert ones).`
        : ''
    flash('ok', `Added "${res.pattern}"${warn}`)
    emit('changed')
  } catch (e) {
    flash('err', apiErrorDetail(e, 'Could not add pattern.'))
  } finally {
    busy.value = false
  }
}

/* Removing a pattern asks first (#543): Cancel sends nothing. */
const pendingRemove = ref<DirectoryExclusionRow | null>(null)

function askRemove(row: DirectoryExclusionRow) {
  pendingRemove.value = row
}

async function confirmRemove() {
  const row = pendingRemove.value
  pendingRemove.value = null
  if (!row) return
  await remove(row)
  // The row (and the Remove button that opened the dialog) leaves the list.
  await nextTick()
  focusIfLost('[data-testid="exclusion-pattern-input"]')
}

async function remove(row: DirectoryExclusionRow) {
  busy.value = true
  toast.value = null
  try {
    await $fetch(`/api/v1/admin/directory-exclusions/${row.id}`, { method: 'DELETE' })
    flash('ok', `Removed "${row.pattern}"`)
    emit('changed')
  } catch (e) {
    flash('err', apiErrorDetail(e, 'Could not remove pattern.'))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UiCard accent="harmony" data-testid="settings-directory-exclusions">
    <UiEyebrow>Directory</UiEyebrow>
    <h2 class="text-lg font-bold text-carbon mt-1 mb-1">Directory exclusions</h2>
    <p class="text-xs text-carbon-3 mb-4 leading-relaxed">
      Accounts whose sign-in name (UPN) matches one of these patterns are hidden from people-pickers
      and can't be assigned as owners/members — use it to keep privileged/service accounts (e.g. an
      admin's <span class="font-mono">-cld@…onmicrosoft.com</span> account) from becoming teammates.
      <span class="font-semibold">*</span> is a wildcard. A fresh install has none (excludes nobody).
      Recommended for Entra: your privileged domain, e.g.
      <span class="font-mono">*@yourtenant.onmicrosoft.com</span>.
    </p>

    <AdminResultToast :toast="toast" testid="settings-exclusions-toast" @dismiss="dismissToast" />

    <ul v-if="rows.length" class="mb-4 border border-calm-2 rounded-md divide-y divide-calm-2" data-testid="exclusions-list">
      <li v-for="row in rows" :key="row.id" class="flex items-center gap-3 px-3 py-2">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-mono text-carbon truncate">{{ row.pattern }}</div>
          <div v-if="row.note" class="text-[11px] text-carbon-3 truncate">{{ row.note }}</div>
        </div>
        <UiButton
          v-if="orgWide"
          kind="ghost"
          size="sm"
          :disabled="busy"
          :data-testid="`exclusion-remove-${row.id}`"
          @click="askRemove(row)"
        >
          Remove
        </UiButton>
      </li>
    </ul>
    <p v-else class="text-[12px] text-carbon-3 mb-4">No exclusion patterns — every non-guest directory account is pickable.</p>

    <div v-if="orgWide" class="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div class="flex-1">
        <label for="exclusion-pattern" class="text-[12px] font-semibold text-carbon block mb-1">Pattern</label>
        <input
          id="exclusion-pattern"
          v-model="draftPattern"
          type="text"
          placeholder="*@yourtenant.onmicrosoft.com"
          class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white font-mono"
          data-testid="exclusion-pattern-input"
          @keyup.enter="add"
        >
      </div>
      <div class="flex-1">
        <label for="exclusion-note" class="text-[12px] font-semibold text-carbon block mb-1">Note (optional)</label>
        <input
          id="exclusion-note"
          v-model="draftNote"
          type="text"
          placeholder="Privileged/CLD admin accounts"
          class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white"
          data-testid="exclusion-note-input"
          @keyup.enter="add"
        >
      </div>
      <UiButton kind="primary" size="sm" :disabled="busy || !draftPattern.trim()" data-testid="exclusion-add" @click="add">
        Add
      </UiButton>
    </div>

    <ConfirmActionDialog
      :open="!!pendingRemove"
      eyebrow="Confirm removal"
      :title="pendingRemove ? `Remove the exclusion ${pendingRemove.pattern}?` : ''"
      confirm-label="Remove exclusion"
      testid="exclusion-remove"
      @cancel="pendingRemove = null"
      @confirm="confirmRemove"
    >
      <p>
        Accounts whose sign-in name matches it show in people-pickers again and can be made owners
        or members, unless another exclusion also matches them. You can add the pattern back at
        any time.
      </p>
    </ConfirmActionDialog>
  </UiCard>
</template>
