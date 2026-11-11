/*
 * useViewerZone — the zone a session's INSTANT renders in (#577).
 *
 * CLAUDE.md "The clock": instants render in the viewer's zone; UTC day buckets
 * never convert. The server cannot know the viewer's zone, so a server render
 * of "14:05" would be the server's 14:05 and hydration would then disagree with
 * the browser's. So the zone is 'UTC' on the server AND through hydration, and
 * becomes the browser's own zone once mounted: the text then updates as a
 * normal reactive change, never as a hydration mismatch.
 *
 * `isLocal` says which one is in force, so a caller can mark a UTC rendering
 * as UTC rather than pass it off as local.
 *
 * This reads no clock: it only chooses how an instant the server sent is
 * written down.
 */
import { onMounted, ref } from 'vue'

export function useViewerZone() {
  const timeZone = ref('UTC')
  const isLocal = ref(false)
  onMounted(() => {
    try {
      const z = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (z) {
        timeZone.value = z
        isLocal.value = true
      }
    } catch {
      // Keep UTC: an unknown zone renders as labelled UTC, not as a guess.
    }
  })
  return { timeZone, isLocal }
}
