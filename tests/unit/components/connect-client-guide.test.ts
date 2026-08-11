// @vitest-environment happy-dom
/*
 * ConnectClientGuide — the single source of truth for per-client connect
 * instructions. Phase-6 contract: the Copilot path now has a VERIFY step (it
 * previously ended at provisioning with no "confirm it worked" signal, unlike
 * Claude's step 5), and both paths reference the shipped colon-form commands.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConnectClientGuide from '../../../app/components/connect/ConnectClientGuide.vue'

const global = { stubs: { Icon: true, UiCodeBlock: { props: ['code'], template: '<pre>{{ code }}</pre>' } } }

describe('ConnectClientGuide', () => {
  it('Copilot path includes a verify step referencing the tokenscope-status skill', () => {
    const w = mount(ConnectClientGuide, { props: { client: 'copilot-cli' }, global })
    const text = w.text()
    expect(text).toContain('Verify it is working')
    expect(text).toContain('tokenscope-status')
  })

  it('Claude path keeps its five-step sequence ending in /tokenscope:status', () => {
    const w = mount(ConnectClientGuide, { props: { client: 'claude-code' }, global })
    const text = w.text()
    expect(text).toContain('5. Verify it is working')
    expect(text).toContain('/tokenscope:status')
  })

  it('uses the shipped colon-form setup command, not a dashed form', () => {
    const w = mount(ConnectClientGuide, { props: { client: 'claude-code' }, global })
    const text = w.text()
    expect(text).toContain('/tokenscope:setup')
    expect(text).not.toContain('/tokenscope-setup')
  })
})
