/*
 * After a confirm dialog closes, useModalA11y puts focus back on the control
 * that opened it. Sometimes that control is gone (the row left the list) or
 * disabled (the action cannot be taken twice), and focus falls to the page
 * body. This moves it to a stable place instead (#543).
 */
export function focusIfLost(selector: string): void {
  if (typeof document === 'undefined') return
  const active = document.activeElement as HTMLElement | null
  const lost =
    !active ||
    active === document.body ||
    !active.isConnected ||
    (active as HTMLButtonElement).disabled === true
  if (lost) document.querySelector<HTMLElement>(selector)?.focus()
}
