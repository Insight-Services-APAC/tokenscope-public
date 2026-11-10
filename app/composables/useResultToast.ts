/*
 * useResultToast: the result message an admin page shows after an action
 * (#544). Paired with AdminResultToast.vue, which renders it in live regions
 * so a screen reader announces it.
 *
 * A success clears itself after OK_MS; a refusal stays until it is dismissed
 * or replaced by the next result, because it usually asks the reader to do
 * something and 3.5 seconds (the old timeout, for both) is too short to read
 * it, let alone act (WCAG 2.2.1).
 */
import { onBeforeUnmount, ref } from 'vue'

export type ResultToastKind = 'ok' | 'err'
export interface ResultToast {
  kind: ResultToastKind
  message: string
  /** New for every result, so the same message twice is a new node and is announced again. */
  seq: number
}

export const OK_MS = 8000

export function useResultToast() {
  const toast = ref<ResultToast | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function flashToast(kind: ResultToastKind, message: string) {
    clearTimer()
    toast.value = { kind, message, seq: ++seq }
    if (kind === 'ok') timer = setTimeout(() => { toast.value = null; timer = null }, OK_MS)
  }

  function dismissToast() {
    clearTimer()
    toast.value = null
  }

  onBeforeUnmount(clearTimer)

  return { toast, flashToast, dismissToast }
}
