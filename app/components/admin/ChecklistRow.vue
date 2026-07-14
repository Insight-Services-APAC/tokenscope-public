<script setup lang="ts">
import { computed } from 'vue'
/*
 * ChecklistRow — single row of the Setup checklist (design-notes
 * §Screen 5 Setup-checklist tab).
 *
 * Numbered badge:
 *   done         → green + check icon
 *   in_progress  → Hunger-pink with the index number
 *   todo         → grey-empty with the index number
 *
 * CTA: when the parent supplies an `actionLabel`, the button is a live
 * deep-link — clicking it emits `action` so the page can switch to the
 * relevant tab / open the right dialog (the whole point of the checklist:
 * each row links to the thing it's asking you to do). Without an
 * `actionLabel` the button falls back to the old disabled-with-tooltip
 * placeholder (for items whose flow hasn't shipped yet).
 */

export type ChecklistStatus = 'done' | 'in_progress' | 'todo'

const props = defineProps<{
  index: number
  label: string
  sub: string
  status: ChecklistStatus
  /** When set, the CTA becomes a live deep-link emitting `action`. */
  actionLabel?: string
}>()

const emit = defineEmits<{ action: [] }>()

// Fallback label used when no actionLabel is supplied (placeholder mode).
const fallbackLabel =
  props.status === 'done' ? 'Done' : props.status === 'in_progress' ? 'Continue' : 'Start'

const ctaLabel = computed(() => props.actionLabel ?? fallbackLabel)
const actionable = computed(() => props.actionLabel != null)
</script>

<template>
  <div class="grid grid-cols-[40px_1fr_auto_120px] items-center gap-4 py-4 border-b border-calm-2 last:border-b-0" data-testid="checklist-row">
    <span
      class="w-7 h-7 rounded-full inline-flex items-center justify-center text-xs font-bold"
      :class="[
        status === 'done' && 'bg-rag-green text-white',
        status === 'in_progress' && 'bg-brand-hunger-lite text-brand-heart',
        status === 'todo' && 'bg-calm-2 text-carbon-3',
      ]"
    >
      {{ status === 'done' ? '✓' : index }}
    </span>
    <div>
      <div class="text-sm font-bold text-carbon">{{ label }}</div>
      <div class="text-[11px] text-carbon-3 mt-0.5">{{ sub }}</div>
    </div>
    <span
      class="px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.5px] rounded-md"
      :class="[
        status === 'done' && 'bg-rag-green/15 text-[#166534]',
        status === 'in_progress' && 'bg-brand-hunger-lite text-brand-heart',
        status === 'todo' && 'bg-calm-2 text-carbon-3',
      ]"
    >
      {{ status === 'done' ? 'Done' : status === 'in_progress' ? 'In progress' : 'Not started' }}
    </span>
    <button
      v-if="actionable"
      type="button"
      class="px-3 py-1.5 text-xs font-bold rounded-md transition-colors"
      :class="[
        status === 'done'
          ? 'text-carbon-2 border border-calm-2 hover:border-brand-harmony hover:text-brand-harmony'
          : 'bg-brand-harmony text-white hover:bg-brand-heart',
      ]"
      data-testid="checklist-row-action"
      @click="emit('action')"
    >
      {{ ctaLabel }}
    </button>
    <button
      v-else
      type="button"
      class="px-3 py-1.5 text-xs font-bold rounded-md"
      :class="[
        status === 'done'
          ? 'text-carbon-3 border border-calm-2 opacity-50 cursor-not-allowed'
          : 'bg-brand-harmony text-white opacity-50 cursor-not-allowed',
      ]"
      title="Setup wizards land in a later MVP-Final slice."
      disabled
    >
      {{ ctaLabel }}
    </button>
  </div>
</template>
