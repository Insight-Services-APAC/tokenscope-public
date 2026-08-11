<script setup lang="ts">
/*
 * ConnectClientGuide — the SINGLE source of truth for per-client "connect this
 * tool to TokenScope" instructions. Rendered in two surfaces:
 *   1. the account page (inline, one card per client), and
 *   2. the homepage connect dialog (ConnectClientDialog wraps this).
 * Both consume this one component so the instructions can never drift apart.
 *
 * Prop-driven by `client`. The header is deliberately prominent — a large brand
 * logo + the client name + an accent band — so it is unmistakable which tool the
 * card is for. All copy lives in the GUIDES config below; the template is a
 * generic renderer over it (no per-client template branches).
 */
import { computed } from 'vue'
import type { ConnectClient } from '#shared/connect'
import UiCodeBlock from '../ui/CodeBlock.vue'

const props = defineProps<{
  client: ConnectClient
  /* Optional heading id — lets a wrapping dialog point aria-labelledby at it. */
  titleId?: string
}>()

/* A paragraph is a list of inline segments so we can mix plain prose with
 * monospace <code> and <strong> without v-html. Spaces are baked into the
 * string segments (templates condense whitespace, so we don't rely on it). */
type Segment = string | { code: string } | { strong: string }
type Paragraph = Segment[]

interface Step {
  title: string
  badge: string
  intro: Paragraph
  commands?: string[]
  notes?: Paragraph[]
}

interface Guide {
  /* DOM hooks preserved from the original account-page cards so existing
   * smoke/e2e selectors keep working. */
  testid: string
  cmdTestidPrefix: string
  icon: string
  name: string
  accent: string
  lead: Paragraph
  steps: Step[]
}

const GUIDES: Record<ConnectClient, Guide> = {
  'claude-code': {
    testid: 'connect-claude-code',
    cmdTestidPrefix: 'install-cmd',
    icon: 'logos:claude-icon',
    name: 'Claude Code',
    accent: '#D97757',
    lead: [
      'Connecting Claude Code is a ',
      { strong: 'five-step sequence' },
      ' — installing the plugin is only the first. You then authenticate the MCP server, provision this device to emit, restart Claude, and verify. Do ',
      { strong: 'all five' },
      '; ',
      { code: '/tokenscope:status' },
      ' goes green only once every step is done.',
    ],
    steps: [
      {
        title: '1. Install the plugin',
        badge: 'In Claude Code',
        intro: [
          'In your Claude Code session (no terminal / ',
          { code: 'claude' },
          ' CLI needed), run these ',
          { strong: 'one at a time' },
          ' — copy, run, then the next. Don\u2019t paste both together:',
        ],
        commands: [
          '/plugin marketplace add Insight-Services-APAC/tokenscope-public',
          '/plugin install tokenscope@tokenscope',
        ],
        notes: [
          [
            'When Claude Code asks for an install scope, choose ',
            { strong: 'Install for you (user scope)' },
            ' — the plugin is a personal tool that emits across all your repos. (The committed ',
            { code: '.tokenscope' },
            ' is what travels per-repo, not the plugin.)',
          ],
        ],
      },
      {
        title: '2. Authenticate the MCP server',
        badge: 'In Claude Code',
        intro: [
          'Installing the plugin does ',
          { strong: 'not' },
          ' sign you in. Run ',
          { code: '/mcp' },
          ', choose ',
          { code: 'tokenscope' },
          ', and approve the browser OAuth consent — this authorises the read + tag tools, and the next step needs it.',
        ],
        commands: ['/mcp'],
        notes: [
          [
            'If the loopback redirect cannot reach you, copy the callback URL the consent page shows back into Claude Code.',
          ],
        ],
      },
      {
        title: '3. Provision this device to emit',
        badge: 'In Claude Code',
        intro: [
          'Run ',
          { code: '/tokenscope:setup' },
          '. It provisions this device to emit usage — a local helper writes your emit config, no token to copy. This step is ',
          { strong: 'required' },
          ': skip it and the plugin is connected but stays silent.',
        ],
        commands: ['/tokenscope:setup'],
      },
      {
        title: '4. Restart Claude Code',
        badge: 'In Claude Code',
        intro: [
          'Quit and relaunch ',
          { code: 'claude' },
          ' — the telemetry config is read only at startup, so emitting begins on your next session.',
        ],
      },
      {
        title: '5. Verify it is working',
        badge: 'In Claude Code',
        intro: [
          'Run ',
          { code: '/tokenscope:status' },
          '. It should report ',
          { strong: 'green' },
          ' — MCP connected and this device emitting. Ingestion takes ~4–5 min, so allow a few minutes after the restart before it flips green.',
        ],
        commands: ['/tokenscope:status'],
      },
    ],
  },
  'copilot-cli': {
    testid: 'connect-copilot-cli',
    cmdTestidPrefix: 'copilot-install-cmd',
    icon: 'logos:github-copilot',
    name: 'Copilot CLI',
    accent: '#3e332d',
    lead: [
      'Three steps: install the plugin, run the ',
      { code: 'tokenscope-setup' },
      ' skill (one browser OAuth sign-in that authenticates and provisions this device to emit — no token to copy), then verify. It registers a TokenScope MCP server plus a usage forwarder.',
    ],
    steps: [
      {
        title: '1. Install the plugin',
        badge: 'In a terminal',
        intro: [
          'In your terminal (the ',
          { code: 'copilot' },
          ' CLI itself, not inside a session), run these ',
          { strong: 'one at a time' },
          ':',
        ],
        commands: [
          'copilot plugin marketplace add Insight-Services-APAC/tokenscope-public',
          'copilot plugin install tokenscope-copilot@tokenscope',
        ],
        notes: [
          [
            'The first registers this repo as a plugin marketplace; the second installs the ',
            { code: 'tokenscope-copilot' },
            ' plugin from it. Enterprise-managed orgs can instead ship it via ',
            { code: '.github-private/.github/copilot/settings.json' },
            ' (it installs on auth).',
          ],
        ],
      },
      {
        title: '2. Connect & provision emit',
        badge: 'In Copilot',
        intro: [
          'In a ',
          { code: 'copilot' },
          ' session, run the ',
          { strong: 'tokenscope-setup' },
          ' skill (type ',
          { code: '/' },
          ' to list TokenScope\u2019s skills). Copilot opens a browser OAuth sign-in; follow the skill\u2019s prompts (it runs a small local redeem helper to write your emit config). When setup completes, ',
          { strong: 'open a new terminal' },
          ' and start a fresh ',
          { code: 'copilot' },
          ' session \u2014 Copilot reads the emit config at launch, so a new shell is what loads it.',
        ],
        notes: [
          [
            { strong: 'No browser, or it didn\u2019t auto-open?' },
            ' Copilot uses a loopback callback, so the sign-in has to land back on the Copilot host. Open the authorize URL Copilot prints (on any machine) and sign in; then take the callback URL the consent page shows and open or ',
            { code: 'curl' },
            ' it ',
            { strong: 'on the Copilot host' },
            ' so the CLI receives the authorization code.',
          ],
        ],
      },
      {
        title: '3. Verify it is working',
        badge: 'In Copilot',
        intro: [
          'In your fresh ',
          { code: 'copilot' },
          ' session, run the ',
          { strong: 'tokenscope-status' },
          ' skill (type ',
          { code: '/' },
          ' to list TokenScope\u2019s skills). It should report ',
          { strong: 'green' },
          ' \u2014 emitting, landing on the server, and attributing to a project. Ingestion takes ~4\u20135 min, so allow a few minutes after your first session before it confirms.',
        ],
        notes: [
          [
            'Copilot CLI has no always-on status line (unlike Claude Code\u2019s ',
            { code: '/tokenscope:status' },
            '), so run this probe on demand whenever you want to confirm the loop \u2014 or if sessions seem to have stopped attributing.',
          ],
        ],
      },
    ],
  },
}

const guide = computed(() => GUIDES[props.client])

function isCode(seg: Segment): seg is { code: string } {
  return typeof seg === 'object' && 'code' in seg
}
function isStrong(seg: Segment): seg is { strong: string } {
  return typeof seg === 'object' && 'strong' in seg
}
</script>

<template>
  <div :data-testid="guide.testid">
    <!-- Prominent, brand-marked header — unmistakable which client this is for. -->
    <div
      class="flex items-center gap-3 pb-3 mb-4 border-b-2"
      :style="{ borderBottomColor: guide.accent }"
    >
      <span
        class="grid place-items-center w-12 h-12 rounded-xl shrink-0"
        :style="{ backgroundColor: `${guide.accent}1A` }"
        aria-hidden="true"
      >
        <Icon :name="guide.icon" class="text-[26px]" />
      </span>
      <div class="min-w-0">
        <p
          class="text-[11px] font-bold uppercase tracking-[1.4px]"
          :style="{ color: guide.accent }"
        >
          Connect · once per machine
        </p>
        <h3 :id="titleId" class="text-xl font-bold text-carbon leading-tight">{{ guide.name }}</h3>
      </div>
    </div>

    <p class="text-sm text-carbon-2">
      <template v-for="(seg, i) in guide.lead" :key="i"
        ><code v-if="isCode(seg)" class="text-[11px] bg-calm/40 px-1 rounded">{{ seg.code }}</code
        ><strong v-else-if="isStrong(seg)">{{ seg.strong }}</strong
        ><template v-else>{{ seg }}</template></template
      >
    </p>

    <div v-for="(step, si) in guide.steps" :key="si" class="mt-4">
      <div class="flex items-center gap-2">
        <span class="text-[13px] font-bold text-carbon">{{ step.title }}</span>
        <span
          class="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded text-white"
          :style="{ backgroundColor: guide.accent }"
          >{{ step.badge }}</span
        >
      </div>

      <p class="text-[12px] text-carbon-3 mt-1">
        <template v-for="(seg, i) in step.intro" :key="i"
          ><code v-if="isCode(seg)" class="text-[11px] bg-calm/40 px-1 rounded">{{ seg.code }}</code
          ><strong v-else-if="isStrong(seg)">{{ seg.strong }}</strong
          ><template v-else>{{ seg }}</template></template
        >
      </p>

      <UiCodeBlock
        v-for="(c, ci) in step.commands"
        :key="ci"
        class="mt-1.5"
        :code="c"
        :data-testid="`${guide.cmdTestidPrefix}-${si}-${ci}`"
      />

      <p v-for="(note, ni) in step.notes" :key="ni" class="text-[12px] text-carbon-3 mt-2">
        <template v-for="(seg, i) in note" :key="i"
          ><code v-if="isCode(seg)" class="text-[11px] bg-calm/40 px-1 rounded">{{ seg.code }}</code
          ><strong v-else-if="isStrong(seg)">{{ seg.strong }}</strong
          ><template v-else>{{ seg }}</template></template
        >
      </p>
    </div>
  </div>
</template>
