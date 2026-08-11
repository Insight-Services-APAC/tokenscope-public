// @vitest-environment happy-dom
/*
 * useModalA11y's focus target — an ELEMENT ref or a COMPONENT ref.
 *
 * WHY THIS EXISTS. A template `ref` on a plain element yields an HTMLElement; a
 * template `ref` on a COMPONENT yields that component's instance, which has no
 * `.focus()`. Every dialog in the app points `firstField` at a native `<input>`
 * or `<select>` and was fine. The three DRAWERS (session, activity, provider-day)
 * point it at a `UiButton` — a component — behind a
 * `closeBtn as Ref<HTMLElement | null>` cast that satisfied the typechecker and
 * then threw at runtime:
 *
 *     TypeError: opts.firstField?.value?.focus is not a function
 *
 * Observed in the browser console on a running dev server, not inferred. The
 * throw happens inside the OPEN branch of the watch, so it takes focus-restore
 * down with it: `lastFocused` is assigned but the close branch never gets to use
 * it, and a keyboard user who opens a drawer loses their place on the page.
 *
 * WHAT THIS TEST COVERS, AND WHAT IT DOES NOT. It covers `focusTarget`, which is
 * the entire logic that was wrong. It does NOT drive the watch: that body is
 * guarded by `import.meta.client`, a Nuxt-injected per-module constant that is
 * undefined under plain Vitest, so a test that appeared to exercise the focus
 * call would be asserting on a branch that never ran — the "a test that cannot
 * fail certifies nothing" trap. The wiring is verified in a browser instead.
 *
 * MUTATION (verified): change `focusTarget` to `return v as HTMLElement | null`
 * — the component cases below return the instance instead of its element and go
 * red, while the element case stays green. That asymmetry is exactly why the
 * defect survived: the majority call site was never affected.
 */
import { describe, it, expect } from 'vitest'
import type { ComponentPublicInstance } from 'vue'
import { focusTarget } from '../../../app/composables/useModalA11y'

const asInstance = (root: unknown) => ({ $el: root }) as unknown as ComponentPublicInstance

describe('focusTarget', () => {
  it('returns a plain element unchanged', () => {
    const el = document.createElement('button')
    expect(focusTarget(el)).toBe(el)
  })

  /* The drawer case: what Vue puts in a template ref for a single-root component. */
  it('resolves a component instance to its root element', () => {
    const el = document.createElement('button')
    expect(focusTarget(asInstance(el))).toBe(el)
  })

  /* The property that makes this a fix rather than a cast: the result is
   * something `.focus()` can actually be called on. */
  it('returns something focusable, which the raw component ref is not', () => {
    const el = document.createElement('button')
    const instance = asInstance(el)
    expect(typeof (instance as unknown as { focus?: unknown }).focus).not.toBe('function')
    expect(typeof focusTarget(instance)?.focus).toBe('function')
  })

  /*
   * A component whose root is a comment node (a `v-if` that is false) or a text
   * node has no element to focus. That must be a no-op, never a throw — losing
   * the whole open branch, and with it the Escape listener and focus-restore, is
   * the failure this guard exists to prevent.
   */
  it('returns null for a component with no element root', () => {
    expect(focusTarget(asInstance(document.createComment('v-if')))).toBeNull()
    expect(focusTarget(asInstance(document.createTextNode('x')))).toBeNull()
    expect(focusTarget(asInstance(undefined))).toBeNull()
  })

  it('returns null for null and undefined', () => {
    expect(focusTarget(null)).toBeNull()
    expect(focusTarget(undefined)).toBeNull()
  })
})
