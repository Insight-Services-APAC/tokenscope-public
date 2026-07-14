<script setup lang="ts">
/*
 * UiCard — base card primitive.
 *
 * Ported from docs/design/ux-pilot/.../chrome.jsx::Card. Accent variant
 * adds a 3px brand-coloured top border per design-notes.md. Hover variant
 * lifts the card 1px on hover.
 */

defineProps<{
  accent?: 'harmony' | 'hunger' | 'vision' | 'zeal'
  hover?: boolean
  flush?: boolean
}>()
</script>

<template>
  <div
    class="bg-white rounded-xl shadow-[0_4px_24px_rgba(88,40,115,0.08)] border border-brand-harmony/[0.04]"
    :class="[
      flush ? 'p-0' : 'p-6',
      hover &&
        'transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-[0_8px_28px_rgba(88,40,115,0.12)]',
      accent === 'harmony' && 'border-t-[3px] border-t-brand-harmony',
      accent === 'hunger' && 'border-t-[3px] border-t-brand-hunger',
      accent === 'vision' && 'border-t-[3px] border-t-brand-vision',
      accent === 'zeal' && 'border-t-[3px] border-t-brand-zeal',
    ]"
  >
    <slot />
  </div>
</template>
