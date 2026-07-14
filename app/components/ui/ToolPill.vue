<script setup lang="ts">
/*
 * UiToolPill — labels the AI tool that produced a session.
 *
 * Harmony for Claude Code (primary tool in MVP-Lite), Vision for Copilot
 * CLI (deferred), Zeal for Mixed-tool sessions, neutral for Untagged.
 */

import UiBadge from './Badge.vue'

const props = defineProps<{
  tool: 'CC' | 'Cop' | 'CL' | 'Claude Code' | 'Copilot CLI' | 'Mixed'
}>()

type Variant = { label: string; kind: 'harmony' | 'vision' | 'zeal' | 'neutral' }
const map: Record<typeof props.tool, Variant> = {
  CC: { label: 'Claude Code', kind: 'harmony' },
  Cop: { label: 'Copilot CLI', kind: 'vision' },
  CL: { label: 'Untagged', kind: 'neutral' },
  'Claude Code': { label: 'Claude Code', kind: 'harmony' },
  'Copilot CLI': { label: 'Copilot CLI', kind: 'vision' },
  Mixed: { label: 'Mixed', kind: 'zeal' },
}

const entry: Variant = map[props.tool]
</script>

<template>
  <UiBadge :kind="entry.kind">{{ entry.label }}</UiBadge>
</template>
