<script setup lang="ts">
/*
 * DrawerBodySections — the drawer body for every kind drawn from the table in
 * ./drawer-copy.ts (#573): what happened, what it means, what to do, and an
 * optional closing line. The words live in the table, not here, so a test can
 * read every kind's copy without mounting this.
 */
import { computed } from 'vue'
import { drawerCopy } from './drawer-copy'

const props = defineProps<{
  category: string
  body: Record<string, unknown>
  /** The recipient's name for the alert's device, when it has one (#576). */
  deviceName?: string | null
  /* #642: closed by the period-end sweep, so "What to do" no longer applies. */
  closed?: boolean
}>()

const copy = computed(() =>
  drawerCopy({ category: props.category, body: props.body, target_device_name: props.deviceName ?? null }),
)
</script>

<template>
  <section v-if="copy" class="space-y-5" data-testid="drawer-sections">
    <div v-for="s in copy.sections.filter((x) => !closed || x.heading !== 'What to do')" :key="s.heading">
      <h3 class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        {{ s.heading }}
      </h3>
      <p v-if="s.text" class="text-sm text-carbon-2 leading-relaxed">{{ s.text }}</p>
      <ol v-if="s.steps" class="text-sm text-carbon-2 leading-relaxed space-y-2 list-none p-0">
        <li v-for="step in s.steps" :key="step.text">
          {{ step.text }}
          <code v-if="step.code" class="text-[12px] bg-calm-2 rounded px-1.5 py-0.5 font-mono">{{ step.code }}</code>
          <template v-if="step.after"> {{ step.after }}</template>
        </li>
      </ol>
    </div>
    <div v-if="copy.detail">
      <h3 class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Details from the check
      </h3>
      <p class="text-xs text-carbon-2 leading-relaxed whitespace-pre-line" data-testid="drawer-detail">{{ copy.detail }}</p>
    </div>
    <p v-if="copy.footnote" class="text-xs text-carbon-3 leading-relaxed" data-testid="drawer-footnote">
      {{ copy.footnote }}
    </p>
  </section>
</template>
