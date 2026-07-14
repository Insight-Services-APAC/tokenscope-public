<script setup lang="ts">
/*
 * UiPageHead — sub-header on each page (eyebrow + H1 + sub + crumbs + actions).
 *
 * Crumbs are passed as an array of strings; the renderer inserts the `›`
 * separator. Actions slot is the right-hand button cluster.
 */

defineProps<{
  eyebrow?: string
  title: string
  sub?: string
  crumbs?: string[]
}>()
</script>

<template>
  <div class="flex items-end justify-between gap-6 mb-8 flex-wrap">
    <div>
      <div
        v-if="crumbs && crumbs.length"
        class="text-xs text-carbon-3 mb-2 flex items-center gap-1.5"
      >
        <template v-for="(c, i) in crumbs" :key="i">
          <span v-if="i > 0" class="text-cloud px-1.5">›</span>
          <span>{{ c }}</span>
        </template>
      </div>
      <div
        v-if="eyebrow"
        class="mb-2 text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony"
      >
        {{ eyebrow }}
      </div>
      <h1 class="text-[36px] font-bold tracking-[-1px] leading-10 m-0 text-carbon">
        {{ title }}
      </h1>
      <div
        v-if="sub"
        class="mt-2 font-slab italic text-lg leading-6 font-medium text-carbon-2"
      >
        {{ sub }}
      </div>
    </div>
    <div v-if="$slots.actions" class="flex items-center gap-3">
      <slot name="actions" />
    </div>
  </div>
</template>
