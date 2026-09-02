/*
 * snapshotEnv — restore `process.env` after a suite mutates it, WITHOUT
 * replacing the object.
 *
 * Two constraints this exists to hold, both of which have been got wrong here:
 *
 * 1. `process.env = saved` breaks the live binding libuv reads, so later files
 *    in the same worker see one value through `process.env` and another through
 *    a native API. Restore key by key.
 * 2. An enumerated "keys I touch" list silently rots: a test added later mutates
 *    a key the list does not name, and the leak is invisible until an unrelated
 *    file fails for order-dependent reasons. So diff the whole environment
 *    instead of trusting a list.
 *
 * Vitest may run later test files in the same process, which is what makes an
 * unrestored key someone else's failure.
 *
 *   const restoreEnv = snapshotEnv()
 *   afterAll(restoreEnv)
 */
export function snapshotEnv(): () => void {
  const before = new Map<string, string | undefined>(
    Object.keys(process.env).map((k) => [k, process.env[k]]),
  )
  return () => {
    // Keys added or changed since the snapshot.
    for (const k of Object.keys(process.env)) {
      if (!before.has(k)) Reflect.deleteProperty(process.env, k)
    }
    // Keys the suite deleted or overwrote.
    for (const [k, v] of before) {
      if (v === undefined) Reflect.deleteProperty(process.env, k)
      else if (process.env[k] !== v) process.env[k] = v
    }
  }
}
