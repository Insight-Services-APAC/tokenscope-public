/*
 * useRefreshOnVisible — re-read a page's data when the tab regains focus.
 *
 * Extracted from UiBuildStamp, which needed it first and for the same reason:
 * a `useFetch` resolves ONCE and then caches, so anything the server decided at
 * fetch time is frozen for as long as the tab stays open. For the build stamp
 * that meant a rolled revision showing the old commit; for the personal spend
 * surfaces it meant a tab left open across a month boundary still headlined
 * "July 2026 · day 31 of 31" at 06:27 on 1 August — the month, the day count
 * and every figure under them all belonged to a month that had ended.
 *
 * Focus, not a poll: the question is asked at a moment, not continuously, and
 * an interval on every signed-in page is a request per user per tick forever.
 * The trade-off is explicit — a tab that is never left and never returned to
 * keeps its stale month until it is. Anything stronger is a polling decision,
 * and it is not this composable's to make silently.
 */
import { onMounted, onUnmounted } from 'vue'

export function useRefreshOnVisible(refresh: () => unknown): void {
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') void refresh()
  }
  // onMounted only runs client-side, so there is no `document` on the server.
  onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange))
  onUnmounted(() => document.removeEventListener('visibilitychange', onVisibilityChange))
}
