// @vitest-environment happy-dom
/*
 * The signed-in footer must carry the build stamp.
 *
 * WHY THIS IS PINNED. A Container Apps revision rollout does not sign anyone
 * out, so from inside the product a successful deploy and a failed one look
 * identical. The stamp is the only in-product answer to "which build am I on",
 * and it was previously reachable ONLY from the login page — i.e. exactly the
 * one screen a signed-in operator never sees. Losing the wiring again would be
 * silent: the footer still renders, just without the one line that matters.
 *
 * The real UiBuildStamp is mounted (not a stub) so this asserts the stamp
 * actually renders inside the footer, and that an unresolved fetch renders
 * NOTHING rather than a placeholder that could be mistaken for a stale build.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import AppFooter from '../../../app/components/nav/AppFooter.vue'
import UiBuildStamp from '../../../app/components/ui/BuildStamp.vue'
import type { BuildInfo } from '../../../shared/build-info'

/** Stand in for Nuxt's auto-imported useFetch, which has no resolver in Vitest. */
function stubFetch(payload: BuildInfo | null) {
  const calls: string[] = []
  const refresh = vi.fn()
  vi.stubGlobal('useFetch', (url: string) => {
    calls.push(url)
    return { data: ref(payload), refresh }
  })
  return { calls, refresh }
}

function mountFooter() {
  return mount(AppFooter, { global: { components: { UiBuildStamp } } })
}

afterEach(() => vi.unstubAllGlobals())

describe('AppFooter build stamp', () => {
  it('renders env · version · commit from the served build info', () => {
    const { calls } = stubFetch({ environment: 'dev', version: '0.1.0', commit: 'ef57577' })
    const w = mountFooter()

    expect(w.find('[data-testid="build-stamp"]').text()).toBe('dev · v0.1.0 · ef57577')
    // The value is READ from the running container, never baked into the
    // bundle — a build-time constant would report the build that produced the
    // asset, not the revision serving it.
    expect(calls).toContain('/api/v1/meta/build')
  })

  it('omits the environment on production, where it is noise rather than signal', () => {
    stubFetch({ environment: 'production', version: '0.1.0', commit: 'ef57577' })
    expect(mountFooter().find('[data-testid="build-stamp"]').text()).toBe('v0.1.0 · ef57577')
  })

  /*
   * A revision that rolls while someone has the app open must not leave the
   * OLD commit on screen: the stamp is checked at exactly the moment a person
   * alt-tabs back from watching a deploy, and a stale answer there is worse
   * than none — it says "your deploy did not land" about a deploy that did.
   * The layout mounts once and useFetch caches by key, so without this the
   * value is frozen for the life of the tab.
   */
  it('re-reads the build info when the tab regains focus', async () => {
    const { refresh } = stubFetch({ environment: 'dev', version: '0.1.0', commit: 'ef57577' })
    mountFooter()
    expect(refresh).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does NOT re-read when the tab goes hidden (no wasted request per blur)', () => {
    const { refresh } = stubFetch({ environment: 'dev', version: '0.1.0', commit: 'ef57577' })
    mountFooter()

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('renders no stamp at all before the fetch resolves (no "unknown" placeholder)', () => {
    stubFetch(null)
    const w = mountFooter()

    expect(w.find('[data-testid="build-stamp"]').exists()).toBe(false)
    // The rest of the footer is unaffected — a stamp that cannot load must not
    // take the slogan down with it.
    expect(w.find('[data-testid="footer-slogan"]').exists()).toBe(true)
    expect(w.text()).not.toContain('unknown')
  })
})
