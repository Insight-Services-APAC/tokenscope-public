<script setup lang="ts">
/*
 * DrawerBodyUntagged — body content for an untagged-backlog inbox item.
 *
 * Per design-notes §Screen 7: list of untagged sessions + claim CLI
 * snippet. The retro-claim flow itself stays as a CLI command (per
 * design-notes §"What I deferred").
 *
 * Body payload fields read (all optional):
 *   - sessions   : Array<{ id: string; ts_start?: string; tokens?: number }>
 *   - amountUsd  : number
 */

const props = defineProps<{
  body: Record<string, unknown>
}>()

interface UntaggedSessionLite {
  id: string
  ts_start?: string
  tokens?: number
}

function sessions(): UntaggedSessionLite[] {
  const v = props.body.sessions
  if (Array.isArray(v)) {
    return v
      .filter((x): x is UntaggedSessionLite => typeof x === 'object' && x !== null && 'id' in x)
      .slice(0, 10)
  }
  return []
}

function num(k: string): number | null {
  const v = props.body[k]
  return typeof v === 'number' ? v : null
}

const list = sessions()
const amountUsd = num('amountUsd')
</script>

<template>
  <section class="space-y-5">
    <div v-if="list.length > 0">
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Untagged sessions ({{ list.length }})
      </div>
      <ul class="border border-calm-2 rounded-lg overflow-hidden">
        <li
          v-for="s in list"
          :key="s.id"
          class="flex items-center justify-between px-3 py-2 border-b border-calm-2 last:border-b-0 bg-white"
        >
          <span class="font-mono text-[11px] text-carbon">{{ s.id }}</span>
          <span class="text-[11px] text-carbon-3" style="font-variant-numeric: tabular-nums">
            {{ s.tokens ? (s.tokens / 1000).toFixed(1) + 'K tokens' : '—' }}
          </span>
        </li>
      </ul>
      <div
        v-if="amountUsd !== null"
        class="text-xs text-carbon-2 mt-2"
        style="font-variant-numeric: tabular-nums"
      >
        Total: ${{ amountUsd.toFixed(2) }}
      </div>
    </div>
    <div v-else class="text-xs text-carbon-3 italic">
      Session list not included in this alert; open the Spill listing for the full set.
    </div>
    <div>
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Claim via CLI
      </div>
      <pre class="text-[11px] bg-calm-2 rounded-md p-3 font-mono leading-snug overflow-x-auto"
>/tokenscope:claim &lt;conversation-id&gt; &lt;project-code&gt;</pre>
      <p class="text-xs text-carbon-3 mt-2 leading-relaxed">
        Run inside any repo for the target project. The full retro-claim
        UI ships in a later iteration.
      </p>
    </div>
  </section>
</template>
