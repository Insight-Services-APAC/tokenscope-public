// @vitest-environment happy-dom
/*
 * The sign-in page (app/pages/login.vue), #541.
 *
 * Opened from a link (`?next=` a page on this site), it says it will return
 * there, and the demo sign-in path does return there. Any other next value
 * is ignored: no line, and sign-in lands where it would anyway. The Microsoft
 * button's link is built by entraLoginHref (tests/unit/app/return-path.test.ts);
 * its handler sits behind import.meta.client, which plain Vitest leaves unset.
 *
 * Also pinned: no "Pilot" and no em dash on the page, headline unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { computed, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import LoginPage from '../../../app/pages/login.vue'

const STUBS = {
  UiEyebrow: { template: '<div><slot /></div>' },
  UiButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UiBuildStamp: { template: '<span />' },
}

let navigateTo: ReturnType<typeof vi.fn>

function mountLogin(query: Record<string, unknown>, opts: { localOnly?: boolean } = {}) {
  navigateTo = vi.fn()
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('definePageMeta', () => {})
  vi.stubGlobal('useRoute', () => ({ query }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { authDevMode: false } }))
  vi.stubGlobal('useDemoFeatures', () => ({ localOnly: opts.localOnly ?? false }))
  vi.stubGlobal('useCookie', () => ref(null))
  vi.stubGlobal('useSession', () => ({ devLogin: vi.fn(async () => ({ landing: '/landing' })) }))
  vi.stubGlobal('navigateTo', navigateTo)
  return mount(LoginPage, { global: { stubs: STUBS } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('sign-in page: return to the page you opened', () => {
  it('says it will return when next is a page on this site', () => {
    const w = mountLogin({ next: '/inbox' })
    expect(w.find('[data-testid="signin-return-note"]').text()).toBe(
      "You'll go straight back to the page you opened.",
    )
  })

  it.each([['https://evil.example/inbox'], ['//evil.example'], ['/\\evil.example'], ['/'], [undefined]])(
    'shows no return line for next=%s',
    (next) => {
      const w = mountLogin(next === undefined ? {} : { next })
      expect(w.find('[data-testid="signin-return-note"]').exists()).toBe(false)
    },
  )

  it('demo sign-in returns to a same-site next', async () => {
    const w = mountLogin({ next: '/inbox?status=open' }, { localOnly: true })
    await w.find('[data-testid="persona-developer"]').trigger('click')
    await flushPromises()
    expect(navigateTo).toHaveBeenCalledWith('/inbox?status=open')
  })

  it('demo sign-in returns to Home when Home was the page opened', async () => {
    const w = mountLogin({ next: '/' }, { localOnly: true })
    await w.find('[data-testid="persona-developer"]').trigger('click')
    await flushPromises()
    expect(navigateTo).toHaveBeenCalledWith('/')
  })

  it('demo sign-in keeps the fragment the browser carried (inbox #manage links)', async () => {
    window.history.replaceState(null, '', '/login?next=%2Fprojects%2FABC#manage')
    const w = mountLogin({ next: '/projects/ABC' }, { localOnly: true })
    await w.find('[data-testid="persona-developer"]').trigger('click')
    await flushPromises()
    expect(navigateTo).toHaveBeenCalledWith('/projects/ABC#manage')
  })

  it('demo sign-in ignores a cross-site next and uses the role landing', async () => {
    const w = mountLogin({ next: 'https://evil.example' }, { localOnly: true })
    await w.find('[data-testid="persona-developer"]').trigger('click')
    await flushPromises()
    expect(navigateTo).toHaveBeenCalledWith('/landing')
  })
})

describe('sign-in page copy', () => {
  it('has no "Pilot" and no em dash, and keeps the headline', () => {
    const text = mountLogin({}).text()
    expect(text).not.toMatch(/pilot/i)
    expect(text).not.toContain('—')
    expect(text).toContain('Track every token.')
    expect(text).toContain('Trust the developer.')
    expect(text).toContain('The budget does the teaching. TokenScope tracks the work')
  })
})
