/*
 * useModalA11y — the shared dialog accessibility contract, extracted from
 * TagSessionDialog (the canonical original) and adopted by the admin dialogs.
 *
 * Encapsulates: Escape-to-close, Tab focus-trap within the dialog element,
 * focus-the-first-field on open, focus-restore on close, and the
 * keydown-listener add/remove lifecycle (with onBeforeUnmount cleanup). The
 * whole open/close body is guarded with `if (!import.meta.client) return` —
 * the immediate watch fires during SSR setup where `document` is undefined,
 * and dialogs only ever open via a client click.
 *
 * Each consumer supplies its own open-trigger (`isOpen`) and the dialog/first-
 * field refs. `onOpen` runs the per-dialog prefill/seed before focus is moved.
 */
import { watch, nextTick, onBeforeUnmount, type ComponentPublicInstance, type Ref } from 'vue'

/**
 * Resolve a template ref to something focusable: an element is itself, a
 * component instance is its root element. Returns null when neither can focus,
 * so a missing target is a no-op rather than a TypeError.
 *
 * EXPORTED FOR TEST. The watch body below is guarded by `import.meta.client`,
 * which is a Nuxt-injected per-module constant and is undefined under plain
 * Vitest — so no unit test can drive the focus call itself, and one that
 * appeared to would be asserting on a branch that never ran. This function is
 * the whole of the logic that was wrong, so it is tested directly and the
 * end-to-end behaviour is verified in a browser.
 */
export function focusTarget(v: HTMLElement | ComponentPublicInstance | null | undefined): HTMLElement | null {
  if (!v) return null
  if (v instanceof HTMLElement) return v
  const el = (v as ComponentPublicInstance).$el
  return el instanceof HTMLElement ? el : null
}

export interface UseModalA11yOpts {
  /* Reactive open-state predicate (e.g. () => props.open, () => !!props.target). */
  isOpen: () => boolean
  /* The dialog container — the focus-trap boundary. */
  dialogEl: Ref<HTMLElement | null>
  /*
   * What to focus on open (optional).
   *
   * A template `ref` on a plain element gives an HTMLElement; a template `ref`
   * on a COMPONENT gives that component's instance, which has no `.focus()`.
   * Both are accepted here and resolved by `focusTarget` below, because the
   * alternative is what the drawers actually shipped: `closeBtn as Ref<HTMLElement | null>`,
   * a cast that satisfies the typechecker and then throws
   * "opts.firstField?.value?.focus is not a function" at runtime — silently
   * losing focus-on-open AND focus-restore-on-close for keyboard users, since
   * the throw aborts the watch before `lastFocused` is ever used.
   */
  firstField?: Ref<HTMLElement | ComponentPublicInstance | null>
  /* Called when the dialog closes (typically emit('close')). */
  onClose: () => void
  /* Called on open, before focus is moved — per-dialog prefill/seed goes here. */
  onOpen?: () => void
}

export function useModalA11y(opts: UseModalA11yOpts): void {
  let lastFocused: HTMLElement | null = null

  // Escape closes; Tab cycles within the dialog (focus trap).
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      opts.onClose()
      return
    }
    if (e.key === 'Tab' && opts.dialogEl.value) {
      const focusable = Array.from(
        opts.dialogEl.value.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null)
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  watch(
    opts.isOpen,
    async (open) => {
      // DOM-only (listeners + focus). The immediate watch fires during SSR
      // setup where `document` is undefined — skip on the server. Dialogs only
      // open via a client click, so nothing is lost by deferring to the client.
      if (!import.meta.client) return
      if (open) {
        opts.onOpen?.()
        lastFocused = (document.activeElement as HTMLElement) ?? null // restore on close
        document.addEventListener('keydown', onKeydown)
        await nextTick()
        focusTarget(opts.firstField?.value)?.focus()
      } else {
        document.removeEventListener('keydown', onKeydown)
        lastFocused?.focus()
        lastFocused = null
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    if (!import.meta.client) return
    document.removeEventListener('keydown', onKeydown)
    // Restore focus if the dialog is torn down while still open (e.g. parent
    // unmounts it via v-if rather than flipping isOpen to false). When it
    // closed through the watch, lastFocused is already null so this is a no-op.
    lastFocused?.focus()
    lastFocused = null
  })
}
