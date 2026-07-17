<script setup lang="ts">
/*
 * AdminHelpLink — a small "?" that deep-links into the Roles & terms glossary
 * at a specific anchor. Touch-friendly (a real link, not a hover tooltip) and
 * labelled for AT. Use it next to a term whose meaning is easy to confuse
 * (Cost-centre owner, Region leader, Manager, …).
 */
const props = defineProps<{ anchor: string; label: string }>()
</script>

<template>
  <NuxtLink
    :to="`/admin/help#${props.anchor}`"
    :aria-label="`What is ${props.label}? Opens the glossary.`"
    :data-testid="`help-${props.anchor}`"
    class="inline-flex items-center justify-center w-4 h-4 rounded-full border border-carbon-3/40 text-[10px] font-bold leading-none text-carbon-3 no-underline align-middle hover:border-brand-harmony hover:text-brand-harmony focus-visible:outline-2 focus-visible:outline-brand-harmony"
  >?</NuxtLink>
</template>
