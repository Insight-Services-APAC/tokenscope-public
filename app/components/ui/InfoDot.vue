<script setup lang="ts">
/*
 * InfoDot — the (i) affordance the dashboard-prose ruling rides on (developer
 * pages build D12; owner 2026-08-04, prototype `info()` :210-212): "the
 * dashboard shows data; prose opens on demand". Every explanatory sentence a
 * card needs goes in this popover; the card body carries data.
 *
 * Behaviour, per the prototype (`:141-143`): a 15px (i) opening an anchored
 * popover on hover OR focus-within. Keyboard contract: the trigger is a real
 * <button> (reachable without a bespoke tabindex), Escape closes the popover
 * without moving focus, and `aria-expanded` tracks the open state. The
 * `label` prop is REQUIRED — an unlabelled icon-only button is a mystery
 * to assistive tech.
 *
 * Focus-out closes only when focus genuinely LEAVES the component, so a
 * link inside the popover prose can be tabbed to without the popover
 * snapping shut under the caret.
 */
import { ref } from 'vue'

defineProps<{
  /** REQUIRED accessible name for the trigger (e.g. "About session economics"). */
  label: string
}>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function onFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (!next || !root.value?.contains(next)) open.value = false
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation()
    open.value = false
  }
}
</script>

<template>
  <span
    ref="root"
    class="relative inline-flex align-middle"
    data-testid="info-dot"
    @mouseenter="open = true"
    @mouseleave="open = false"
    @focusin="open = true"
    @focusout="onFocusOut"
    @keydown="onKeydown"
  >
    <button
      type="button"
      class="inline-flex h-[15px] w-[15px] items-center justify-center rounded-full
             border-[1.2px] border-carbon-3 text-[9.5px] font-extrabold not-italic
             leading-none text-carbon-3 hover:border-brand-harmony hover:text-brand-harmony
             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-harmony"
      :aria-label="label"
      :aria-expanded="open"
      data-testid="info-dot-trigger"
    >i</button>

    <span
      v-show="open"
      class="absolute left-0 top-full z-20 mt-2 block w-max max-w-[24rem] rounded-lg
             border border-calm-2 bg-paper px-3 py-2.5 text-left text-[11px]
             font-normal leading-snug text-carbon-2 shadow-sm"
      role="note"
      data-testid="info-dot-popover"
    >
      <slot />
    </span>
  </span>
</template>
