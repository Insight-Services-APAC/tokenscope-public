<script setup lang="ts">
/*
 * ConfirmActionDialog: ask first before an admin action that cannot simply be
 * undone (#543): a role change, a region move, the governance cutover,
 * recording a month, removing a directory exclusion. Same shape as
 * PlaceTeammateDialog (the Business Unit move), with the body in the slot.
 *
 * useModalA11y traps focus, closes on Escape (as Cancel) and returns focus to
 * the control that opened it. Focus lands on Cancel, so a stray Enter does
 * nothing it should not.
 */
import { ref } from 'vue'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'

const props = defineProps<{
  open: boolean
  eyebrow: string
  title: string
  confirmLabel: string
  /** data-testid prefix: `${testid}-dialog`, `${testid}-cancel`, `${testid}-confirm`. */
  testid: string
}>()

const emit = defineEmits<{
  cancel: []
  confirm: []
}>()

const dialogRef = ref<HTMLElement | null>(null)
const cancelRef = ref<InstanceType<typeof UiButton> | null>(null)
useModalA11y({
  isOpen: () => props.open,
  dialogEl: dialogRef,
  firstField: cancelRef,
  onClose: () => emit('cancel'),
})
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    :data-testid="`${testid}-overlay`"
    @click.self="emit('cancel')"
  >
    <div
      ref="dialogRef"
      class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="`${testid}-title`"
      :data-testid="`${testid}-dialog`"
    >
      <div class="px-6 py-4 border-b border-calm-2">
        <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">{{ eyebrow }}</p>
        <h2 :id="`${testid}-title`" class="text-lg font-bold text-carbon mt-0.5 break-words">{{ title }}</h2>
      </div>
      <div class="px-6 py-4">
        <div class="text-sm text-carbon space-y-2" :data-testid="`${testid}-body`">
          <slot />
        </div>
        <div class="flex justify-end gap-2 mt-5">
          <UiButton ref="cancelRef" kind="ghost" :data-testid="`${testid}-cancel`" @click="emit('cancel')">Cancel</UiButton>
          <UiButton kind="primary" :data-testid="`${testid}-confirm`" @click="emit('confirm')">{{ confirmLabel }}</UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
