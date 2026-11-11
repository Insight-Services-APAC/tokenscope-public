<script setup lang="ts">
/*
 * HomeToolStatusStrip — "are my tools sending?" on Home (#580).
 *
 * It replaces three always-on Connect buttons with one line per client this
 * deployment enables: sending (and when the last usage was), idle (grey, no
 * warning), cannot send (amber, with Fix to My account's devices), or not
 * connected (with Connect, which opens the same guide dialog as before).
 *
 * ONE LINE PER CLIENT. Claude Desktop and the Claude Code CLI are one client
 * policy with two installs, and a device row cannot yet say which install it is
 * (#454), so Claude Code is one line; when it is not connected it offers both
 * guides.
 *
 * THE SERVER'S VERDICTS, NOT THE BROWSER'S. Each device's `state` comes from
 * /me/instances (#592); this component computes no window and reads no clock.
 * Only Cannot send warns: no usage cannot tell a broken device from an unused
 * one, so idle and not-in-use devices raise nothing, and a not-in-use device is
 * not mentioned here at all. A device is shown with when its last usage was
 * recorded, which is all the strip knows: it does not claim the device is
 * sending at this moment. "Last usage" is an instant, shown relative to now in
 * the browser.
 *
 * NEVER "NOT CONNECTED" WITHOUT AN ANSWER. The read is client-only (an instant
 * relative to now has no server rendering that hydrates cleanly), so until it
 * lands the strip says it is checking; if it fails, it says it could not check
 * and still offers Connect.
 */
import { computed } from 'vue'
import type { InstanceState } from '#shared/schemas/device-name'
import { fmtTimeAgo } from '../../composables/useFormat'

type GuideKind = 'claude-desktop' | 'claude-cli' | 'copilot-cli'

interface StripInstance {
  instance_id: string
  tool: string
  display_name: string | null
  last_emission: string | null
  revoked: boolean
  state: InstanceState
}

const props = defineProps<{
  /** Which clients this deployment enables (useConnectConfig().isEnabled). */
  clients: { tool: 'claude-code' | 'copilot-cli'; enabled: boolean }[]
}>()

const emit = defineEmits<{ connect: [kind: GuideKind] }>()

// The route's own ceiling (500), newest first: a person with more live devices
// than that is not a case this strip has to meet.
const { data, pending, error, refresh } = useLazyFetch<{ instances: StripInstance[] }>('/api/v1/me/instances', {
  key: 'home-tool-status',
  query: { limit: 500 },
  server: false,
})

const NAMES: Record<string, string> = { 'claude-code': 'Claude Code', 'copilot-cli': 'Copilot CLI' }
const GUIDES: Record<string, { kind: GuideKind; label: string }[]> = {
  'claude-code': [
    { kind: 'claude-desktop', label: 'Connect Desktop' },
    { kind: 'claude-cli', label: 'Connect CLI' },
  ],
  'copilot-cli': [{ kind: 'copilot-cli', label: 'Connect' }],
}

type LineState =
  | { state: 'unknown' }
  | { state: 'none' }
  /** Every live device of this tool is not in use: the fold on My account has them. */
  | { state: 'unused' }
  | { state: 'sending'; device: string; lastUsage: string; cannotOthers: number }
  | { state: 'idle'; device: string; lastUsage: string | null; cannotOthers: number }
  | { state: 'cannot-send'; count: number }

const latest = (list: StripInstance[]) =>
  [...list].sort((a, b) => (b.last_emission ?? '').localeCompare(a.last_emission ?? ''))[0]

const lines = computed(() =>
  props.clients
    .filter((c) => c.enabled)
    .map((c) => {
      let st: LineState
      if (!data.value) st = { state: 'unknown' }
      else {
        const live = data.value.instances.filter((i) => i.tool === c.tool && !i.revoked)
        const sending = live.filter((i) => i.state === 'sending')
        const idle = live.filter((i) => i.state === 'idle')
        const cannot = live.filter((i) => i.state === 'cannot-send')
        // The line's label already names the tool, so an unnamed device
        // reads "device 77d7c923", not the tool a second time (#591).
        const device = (i: StripInstance) => i.display_name?.trim() || `device ${i.instance_id.slice(0, 8)}`
        if (!live.length) st = { state: 'none' }
        else if (sending.length) {
          const top = latest(sending)!
          st = { state: 'sending', device: device(top), lastUsage: fmtTimeAgo(top.last_emission), cannotOthers: cannot.length }
        } else if (cannot.length) {
          st = { state: 'cannot-send', count: cannot.length }
        } else if (idle.length) {
          const top = latest(idle)!
          st = {
            state: 'idle',
            device: device(top),
            lastUsage: top.last_emission ? fmtTimeAgo(top.last_emission) : null,
            cannotOthers: 0,
          }
        } else st = { state: 'unused' }
      }
      return { tool: c.tool, name: NAMES[c.tool] ?? c.tool, guides: GUIDES[c.tool] ?? [], ...st }
    }),
)
</script>

<template>
  <div
    v-if="lines.length"
    class="rounded-xl border border-calm-2 bg-white px-4 py-3 w-full sm:w-auto sm:min-w-[20rem]"
    data-testid="home-tool-status"
  >
    <div class="flex items-center justify-between gap-3 mb-1">
      <p class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3">Your tools</p>
      <p v-if="error" class="text-[11px] text-brand-hunger font-semibold" role="alert" data-testid="home-tool-status-error">
        Couldn't check your tools.
        <button type="button" class="underline hover:no-underline" data-testid="home-tool-status-retry" @click="refresh()">Retry</button>
      </p>
    </div>
    <ul class="divide-y divide-calm-2">
      <li
        v-for="l in lines"
        :key="l.tool"
        class="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm"
        :data-testid="`home-tool-${l.tool}`"
        :data-state="error ? 'unchecked' : l.state"
      >
        <span
          class="h-2 w-2 rounded-full shrink-0"
          :class="error || l.state === 'unknown' ? 'bg-cloud'
            : l.state === 'sending' ? 'bg-rag-green'
              : l.state === 'cannot-send' ? 'bg-rag-amber' : 'bg-cloud'"
          aria-hidden="true"
        />
        <span class="font-semibold text-carbon w-28 shrink-0">{{ l.name }}</span>
        <span class="min-w-0 flex-1 text-carbon-2 truncate">
          <template v-if="error">Not checked</template>
          <template v-else-if="l.state === 'unknown'">{{ pending ? 'Checking…' : 'Not checked' }}</template>
          <template v-else-if="l.state === 'none'">Not connected</template>
          <template v-else-if="l.state === 'unused'">No device in use</template>
          <template v-else-if="l.state === 'sending'">
            {{ l.device }} · last usage {{ l.lastUsage }}<span v-if="l.cannotOthers" class="text-rag-amber font-semibold"> · {{ l.cannotOthers }} cannot send</span>
          </template>
          <template v-else-if="l.state === 'idle'">
            {{ l.lastUsage ? `${l.device} · last usage ${l.lastUsage}` : 'Connected, no usage yet' }}
          </template>
          <template v-else-if="l.state === 'cannot-send'">
            <span class="text-rag-amber font-semibold">Cannot send</span>
          </template>
        </span>
        <NuxtLink
          v-if="!error && (l.state === 'cannot-send' || (l.state === 'sending' && l.cannotOthers))"
          to="/account#your-devices"
          class="text-[12px] font-semibold text-brand-harmony hover:underline shrink-0"
          :data-testid="`home-tool-fix-${l.tool}`"
        >Fix →</NuxtLink>
        <template v-if="error || l.state === 'none' || l.state === 'unused'">
          <button
            v-for="g in l.guides"
            :key="g.kind"
            type="button"
            class="shrink-0 px-2.5 py-1 rounded-md border border-calm-2 text-[12px] font-semibold text-carbon hover:bg-brand-harmony-sheer"
            :data-testid="`home-tool-connect-${g.kind}`"
            @click="emit('connect', g.kind)"
          >{{ g.label }}</button>
        </template>
      </li>
    </ul>
  </div>
</template>
