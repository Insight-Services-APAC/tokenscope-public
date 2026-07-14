<script setup lang="ts">
/*
 * UiBreadcrumb — LTREE-path-shaped breadcrumb.
 *
 * Each crumb is `{ label, to? }`. Crumbs with a `to` route are
 * clickable; the last crumb (or any without `to`) renders as plain
 * text. `›` separators per design-notes §Cross-screen patterns.
 *
 * Manager rollup, allocation editor, admin region all consume this
 * (Epics 11–13) — single LTREE path renderer across the app.
 */

export interface Crumb {
  label: string
  to?: string
}

defineProps<{
  crumbs: Crumb[]
}>()
</script>

<template>
  <nav
    aria-label="Breadcrumb"
    class="text-xs text-carbon-3 inline-flex items-center gap-1.5 flex-wrap"
  >
    <template v-for="(c, i) in crumbs" :key="`${i}-${c.label}`">
      <span v-if="i > 0" class="text-cloud px-1" aria-hidden="true">›</span>
      <NuxtLink
        v-if="c.to"
        :to="c.to"
        class="hover:text-brand-harmony hover:underline transition-colors"
      >
        {{ c.label }}
      </NuxtLink>
      <span v-else class="text-carbon-2 font-semibold">{{ c.label }}</span>
    </template>
  </nav>
</template>
