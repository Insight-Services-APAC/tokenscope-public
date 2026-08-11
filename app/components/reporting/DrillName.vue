<script setup lang="ts">
/*
 * DrillName — one name, rendered as a LINK or as PLAIN TEXT, and never as a
 * button that does nothing (developer pages build D29, fix 7).
 *
 * It exists so the contract has ONE rendering as well as one rule. Before it,
 * each surface decided for itself whether a name was clickable, and the decision
 * drifted per surface: the drivers table gave every row a button, the over-cap
 * card gave none, the projects hero linked unconditionally. Three surfaces,
 * three answers, one question.
 *
 * The two states are visually distinct on purpose — a link that looks like text
 * is as bad as text that looks like a link. What they share is the CELL: the row
 * does not reflow when a viewer's grants differ.
 */
import type { DrillTarget } from './drill-contract'

defineProps<{
  /** The resolved target, or `null` for "this name opens onto nothing". */
  target: DrillTarget | null
  label: string
  /** Native tooltip (e.g. a provenance mix) — rides both states identically. */
  title?: string
}>()
</script>

<template>
  <NuxtLink
    v-if="target?.kind === 'link'"
    :to="target.to"
    class="text-carbon-1 hover:text-brand-harmony hover:underline"
    data-testid="drill-link"
    :title="title"
  ><slot>{{ label }}</slot></NuxtLink>
  <span v-else class="text-carbon-1" data-testid="drill-plain" :title="title"
  ><slot>{{ label }}</slot></span>
</template>
