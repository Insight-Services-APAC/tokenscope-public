<script setup lang="ts">
/*
 * My account (#581): the identities you use, your devices, your connections,
 * how to connect a tool, how to tag a repo, and a personal subscription.
 *
 * ONE PAGE THAT NEVER SHOWS A FALSE "NONE YET". The six reads are lazy and run
 * in parallel, so the head and the section list show at once and each card
 * fills in as its read lands (app/app.vue: pages do not hold the shell for
 * data). Each read keeps its error: a failed read says it failed and offers
 * Retry (AccountReadState); only a read that LANDED can say "none yet". This
 * is the class round 1 fixed on the playbook and the allocation page
 * (DESIGN-BRIEF A5).
 *
 * Identities: a teammate adds the Claude / GitHub / client emails they use so
 * spend across all of them attributes to them (teammate_identity_map).
 * Integrity: you can't claim an identity owned by another teammate or already
 * linked (server-enforced); links are unverified and audited. See
 * docs/design/client-attribution-auth-spec.md §2.
 *
 * Devices (#576): each device can carry a name its owner gives it here. The
 * name is display only and personal: it shows wherever the device appears to
 * you, is purged after 12 months, and is never in a report or export.
 *
 * ANCHORS. Every section has one, and the old ones still work:
 * #identities, #your-devices (the inbox's "Open my devices"), #connections,
 * #connect-a-tool, #connect-copilot-cli, #tag-a-repo, #personal-subscription.
 */
// Render-boundary sanitizer for a self-registered client_name — see S6: names
// registered before the bounds fix shipped may still carry control/bidi
// characters, so this strips them defensively wherever the name is displayed.
import { computed, nextTick, ref } from 'vue'
import { sanitizeClientNameForDisplay } from '#shared/schemas/oauth'
import {
  DEVICE_NAME_MAX,
  INSTANCE_STATE_BADGE,
  INSTANCE_STATE_LABEL,
  codePointLength,
  deviceLabel,
  deviceToolName,
  type InstanceState,
} from '#shared/schemas/device-name'
import { useConnectConfig } from '../composables/useConnectConfig'
import { useViewerZone } from '../composables/useViewerZone'
import { fmtTimeAgo, fmtUsd, parseInstantMs } from '../composables/useFormat'
import { formatMonthWords } from '#shared/format/month-words'
import AccountReadState from '../components/account/ReadState.vue'

// ── Instants (a link made, a device connected) render in the viewer's zone.
// UTC on the server and through hydration, then local (useViewerZone), so the
// page never hydrates one zone's text over another's.
const { timeZone, isLocal } = useViewerZone()
function fmtTs(v: string | null): string {
  if (!v) return '—'
  const t = parseInstantMs(v)
  if (!Number.isFinite(t)) return '—'
  const s = formatMonthWords('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timeZone.value,
  }, t)
  return isLocal.value ? s : `${s} UTC`
}
function fmtDay(v: string | null): string {
  if (!v) return '—'
  const t = parseInstantMs(v)
  if (!Number.isFinite(t)) return '—'
  return formatMonthWords('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: timeZone.value }, t)
}

// ── Identities ───────────────────────────────────────────────────────────────
interface Identity {
  id: string
  system: string
  identifier: string
  kind: string
  verified: boolean
  source: string
}

const {
  data,
  pending: identitiesPending,
  error: identitiesError,
  refresh,
} = useLazyFetch<{ primary: string; identities: Identity[] }>('/api/v1/me/identities', { key: 'account-identities' })

const newSystem = ref<'claude-code' | 'github' | 'copilot-cli' | 'other'>('claude-code')
const newKind = ref<'email' | 'username'>('email')
const newIdentifier = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

async function addIdentity() {
  const identifier = newIdentifier.value.trim()
  if (!identifier) return
  busy.value = true
  error.value = null
  try {
    await $fetch('/api/v1/me/identities', {
      method: 'POST',
      body: { system: newSystem.value, identifier, identifier_kind: newKind.value },
    })
    newIdentifier.value = ''
    await refresh()
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Failed to link identity')
  } finally {
    busy.value = false
  }
}

async function removeIdentity(id: string) {
  busy.value = true
  error.value = null
  try {
    await $fetch(`/api/v1/me/identities/${id}`, { method: 'DELETE' })
    await refresh()
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Failed to remove')
  } finally {
    busy.value = false
  }
}

// ── Tag a repo's project ─────────────────────────────────────────────────────
// Tagging is the `project` MCP prompt: it lists the projects you can bill, you
// pick one, and it writes the committable `.tokenscope` + tags the repo (no code
// to type, no token). Surfaced in Claude Code as a slash command.
const {
  data: projData,
  pending: projPending,
  error: projError,
  refresh: refreshProj,
} = useLazyFetch<{ projects: { id: string; code: string; display_name: string }[] }>('/api/v1/me/projects', {
  key: 'account-projects',
})
const applyCmd = '/plugin:tokenscope:tokenscope:project'

// Install commands live in the shared ConnectClientGuide component (the single
// source for both this page and the homepage connect dialog), built from this
// deployment's connect config (#415).
const {
  config: connectConfig,
  failed: connectConfigFailed,
  isEnabled: isClientEnabled,
} = useConnectConfig()

// ── Your devices (ADR-0005 decision 3: dev spots and blocks their own) ───────
// The caller's own enrolled instances with per-device spend and anomaly flags,
// a self-service revoke that sets ts_actual_end (so /bearer 401s and emission
// stops), and a name (#576). Owner-scoped server-side (teammate_id = session).
interface MyInstance {
  instance_id: string
  tool: string
  display_name: string | null
  project: string | null
  ts_start: string
  ts_actual_end: string | null
  last_emission: string | null
  spend_usd_mtd: string
  revoked: boolean
  state: InstanceState
}
const {
  data: instData,
  pending: instPending,
  error: instError,
  refresh: refreshInstances,
} = useLazyFetch<{ instances: MyInstance[] }>('/api/v1/me/instances', { key: 'account-instances', query: { limit: 500 } })
const revokingInst = ref<Set<string>>(new Set())
const instToast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let instToastTimer: ReturnType<typeof setTimeout> | null = null
function flashInstToast(kind: 'ok' | 'err', message: string) {
  instToast.value = { kind, message }
  if (instToastTimer) clearTimeout(instToastTimer)
  instToastTimer = setTimeout(() => { instToast.value = null }, 3500)
}

async function revokeInstance(id: string) {
  if (!confirm('Revoke this device? It stops sending when its current access runs out. You can connect it again later.')) return
  revokingInst.value = new Set([...revokingInst.value, id])
  try {
    await $fetch(`/api/v1/me/instances/${id}/revoke`, { method: 'POST', body: {} })
    flashInstToast('ok', 'Device revoked. It stops sending when its current access runs out.')
    await refreshInstances()
  } catch (e: unknown) {
    flashInstToast('err', apiErrorDetail(e, 'Revoke failed.'))
  } finally {
    const next = new Set(revokingInst.value)
    next.delete(id)
    revokingInst.value = next
  }
}

// ── The fold (#592): devices nobody is using, out of the way but still live. ──
// In-use devices stay in the open list, a fault first. Not in use and revoked
// fold under one line, closed by default; the choice is not remembered.
const notInUseOpen = ref(false)
const inUseDevices = computed(() =>
  (instData.value?.instances ?? [])
    .filter((i) => i.state === 'sending' || i.state === 'idle' || i.state === 'cannot-send')
    .sort((a, b) =>
      Number(b.state === 'cannot-send') - Number(a.state === 'cannot-send')
      || (b.last_emission ?? '').localeCompare(a.last_emission ?? '')),
)
const notInUseDevices = computed(() =>
  (instData.value?.instances ?? [])
    .filter((i) => i.state === 'not-in-use')
    .sort((a, b) => (b.last_emission ?? '').localeCompare(a.last_emission ?? '')),
)
const revokedDevices = computed(() => (instData.value?.instances ?? []).filter((i) => i.state === 'revoked'))

type DeviceItem =
  | { kind: 'device'; key: string; inst: MyInstance; selectable: boolean }
  | { kind: 'fold'; key: string }
  | { kind: 'revoked-heading'; key: string }

/** One flat list, so every device renders through the same row. */
const deviceItems = computed<DeviceItem[]>(() => {
  const asItem = (inst: MyInstance, selectable = false): DeviceItem => ({ kind: 'device', key: inst.instance_id, inst, selectable })
  const items = inUseDevices.value.map((i) => asItem(i))
  if (!notInUseDevices.value.length && !revokedDevices.value.length) return items
  items.push({ kind: 'fold', key: 'fold' })
  if (notInUseOpen.value) {
    items.push(...notInUseDevices.value.map((i) => asItem(i, true)))
    if (revokedDevices.value.length) {
      items.push({ kind: 'revoked-heading', key: 'revoked' }, ...revokedDevices.value.map((i) => asItem(i)))
    }
  }
  return items
})

const bulkSelected = ref<Set<string>>(new Set())
function toggleBulk(id: string) {
  const next = new Set(bulkSelected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  bulkSelected.value = next
}
/** Ticked devices that are still in the fold; none ticked means all of them. */
const bulkTargets = computed(() => {
  const ticked = notInUseDevices.value.filter((i) => bulkSelected.value.has(i.instance_id))
  return ticked.length ? ticked : notInUseDevices.value
})
const bulkLabel = computed(() => {
  const n = bulkTargets.value.length
  return n < notInUseDevices.value.length ? `Revoke the ${n} selected` : `Revoke all ${n}`
})
const bulkRevoking = ref(false)

/**
 * One confirmation, then the existing single-revoke route once per device, so
 * each revoke is audited exactly as today and there is no new write route. A
 * failure names the device and the rest still go through.
 */
async function revokeNotInUse() {
  const targets = bulkTargets.value
  const n = targets.length
  if (!n || bulkRevoking.value) return
  const noun = n === 1 ? '1 device' : `${n} devices`
  const verb = n === 1 ? 'It stops' : 'They stop'
  if (!confirm(`Revoke ${noun}? ${verb} sending when ${n === 1 ? 'its' : 'their'} current access runs out; connecting one again is quick.`)) return
  bulkRevoking.value = true
  const failed: string[] = []
  for (const t of targets) {
    try {
      await $fetch(`/api/v1/me/instances/${t.instance_id}/revoke`, { method: 'POST', body: {} })
    } catch {
      failed.push(deviceLabel(t))
    }
  }
  bulkRevoking.value = false
  bulkSelected.value = new Set()
  await refreshInstances()
  if (failed.length) flashInstToast('err', `Revoked ${n - failed.length} of ${n}. Could not revoke: ${failed.join(', ')}.`)
  else flashInstToast('ok', n === 1 ? 'Device revoked. It stops sending when its current access runs out.' : `${n} devices revoked. They stop sending when their current access runs out.`)
}

// Inline rename (#576). One device at a time; Enter saves, Escape cancels, an
// empty name clears it. The server trims and enforces the same 40 characters.
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const renameError = ref<string | null>(null)
const renameSaving = ref(false)
const renameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
const renameTooLong = computed(() => codePointLength(renameValue.value.trim()) > DEVICE_NAME_MAX)

async function startRename(inst: MyInstance) {
  renamingId.value = inst.instance_id
  renameValue.value = inst.display_name ?? ''
  renameError.value = null
  await nextTick()
  const el = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value
  el?.focus()
}
/** After the field closes, focus goes back to that device's Rename button. */
async function closeRename(id: string) {
  renamingId.value = null
  renameError.value = null
  await nextTick()
  document.querySelector<HTMLButtonElement>(`[data-testid="instance-rename-${id}"]`)?.focus()
}
function cancelRename() {
  if (renamingId.value) void closeRename(renamingId.value)
}
async function saveRename(inst: MyInstance) {
  if (renameTooLong.value) {
    renameError.value = `${DEVICE_NAME_MAX} characters at most.`
    return
  }
  renameSaving.value = true
  renameError.value = null
  const name = renameValue.value.trim()
  try {
    await $fetch(`/api/v1/me/instances/${inst.instance_id}`, { method: 'PATCH', body: { name: name === '' ? null : name } })
    flashInstToast('ok', name ? `Device named "${name}".` : 'Device name cleared.')
    await refreshInstances()
    await closeRename(inst.instance_id)
  } catch (e: unknown) {
    renameError.value = apiErrorDetail(e, 'Could not save the name.')
  } finally {
    renameSaving.value = false
  }
}

// ── Devices awaiting confirmation (emit-on-install, slice 5) ──
// Provisional devices that emitted under YOUR claimed email BEFORE you signed in
// (the plugin enrols + emits on install, no login). Confirming one is the audited
// merge that folds its pre-sign-in usage onto your real identity — display only,
// it NEVER moves money (finance tracks the provider bill, not identity_state).
// Owner-scoped by email match server-side: only devices that claimed YOUR email
// are ever returned, so this list leaks nothing about anyone else.
interface ProvisionalInstance {
  instance_id: string
  tool: string
  device_hint: string | null
  first_seen: string
  last_seen: string | null
  provisional_spend_usd: string
}
const {
  data: provData,
  error: provError,
  refresh: refreshProvisional,
} = useLazyFetch<{ provisional_instances: ProvisionalInstance[] }>('/api/v1/me/provisional-instances', {
  key: 'account-provisional',
})
const confirmingInst = ref<Set<string>>(new Set())
const provToast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let provToastTimer: ReturnType<typeof setTimeout> | null = null
function flashProvToast(kind: 'ok' | 'err', message: string) {
  provToast.value = { kind, message }
  if (provToastTimer) clearTimeout(provToastTimer)
  provToastTimer = setTimeout(() => { provToast.value = null }, 3500)
}

async function confirmInstance(id: string) {
  if (!confirm('Confirm this device is yours? Its usage from before you signed in will be merged onto your identity. This only changes how spend is labelled; it never changes what you’re billed.')) return
  confirmingInst.value = new Set([...confirmingInst.value, id])
  try {
    await $fetch(`/api/v1/me/provisional-instances/${id}/confirm`, { method: 'POST', body: {} })
    flashProvToast('ok', 'Device confirmed. Its earlier usage is now yours.')
    // The device moves provisional → confirmed: drop it from this list and let it
    // surface under "Your devices".
    await Promise.all([refreshProvisional(), refreshInstances()])
  } catch (e: unknown) {
    flashProvToast('err', apiErrorDetail(e, 'Confirm failed.'))
  } finally {
    const next = new Set(confirmingInst.value)
    next.delete(id)
    confirmingInst.value = next
  }
}

// ── Authorized connections (oauth grants) ──
// MCP/OAuth clients the dev approved (the consent flow's grant rows). Each shows
// the client, plain-language scopes, derived state, and a Revoke. Revoking a
// read+tag grant logs that client out; revoking an emit grant ALSO stops the
// device emitting (the server cascades ts_actual_end). Owner-scoped server-side.
interface Grant {
  id: string
  client_id: string
  client_name: string
  client_registered_at: string
  scopes: string[]
  scope_labels: string[]
  state: 'active' | 'inactive' | 'revoked' | 'expired'
  created_at: string
  last_used_at: string | null
  is_emit: boolean
}
const {
  data: grantData,
  pending: grantPending,
  error: grantError,
  refresh: refreshGrants,
} = useLazyFetch<{ grants: Grant[] }>('/api/v1/me/grants', { key: 'account-grants' })
const revokingGrant = ref<Set<string>>(new Set())
const grantToast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let grantToastTimer: ReturnType<typeof setTimeout> | null = null
function flashGrantToast(kind: 'ok' | 'err', message: string) {
  grantToast.value = { kind, message }
  if (grantToastTimer) clearTimeout(grantToastTimer)
  grantToastTimer = setTimeout(() => { grantToast.value = null }, 3500)
}

function grantBadge(g: Grant): { kind: 'hunger' | 'rag-amber' | 'rag-green'; label: string } {
  switch (g.state) {
    case 'revoked': return { kind: 'hunger', label: 'Revoked' }
    case 'expired': return { kind: 'rag-amber', label: 'Expired' }
    case 'inactive': return { kind: 'rag-amber', label: 'Inactive' }
    default: return { kind: 'rag-green', label: 'Active' }
  }
}

async function revokeGrant(g: Grant) {
  // Cascade-aware confirm: emit grants stop the device emitting; read+tag grants
  // just log the client out.
  const msg = g.is_emit
    ? 'Revoke this connection? The device stops sending when its current access runs out. You can connect it again later.'
    : 'Revoke this connection? Revoking this MCP grant logs that client out. It will need to reconnect (re-consent) to use TokenScope again.'
  if (!confirm(msg)) return
  revokingGrant.value = new Set([...revokingGrant.value, g.id])
  try {
    await $fetch(`/api/v1/me/grants/${g.id}/revoke`, { method: 'POST', body: {} })
    flashGrantToast('ok', g.is_emit ? 'Connection revoked. The device stops sending when its current access runs out.' : 'Connection revoked. The client is logged out.')
    await refreshGrants()
  } catch (e: unknown) {
    flashGrantToast('err', apiErrorDetail(e, 'Revoke failed.'))
  } finally {
    const next = new Set(revokingGrant.value)
    next.delete(g.id)
    revokingGrant.value = next
  }
}

// ── Personal subscription declaration (ADR-0011 D3/D4) ──
// A teammate-level attribute, not an org one — see docs/design/
// usage-completeness-and-provider-governance.md §4.3. Declaring a tool as
// personal exempts ITS usage from the "no bill to corroborate" suspicion and
// from chargeback; it never auto-classifies (only this form ever creates one).
interface PersonalSubscriptionDeclaration {
  id: string
  tool: string
  subscriptionType: string
  monthlyCostUsd: number
  declaredAt: string
}
const {
  data: subsData,
  pending: subsPending,
  error: subsLoadError,
  refresh: refreshSubs,
} = useLazyFetch<{ declarations: PersonalSubscriptionDeclaration[] }>('/api/v1/me/personal-subscription', {
  key: 'account-personal-subscription',
})
const PERSONAL_SUB_TOOLS = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'claude-ai', label: 'Claude Chat' },
  { value: 'claude-cowork', label: 'Claude Cowork' },
  { value: 'claude-office', label: 'Claude for Office' },
  { value: 'claude-chrome', label: 'Claude for Chrome' },
  { value: 'claude-design', label: 'Claude for Design' },
  { value: 'claude-slack', label: 'Claude for Slack' },
]
const newSubTool = ref('claude-code')
const newSubType = ref('')
const newSubCost = ref<number | null>(null)
const subBusy = ref(false)
const subError = ref<string | null>(null)

async function declarePersonalSubscription() {
  if (!newSubType.value.trim() || newSubCost.value == null) return
  subBusy.value = true
  subError.value = null
  try {
    await $fetch('/api/v1/me/personal-subscription', {
      method: 'PUT',
      body: { tool: newSubTool.value, subscriptionType: newSubType.value.trim(), monthlyCostUsd: newSubCost.value },
    })
    newSubType.value = ''
    newSubCost.value = null
    await refreshSubs()
  } catch (e: unknown) {
    subError.value = apiErrorDetail(e, 'Failed to declare personal subscription')
  } finally {
    subBusy.value = false
  }
}

async function revokePersonalSubscription(tool: string) {
  subBusy.value = true
  subError.value = null
  try {
    await $fetch(`/api/v1/me/personal-subscription/${tool}`, { method: 'DELETE' })
    await refreshSubs()
  } catch (e: unknown) {
    subError.value = apiErrorDetail(e, 'Failed to revoke')
  } finally {
    subBusy.value = false
  }
}

// ── The status line and the section list ─────────────────────────────────────
// Facts only from reads that LANDED: a read still loading or failed says so,
// never a zero.
const identityCount = computed(() => (data.value ? 1 + (data.value.identities?.length ?? 0) : null))
const liveDevices = computed(() => (instData.value ? instData.value.instances.filter((i) => !i.revoked) : null))
const cannotSendCount = computed(() => liveDevices.value?.filter((i) => i.state === 'cannot-send').length ?? null)
const activeGrantCount = computed(() =>
  grantData.value ? grantData.value.grants.filter((g) => g.state !== 'revoked').length : null,
)
const statusParts = computed(() => {
  const parts: { key: string; text: string; warn?: boolean }[] = []
  if (identitiesError.value) parts.push({ key: 'id', text: "Identities couldn't be checked", warn: true })
  else if (identityCount.value != null) {
    parts.push({ key: 'id', text: `${identityCount.value} ${identityCount.value === 1 ? 'identity' : 'identities'} linked` })
  }
  if (instError.value) parts.push({ key: 'dev', text: "Devices couldn't be checked", warn: true })
  else if (liveDevices.value) {
    const n = liveDevices.value.length
    const notInUse = notInUseDevices.value.length
    const inUse = n - notInUse
    const cannot = cannotSendCount.value ?? 0
    const text = n === 0
      ? 'No devices connected'
      : [
          `${inUse} ${inUse === 1 ? 'device' : 'devices'} in use`,
          notInUse ? `${notInUse} not in use` : null,
          cannot ? `${cannot} cannot send` : null,
        ].filter(Boolean).join(' · ')
    parts.push({ key: 'dev', text, warn: cannot > 0 || n === 0 })
  }
  if (grantError.value) parts.push({ key: 'con', text: "Connections couldn't be checked", warn: true })
  else if (activeGrantCount.value != null) {
    parts.push({ key: 'con', text: `${activeGrantCount.value} ${activeGrantCount.value === 1 ? 'connection' : 'connections'}` })
  }
  return parts
})

const sections = computed(() => [
  { id: 'identities', label: 'Identities', count: identityCount.value },
  { id: 'your-devices', label: 'Devices', count: null as number | null, cannotSend: cannotSendCount.value ?? 0 },
  { id: 'connections', label: 'Connections', count: activeGrantCount.value },
  { id: 'connect-a-tool', label: 'Connect a tool', count: null },
  { id: 'tag-a-repo', label: "Tag a repo's project", count: null },
  { id: 'personal-subscription', label: 'Personal subscription', count: null },
])
</script>

<template>
  <div class="max-w-6xl mx-auto px-4 sm:px-6 py-8" data-testid="account-page">
    <UiPageHead
      eyebrow="My account"
      title="My account"
      sub="Make your spend count as yours: the identities you use, your devices and your connections."
    />

    <p
      v-if="statusParts.length"
      class="-mt-4 mb-6 text-sm text-carbon-2 flex flex-wrap gap-x-3 gap-y-1"
      data-testid="account-status"
    >
      <span
        v-for="(p, i) in statusParts"
        :key="p.key"
        :class="p.warn ? 'text-rag-amber font-semibold' : ''"
      ><span v-if="i > 0" class="text-cloud mr-3" aria-hidden="true">·</span>{{ p.text }}</span>
    </p>

    <div class="flex flex-col lg:flex-row gap-6 lg:items-start">
      <!-- The section list: above the cards on narrow screens, in view beside them on wide ones. -->
      <nav
        aria-label="On this page"
        class="lg:w-56 lg:shrink-0 lg:sticky lg:top-6 rounded-xl border border-calm-2 bg-white px-3 py-3"
        data-testid="account-sections"
      >
        <p class="px-2 text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1">On this page</p>
        <ul class="flex flex-wrap lg:flex-col gap-1">
          <li v-for="s in sections" :key="s.id">
            <a
              :href="`#${s.id}`"
              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-carbon hover:bg-brand-harmony-sheer"
              :data-testid="`account-section-link-${s.id}`"
            >
              <span>{{ s.label }}</span>
              <span v-if="s.count != null" class="text-carbon-3" style="font-variant-numeric: tabular-nums">{{ s.count }}</span>
              <UiBadge v-if="s.cannotSend" kind="rag-amber">{{ s.cannotSend }} cannot send</UiBadge>
            </a>
          </li>
        </ul>
      </nav>

      <div class="min-w-0 flex-1 space-y-5">
        <!-- Identities: primary, linked, and link another -->
        <UiCard id="identities" class="scroll-mt-6" data-testid="account-identities">
          <UiEyebrow>Identities</UiEyebrow>
          <p class="text-sm text-carbon-2 mt-1">
            Add the Claude, GitHub and client emails you use, so spend under any of them counts as yours.
          </p>
          <AccountReadState
            :loading="identitiesPending && !data"
            :error="identitiesError"
            label="your identities"
            fail-sub="We can't tell which identities are linked, so none are shown. Nothing about them has changed."
            testid="identities"
            @retry="refresh"
          >
            <ul class="mt-3 divide-y divide-calm-2" data-testid="identity-list">
              <li class="flex items-center gap-3 py-2">
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-semibold text-carbon truncate">{{ data?.primary }}</div>
                  <div class="text-[11px] text-carbon-3">Your company sign-in. It can't be removed.</div>
                </div>
                <UiBadge kind="neutral">Primary</UiBadge>
              </li>
              <li v-for="i in data?.identities ?? []" :key="i.id" class="flex items-center gap-3 py-2">
                <div class="min-w-0 flex-1">
                  <div class="text-sm text-carbon truncate">{{ i.identifier }}</div>
                  <div class="text-[11px] text-carbon-3">
                    {{ i.system }} · {{ i.kind }} ·
                    <span :class="i.verified ? 'text-rag-green' : 'text-carbon-3'">{{ i.verified ? 'verified' : 'unverified' }}</span>
                  </div>
                </div>
                <UiButton v-if="i.source === 'self'" kind="ghost" size="sm" :disabled="busy" :data-testid="`remove-${i.id}`" @click="removeIdentity(i.id)">
                  Remove
                </UiButton>
              </li>
            </ul>
            <p v-if="!data?.identities?.length" class="text-xs text-carbon-3 mt-1" data-testid="identity-none">
              No other identities linked yet.
            </p>
          </AccountReadState>

          <div class="flex flex-wrap items-end gap-2 mt-4 pt-4 border-t border-calm-2">
            <label>
              <span class="block text-xs text-carbon-3 font-bold uppercase tracking-[1px] mb-1">System</span>
              <select v-model="newSystem" class="text-sm border border-calm-2 rounded-md px-2 py-2 bg-white" data-testid="new-system">
                <option value="claude-code">Claude Code</option>
                <option value="github">GitHub</option>
                <option value="copilot-cli">Copilot</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              <span class="block text-xs text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Identifier type</span>
              <select v-model="newKind" class="text-sm border border-calm-2 rounded-md px-2 py-2 bg-white" data-testid="new-kind">
                <option value="email">Email</option>
                <option value="username">Username</option>
              </select>
            </label>
            <label class="flex-1 min-w-[220px]">
              <span class="block text-xs text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Identifier</span>
              <input
                v-model="newIdentifier"
                type="text"
                placeholder="name@example.com"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="new-identifier"
                @keyup.enter="addIdentity"
              >
            </label>
            <UiButton kind="primary" size="sm" :disabled="busy || !newIdentifier.trim()" data-testid="link-identity" @click="addIdentity">
              Link
            </UiButton>
          </div>
          <p v-if="error" class="text-xs text-rag-red mt-2" data-testid="identity-error">{{ error }}</p>
          <p class="text-[11px] text-carbon-3 mt-3">
            Linked identities are unverified and audited. You can't claim an identity that belongs to another teammate.
          </p>
        </UiCard>

        <!-- Devices -->
        <section id="your-devices" class="scroll-mt-6 space-y-5">
          <!-- Confirm-result toast lives OUTSIDE the conditional card: confirming your
               LAST provisional device empties the list and unmounts the card, so a toast
               nested inside would flash away before it's readable. -->
          <div
            v-if="provToast"
            :data-testid="`provisional-toast-${provToast.kind}`"
            class="p-2.5 rounded-md text-sm font-medium"
            :class="provToast.kind === 'ok'
              ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
              : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
          >
            {{ provToast.message }}
          </div>

          <!-- Devices awaiting confirmation: provisional emit-on-install devices that
               claimed your email before you signed in. Only rendered when there's
               something to confirm (an action list, not a persistent surface), or when
               the check itself failed. Confirming merges their pre-sign-in usage onto
               you (display only). -->
          <UiCard v-if="provError" data-testid="provisional-instances-failed">
            <UiEyebrow>Devices awaiting confirmation</UiEyebrow>
            <AccountReadState
              :loading="false"
              :error="provError"
              label="devices awaiting your confirmation"
              fail-sub="If a device started sending under your email before you signed in, it would be listed here."
              testid="provisional"
              @retry="refreshProvisional"
            />
          </UiCard>
          <UiCard
            v-else-if="provData?.provisional_instances?.length"
            class="border-brand-harmony/40"
            data-testid="provisional-instances"
          >
            <div class="flex items-center gap-2">
              <UiEyebrow>Devices awaiting confirmation</UiEyebrow>
              <UiBadge kind="rag-amber" data-testid="provisional-count">{{ provData.provisional_instances.length }}</UiBadge>
            </div>
            <p class="text-sm text-carbon-2 mt-1">
              These devices started emitting usage under your email <strong>before you signed in</strong>
              (the plugin enrols on install). Confirm the ones that are yours to fold their earlier usage
              onto your identity. This only changes how spend is <strong>labelled</strong>; it never
              changes what you're billed. Don't recognise one? Leave it unconfirmed and tell your admin.
            </p>

            <ul class="mt-3 divide-y divide-calm-2" data-testid="provisional-list">
              <li
                v-for="inst in provData.provisional_instances"
                :key="inst.instance_id"
                class="flex flex-wrap items-center gap-3 py-3"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <code class="text-[11px] bg-calm/40 px-1 rounded text-carbon">{{ inst.instance_id.slice(0, 8) }}</code>
                    <span class="text-[12px] text-carbon-2">{{ deviceToolName(inst.tool) }}</span>
                    <span v-if="inst.device_hint" class="text-[11px] text-carbon-3">· device {{ inst.device_hint }}</span>
                    <UiBadge kind="rag-amber">Provisional</UiBadge>
                  </div>
                  <div class="text-[11px] text-carbon-3 mt-1">
                    ${{ inst.provisional_spend_usd }} so far ·
                    first seen {{ fmtTs(inst.first_seen) }} ·
                    last seen {{ fmtTs(inst.last_seen) }}
                  </div>
                </div>
                <UiButton
                  kind="primary"
                  size="sm"
                  :disabled="confirmingInst.has(inst.instance_id)"
                  :data-testid="`provisional-confirm-${inst.instance_id}`"
                  @click="confirmInstance(inst.instance_id)"
                >
                  <span v-if="confirmingInst.has(inst.instance_id)">…</span>
                  <span v-else>This is mine</span>
                </UiButton>
              </li>
            </ul>
          </UiCard>

          <!-- Your devices: per-device spend, anomaly flags, a name, self-service revoke -->
          <UiCard data-testid="my-instances">
            <UiEyebrow>Your devices</UiEyebrow>
            <p class="text-sm text-carbon-2 mt-1">
              Computers and tools you have connected. Give each a name you will recognise; only you and
              your admins see it, and you can clear it at any time. If one is sending spend you don't recognise, or went quiet
              unexpectedly, revoke it. Revoking stops it sending when its current access runs out; you can connect it again later.
            </p>

            <div
              v-if="instToast"
              :data-testid="`my-instances-toast-${instToast.kind}`"
              class="mt-3 p-2.5 rounded-md text-sm font-medium"
              role="status"
              :class="instToast.kind === 'ok'
                ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
                : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
            >
              {{ instToast.message }}
            </div>

            <AccountReadState
              :loading="instPending && !instData"
              :error="instError"
              label="your devices"
              fail-sub="We can't tell whether any are connected, so nothing is shown. Your devices are not affected."
              testid="my-instances"
              @retry="refreshInstances"
            >
              <ul
                v-if="instData?.instances?.length"
                class="mt-3 divide-y divide-calm-2"
                data-testid="my-instances-list"
              >
                <template v-for="item in deviceItems" :key="item.key">
                <li v-if="item.kind === 'fold'" class="py-2" data-testid="my-instances-fold">
                  <div class="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      class="text-sm font-semibold text-brand-harmony hover:underline underline-offset-2"
                      :aria-expanded="notInUseOpen"
                      data-testid="my-instances-fold-toggle"
                      @click="notInUseOpen = !notInUseOpen"
                    >{{ notInUseOpen ? '▾' : '▸' }} Not in use ({{ notInUseDevices.length }})</button>
                    <UiButton
                      v-if="notInUseOpen && notInUseDevices.length"
                      kind="ghost"
                      size="sm"
                      :disabled="bulkRevoking"
                      data-testid="my-instances-revoke-all"
                      @click="revokeNotInUse"
                    >{{ bulkRevoking ? 'Revoking…' : bulkLabel }}</UiButton>
                  </div>
                  <p v-if="notInUseOpen && notInUseDevices.length" class="text-[11px] text-carbon-3 mt-1">
                    These may still be able to send. Revoke the ones you no longer have.
                  </p>
                </li>
                <li v-else-if="item.kind === 'revoked-heading'" class="py-2 text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3" data-testid="my-instances-revoked-heading">
                  Revoked ({{ revokedDevices.length }})
                </li>
                <li
                  v-else
                  class="flex flex-wrap items-center gap-3 py-3"
                  :data-testid="`instance-row-${item.inst.instance_id}`"
                >
                  <input
                    v-if="item.selectable"
                    type="checkbox"
                    :checked="bulkSelected.has(item.inst.instance_id)"
                    :aria-label="`Select ${deviceLabel(item.inst)}`"
                    :data-testid="`instance-select-${item.inst.instance_id}`"
                    @change="toggleBulk(item.inst.instance_id)"
                  >
                  <div class="min-w-0 flex-1">
                    <form
                      v-if="renamingId === item.inst.instance_id"
                      class="flex flex-wrap items-center gap-2"
                      :data-testid="`instance-rename-form-${item.inst.instance_id}`"
                      @submit.prevent="saveRename(item.inst)"
                    >
                      <label class="sr-only" :for="`rename-${item.inst.instance_id}`">Device name</label>
                      <input
                        :id="`rename-${item.inst.instance_id}`"
                        ref="renameInput"
                        v-model="renameValue"
                        type="text"
                        autocomplete="off"
                        :maxlength="DEVICE_NAME_MAX * 2"
                        placeholder="e.g. Work laptop"
                        class="w-64 max-w-full px-3 py-1.5 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                        :aria-invalid="renameTooLong || renameError ? 'true' : undefined"
                        :aria-describedby="`rename-help-${item.inst.instance_id}`"
                        :data-testid="`instance-rename-input-${item.inst.instance_id}`"
                        @keydown.esc.prevent="cancelRename"
                      >
                      <UiButton kind="primary" size="sm" type="submit" :disabled="renameSaving || renameTooLong" :data-testid="`instance-rename-save-${item.inst.instance_id}`">
                        {{ renameSaving ? 'Saving…' : 'Save' }}
                      </UiButton>
                      <UiButton kind="ghost" size="sm" type="button" :data-testid="`instance-rename-cancel-${item.inst.instance_id}`" @click="cancelRename">Cancel</UiButton>
                      <span
                        :id="`rename-help-${item.inst.instance_id}`"
                        class="text-[11px]"
                        :class="renameTooLong ? 'text-brand-hunger font-semibold' : 'text-carbon-3'"
                      >{{ DEVICE_NAME_MAX }} characters at most; leave it empty to clear the name.</span>
                      <p
                        v-if="renameError"
                        role="alert"
                        class="basis-full text-[11px] text-rag-red"
                        :data-testid="`instance-rename-error-${item.inst.instance_id}`"
                      >{{ renameError }}</p>
                    </form>
                    <div v-else class="flex flex-wrap items-center gap-2">
                      <span
                        v-if="item.inst.display_name"
                        class="text-sm font-semibold text-carbon"
                        :data-testid="`instance-name-${item.inst.instance_id}`"
                      >{{ item.inst.display_name }}</span>
                      <span v-else class="text-sm font-semibold text-carbon" :data-testid="`instance-name-${item.inst.instance_id}`">
                        {{ deviceToolName(item.inst.tool) }}
                        <code class="text-[11px] bg-calm/40 px-1 rounded font-normal">{{ item.inst.instance_id.slice(0, 8) }}</code>
                      </span>
                      <!-- Revoked devices too: the owner can still rename or clear a name
                           until the purge clears it (#576). -->
                      <button
                        type="button"
                        class="text-[12px] font-semibold text-brand-harmony hover:underline underline-offset-2"
                        :data-testid="`instance-rename-${item.inst.instance_id}`"
                        @click="startRename(item.inst)"
                      >{{ item.inst.display_name ? 'Rename' : 'Name this device' }}</button>
                      <UiBadge :kind="INSTANCE_STATE_BADGE[item.inst.state]" :data-testid="`instance-state-${item.inst.instance_id}`">{{ INSTANCE_STATE_LABEL[item.inst.state] }}</UiBadge>
                      <a
                        v-if="item.inst.state === 'cannot-send'"
                        href="#connect-a-tool"
                        class="text-[12px] font-semibold text-brand-harmony hover:underline"
                        :data-testid="`instance-fix-${item.inst.instance_id}`"
                      >Fix →</a>
                    </div>
                    <div class="text-[11px] text-carbon-3 mt-1">
                      {{ deviceToolName(item.inst.tool) }}
                      <template v-if="item.inst.display_name">· <code class="text-[11px]">{{ item.inst.instance_id.slice(0, 8) }}</code></template>
                      <template v-if="item.inst.project">· {{ item.inst.project }}</template>
                      · <span :data-testid="`instance-spend-${item.inst.instance_id}`">{{ fmtUsd(item.inst.spend_usd_mtd) }}</span> this month ·
                      last usage {{ item.inst.last_emission ? fmtTimeAgo(item.inst.last_emission) : 'never' }} ·
                      connected {{ fmtDay(item.inst.ts_start) }}
                    </div>
                  </div>
                  <UiButton
                    v-if="!item.inst.revoked"
                    kind="ghost"
                    size="sm"
                    :disabled="revokingInst.has(item.inst.instance_id)"
                    :data-testid="`instance-revoke-${item.inst.instance_id}`"
                    @click="revokeInstance(item.inst.instance_id)"
                  >
                    <span v-if="revokingInst.has(item.inst.instance_id)">…</span>
                    <span v-else>Revoke</span>
                  </UiButton>
                </li>
                </template>
              </ul>
              <p v-else class="text-xs text-carbon-2 mt-2" data-testid="my-instances-empty">
                No devices connected yet. <a href="#connect-a-tool" class="text-brand-harmony font-semibold hover:underline">Connect a tool</a> to start.
              </p>
            </AccountReadState>
          </UiCard>
        </section>

        <!-- Authorized connections: the OAuth/MCP grants the dev consented to -->
        <UiCard id="connections" class="scroll-mt-6" data-testid="my-grants">
          <UiEyebrow>Connections</UiEyebrow>
          <p class="text-sm text-carbon-2 mt-1">
            Clients (Claude Code and other MCP clients) you've connected to TokenScope.
            Revoking a connection logs that client out; if the connection also sends
            usage from a device, revoking stops that when its current access runs out. You can reconnect later
            (you'll be asked to consent again).
          </p>

          <div
            v-if="grantToast"
            :data-testid="`my-grants-toast-${grantToast.kind}`"
            class="mt-3 p-2.5 rounded-md text-sm font-medium"
            role="status"
            :class="grantToast.kind === 'ok'
              ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
              : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
          >
            {{ grantToast.message }}
          </div>

          <AccountReadState
            :loading="grantPending && !grantData"
            :error="grantError"
            label="your connections"
            fail-sub="We can't tell which clients are connected, so none are shown. Your connections are not affected."
            testid="my-grants"
            @retry="refreshGrants"
          >
            <ul
              v-if="grantData?.grants?.length"
              class="mt-3 divide-y divide-calm-2"
              data-testid="my-grants-list"
            >
              <li
                v-for="g in grantData.grants"
                :key="g.id"
                class="flex flex-wrap items-center gap-3 py-3"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-carbon truncate">{{ sanitizeClientNameForDisplay(g.client_name) }}</span>
                    <code
                      class="text-[10px] bg-calm/40 px-1 rounded text-carbon-3"
                      :title="`Client registered ${fmtTs(g.client_registered_at)}`"
                      :data-testid="`grant-client-id-${g.id}`"
                    >{{ g.client_id.slice(0, 8) }}</code>
                    <UiBadge
                      :kind="grantBadge(g).kind"
                      :data-testid="`grant-state-${g.id}`"
                    >{{ grantBadge(g).label }}</UiBadge>
                    <UiBadge v-if="g.is_emit" kind="rag-amber" :data-testid="`grant-emit-${g.id}`">Emits</UiBadge>
                  </div>
                  <ul class="mt-1 space-y-0.5">
                    <li v-for="(label, i) in g.scope_labels" :key="i" class="text-[11px] text-carbon-3">
                      · {{ label }}
                    </li>
                  </ul>
                  <div class="text-[11px] text-carbon-3 mt-1">
                    connected {{ fmtTs(g.created_at) }} ·
                    last used {{ g.last_used_at ? fmtTs(g.last_used_at) : 'never' }}
                  </div>
                </div>
                <UiButton
                  v-if="g.state !== 'revoked'"
                  kind="ghost"
                  size="sm"
                  :disabled="revokingGrant.has(g.id)"
                  :data-testid="`grant-revoke-${g.id}`"
                  @click="revokeGrant(g)"
                >
                  <span v-if="revokingGrant.has(g.id)">…</span>
                  <span v-else>Revoke</span>
                </UiButton>
                <span v-else class="text-[11px] text-carbon-3">—</span>
              </li>
            </ul>
            <p v-else class="text-xs text-carbon-2 mt-2" data-testid="my-grants-empty">
              No connections yet. Connect a client to TokenScope to see it here.
            </p>
          </AccountReadState>
        </UiCard>

        <!-- Connect a tool: Claude Desktop, then the Claude Code CLI (one policy client,
             two installs: the app cannot add a URL marketplace), then Copilot CLI. The
             instructions live in ConnectClientGuide so they can't drift from the
             homepage dialog. -->
        <section id="connect-a-tool" class="scroll-mt-6 space-y-5" data-testid="connect-a-tool">
          <UiCard v-if="isClientEnabled('claude-code')">
            <ConnectClientGuide kind="claude-desktop" :config="connectConfig" :failed="connectConfigFailed" />
          </UiCard>
          <UiCard v-if="isClientEnabled('claude-code')">
            <ConnectClientGuide kind="claude-cli" :config="connectConfig" :failed="connectConfigFailed" />
          </UiCard>
          <UiCard v-if="isClientEnabled('copilot-cli')" id="connect-copilot-cli" class="scroll-mt-6">
            <ConnectClientGuide kind="copilot-cli" :config="connectConfig" :failed="connectConfigFailed" />
          </UiCard>
        </section>

        <!-- Tag a repo's project (one step: writes .tokenscope + tags) -->
        <UiCard id="tag-a-repo" class="scroll-mt-6" data-testid="tag-project">
          <UiEyebrow>Tag a repo's project</UiEyebrow>
          <p class="text-sm text-carbon-2 mt-1">
            In the repo, run one command in Claude Code. It writes a committable
            <code class="text-[11px] bg-calm/40 px-1 rounded">.tokenscope</code> file
            <strong>and</strong> tags this repo. The tag travels with the repo, so everyone
            working in it attributes to the same project. You can only tag to projects you are a member of.
          </p>

          <div class="mt-4">
            <div class="flex items-center gap-2">
              <span class="text-[13px] font-bold text-carbon">Tag the repo</span>
              <span class="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand-harmony-sheer text-brand-harmony">In Claude Code</span>
            </div>
            <p class="text-[12px] text-carbon-3 mt-1">
              Run the <strong>project</strong> MCP prompt in the repo. It lists the projects you can tag to,
              you pick one, and it writes <code class="text-[11px] bg-calm/40 px-1 rounded">.tokenscope</code>
              (commit it so teammates inherit the tag) and tags this checkout:
            </p>
            <UiCodeBlock class="mt-1.5" :code="applyCmd" data-testid="apply-project-command" />
            <div class="mt-3">
              <p class="text-[12px] font-semibold text-carbon">Your project codes</p>
              <AccountReadState
                :loading="projPending && !projData"
                :error="projError"
                label="your projects"
                fail-sub="We can't tell which projects you can tag to, so none are shown."
                testid="project-codes"
                @retry="refreshProj"
              >
                <ul v-if="projData?.projects?.length" class="mt-1 space-y-0.5" data-testid="project-codes">
                  <li v-for="p in projData.projects" :key="p.id" class="text-[12px] text-carbon-2">
                    <code class="text-[11px] bg-calm/40 px-1 rounded">{{ p.code }}</code> · {{ p.display_name }}
                  </li>
                </ul>
                <p v-else class="text-[12px] text-carbon-2 mt-1" data-testid="no-project-codes">
                  You are not a member of any project yet.
                  <NuxtLink to="/projects/request" class="text-brand-harmony font-semibold hover:underline">Request a project</NuxtLink>
                  or ask a project manager to add you.
                </p>
              </AccountReadState>
            </div>
            <p class="text-[11px] text-carbon-3 mt-3">
              No token is needed for tagging: a committed <code class="text-[11px] bg-calm/40 px-1 rounded">.tokenscope</code>
              plus your connected device is enough. Teammates who clone a repo that already has one can just run
              the <strong>project</strong> MCP prompt with no project (or let the
              SessionStart hook apply it).
            </p>
          </div>
        </UiCard>

        <UiCard id="personal-subscription" class="scroll-mt-6" data-testid="personal-subscription">
          <UiEyebrow>Personal subscription</UiEyebrow>
          <p class="text-sm text-carbon-2 mt-1">
            If you pay for your own Claude subscription personally (not through Insight), declare it here.
            Declared usage stays visible in your usage (showback) and is never flagged as suspicious for
            having no Insight bill behind it. Declaring does not by itself change what is charged back:
            chargeback follows the provider bill, so usage with no Insight invoice behind it is not charged.
            Scoped exactly to the tool you declare; nothing is ever auto-classified.
          </p>

          <AccountReadState
            :loading="subsPending && !subsData"
            :error="subsLoadError"
            label="your personal subscriptions"
            fail-sub="We can't tell what you have declared, so nothing is shown. Your declarations are not affected."
            testid="personal-subscription"
            @retry="refreshSubs"
          >
            <ul v-if="subsData?.declarations?.length" class="mt-3 divide-y divide-calm-2" data-testid="personal-subscription-list">
              <li v-for="d in subsData.declarations" :key="d.id" class="py-2 flex items-center justify-between gap-2">
                <div>
                  <p class="text-[13px] font-semibold text-carbon">{{ d.tool }} · {{ d.subscriptionType }}</p>
                  <p class="text-[12px] text-carbon-3">${{ d.monthlyCostUsd.toFixed(2) }}/mo · declared {{ fmtDay(d.declaredAt) }}</p>
                </div>
                <UiButton
                  kind="ghost"
                  size="sm"
                  :disabled="subBusy"
                  :data-testid="`revoke-personal-subscription-${d.tool}`"
                  @click="revokePersonalSubscription(d.tool)"
                >
                  Revoke
                </UiButton>
              </li>
            </ul>
          </AccountReadState>

          <div class="mt-3 flex flex-wrap items-end gap-2">
            <label>
              <span class="block text-xs text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Tool</span>
              <select v-model="newSubTool" class="text-sm border border-calm-2 rounded-md px-2 py-2 bg-white" data-testid="new-sub-tool">
                <option v-for="t in PERSONAL_SUB_TOOLS" :key="t.value" :value="t.value">{{ t.label }}</option>
              </select>
            </label>
            <label class="flex-1 min-w-[10rem]">
              <span class="block text-xs text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Plan name</span>
              <input
                v-model="newSubType"
                type="text"
                placeholder="e.g. Claude Max"
                class="w-full border border-calm-2 rounded-md px-2 py-2 text-sm"
                data-testid="new-sub-type"
              >
            </label>
            <label>
              <span class="block text-xs text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Monthly cost (USD)</span>
              <input
                v-model.number="newSubCost"
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 100"
                class="w-40 border border-calm-2 rounded-md px-2 py-2 text-sm"
                data-testid="new-sub-cost"
              >
            </label>
            <UiButton
              kind="primary"
              size="sm"
              :disabled="subBusy || !newSubType.trim() || newSubCost == null"
              data-testid="declare-personal-subscription"
              @click="declarePersonalSubscription"
            >
              Declare
            </UiButton>
          </div>
          <p v-if="subError" class="text-xs text-rag-red mt-2" data-testid="personal-subscription-error">{{ subError }}</p>
        </UiCard>
      </div>
    </div>
  </div>
</template>
