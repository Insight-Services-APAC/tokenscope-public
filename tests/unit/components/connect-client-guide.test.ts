// @vitest-environment happy-dom
/*
 * ConnectClientGuide — the single source of truth for per-client connect
 * instructions, rendered from this deployment's connect config (#415).
 *
 * Pins: the default config gives the plain-English steps (#418) with the exact
 * commands; a deployment whose origin is not the plugin's baked host gets a
 * "point the plugin at this deployment" step; a missing origin is said plainly
 * instead of invented; the Copilot copy describes the usage-extension lane, not
 * the retired shell-rc forwarder (#413); the Claude guide carries a one-line
 * prerequisite per platform (#408 S9); and the steps a reader follows stay free
 * of jargon, with the reasons behind a collapsed "More detail".
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConnectClientGuide from '../../../app/components/connect/ConnectClientGuide.vue'
import { buildGuide } from '../../../app/components/connect/connect-guides'
import { DEFAULT_CLIENT_CONNECTION, ORIGIN_NOT_PINNED_REASON, COPILOT_PLUGIN_BUNDLED_ORIGIN, type ConnectConfig } from '../../../shared/connect'

// The internal build: both plugins ship with the same server.
const PLUGIN_BUNDLED_ORIGIN = COPILOT_PLUGIN_BUNDLED_ORIGIN

const global = { stubs: { Icon: true, UiCodeBlock: { props: ['code'], template: '<pre>{{ code }}</pre>' } } }

function cfg(over: Partial<ConnectConfig> = {}): ConnectConfig {
  const origin = 'origin' in over ? over.origin! : PLUGIN_BUNDLED_ORIGIN
  return {
    ...DEFAULT_CLIENT_CONNECTION,
    enabledClients: [...DEFAULT_CLIENT_CONNECTION.enabledClients],
    origin,
    originMissingReason: origin ? null : ORIGIN_NOT_PINNED_REASON,
    mcpUrl: origin ? `${origin}/api/v1/mcp` : null,
    claudeBundledOrigin: PLUGIN_BUNDLED_ORIGIN,
    copilotBundledOrigin: PLUGIN_BUNDLED_ORIGIN,
    ...over,
  }
}

function render(client: 'claude-code' | 'copilot-cli', config: ConnectConfig | null, failed = false) {
  return mount(ConnectClientGuide, { props: { client, config, failed }, global })
}

/** Every copy-button command, in page order (steps first, then the troubleshooting panel). */
function commands(w: ReturnType<typeof render>): string[] {
  return w.findAll('pre').map((p) => p.text())
}

/** The commands inside the numbered steps only. */
function stepCommands(w: ReturnType<typeof render>): string[] {
  return w.findAll('[data-testid="connect-step"] pre').map((p) => p.text())
}

function titles(w: ReturnType<typeof render>): string[] {
  return w.findAll('[data-testid="connect-step"] > div > span:first-child').map((s) => s.text())
}

/**
 * Everything a reader sees before expanding anything: the whole dialog with the
 * collapsed panels (`details`) and the exact commands (`pre` blocks and inline
 * `code`, which must stay verbatim) removed from a clone of the rendered DOM.
 */
function visibleText(w: ReturnType<typeof render>): string {
  const clone = w.element.cloneNode(true) as HTMLElement
  for (const el of clone.querySelectorAll('details, pre, code')) el.remove()
  // Text nodes joined with a space, so two adjacent blocks never fuse into one word.
  const parts: string[] = []
  const walk = (n: Node) => {
    if (n.nodeType === 3) parts.push(n.textContent ?? '')
    n.childNodes.forEach(walk)
  }
  walk(clone)
  return parts.join(' ')
}

/** Words a reader should not meet before opening "More detail". */
const JARGON = /\b(OTel|OAuth|emit|emitting|bearer|loopback|provision|MCP|telemetry|scope)\b/i
/** A code identifier (camelCase) leaking into prose. */
const IDENTIFIER = /\b[a-z]+[A-Z]\w*\b/
/** The one setting name a reader is allowed to see: the admin has to set it. */
const ALLOWED_SETTING = 'appPublicOrigin'

function expectPlain(text: string) {
  const prose = text.replaceAll(ALLOWED_SETTING, '').replaceAll('macOS', '')
  expect(prose).not.toMatch(JARGON)
  expect(prose).not.toMatch(IDENTIFIER)
}

describe('ConnectClientGuide — default config', () => {
  it('Claude: five plain steps with the exact commands, no registration step', () => {
    const w = render('claude-code', cfg())
    expect(titles(w)).toEqual([
      '1. Install the plugin',
      '2. Sign in',
      '3. Turn on tracking',
      '4. Restart Claude Code',
      '5. Check it works',
    ])
    expect(stepCommands(w)).toEqual([
      '/plugin marketplace add Insight-Services-APAC/tokenscope-public',
      '/plugin install tokenscope@tokenscope',
      '/mcp',
      '/tokenscope:setup',
      '/tokenscope:status',
    ])
    // The server URL moved into "Trouble connecting?", after the steps.
    expect(commands(w).at(-1)).toBe(PLUGIN_BUNDLED_ORIGIN)
    expect(w.text()).not.toContain('claude mcp add')
  })

  it('Claude: says where, how long, which scope to pick and what done looks like', () => {
    const w = render('claude-code', cfg())
    const text = w.text()
    expect(text).toContain('About 5 minutes · once per computer')
    expect(text).toContain('Connect Claude Code')
    expect(text).toContain('Do every step in Claude Code.')
    expect(text).toContain('When asked, choose Install for you.')
    expect(text).toContain('Green means you’re done.')
    // Location is said once, not as a badge on every step.
    expect(w.findAll('[data-testid="connect-step"] .uppercase')).toHaveLength(0)
  })

  it('Copilot: four steps, each marked with where it happens', () => {
    const w = render('copilot-cli', cfg())
    expect(titles(w)).toEqual([
      '1. Install the plugin',
      '2. Sign in and turn on tracking',
      '3. Restart Copilot',
      '4. Check it works',
    ])
    expect(w.findAll('[data-testid="connect-step"] .uppercase').map((b) => b.text())).toEqual([
      'In a terminal',
      'In Copilot',
      'In a terminal',
      'In Copilot',
    ])
    expect(w.text()).toContain('tokenscope-setup')
    // Untagged usage is fixed by tagging, not by re-running setup (which would loop).
    expect(w.text()).toContain('Status says your usage is untagged:')
    expect(w.text()).toMatch(/untagged:\s*run the\s*project\s*skill/)
    expect(w.text()).toContain('Status says it isn’t sending:')
    // Copilot names a skill after its directory: skills/status/ is "status".
    expect(w.text()).toContain('type / and run the TokenScope status skill.')
    expect(w.text()).not.toContain('tokenscope-status')
    expect(stepCommands(w)).toEqual([
      'copilot plugin marketplace add Insight-Services-APAC/tokenscope-public',
      'copilot plugin install tokenscope-copilot@tokenscope',
    ])
  })

  it('uses the shipped colon-form setup command, not a dashed form', () => {
    const text = render('claude-code', cfg()).text()
    expect(text).toContain('/tokenscope:setup')
    expect(text).not.toContain('/tokenscope-setup')
  })
})

describe('ConnectClientGuide — plain steps, reasons behind "More detail" (#418)', () => {
  it.each([
    ['claude-code', cfg()],
    ['claude-code', cfg({ origin: 'https://tokenscope.acme.example' })],
    ['copilot-cli', cfg()],
    ['copilot-cli', cfg({ origin: 'https://tokenscope.acme.example' })],
    ['claude-code', cfg({ origin: null })],
    ['copilot-cli', cfg({ origin: null })],
    ['claude-code', cfg({ claudeBundledOrigin: '', origin: null, mcpUrl: null })],
  ] as const)('%s: no jargon anywhere a reader looks before expanding', (client, config) => {
    const w = render(client, config)
    const text = visibleText(w)
    // The lead, the prerequisites and (when shown) the origin-missing alert are
    // all part of what is scanned, not only the steps.
    expect(text).toContain(buildGuide(client, config).lead.join(''))
    if (client === 'claude-code') expect(text).toContain('nothing else to install')
    if (!config.origin) expect(text).toContain(ALLOWED_SETTING)
    expectPlain(text)
  })

  it('the real origin-missing alert passes the same check', () => {
    expectPlain(ORIGIN_NOT_PINNED_REASON)
    expect(ORIGIN_NOT_PINNED_REASON).toContain(ALLOWED_SETTING)
  })

  it('the reasons are kept, collapsed, not deleted', () => {
    const w = render('claude-code', cfg())
    const details = w.findAll('[data-testid="connect-step-detail"]')
    expect(details.length).toBeGreaterThan(0)
    for (const d of details) {
      expect(d.element.tagName).toBe('DETAILS')
      expect(d.attributes('open')).toBeUndefined()
      // Visible label first, then a screen-reader suffix naming the step.
      expect(d.find('summary').text()).toMatch(/^More detail about \d+\. /)
    }
    const text = w.text()
    expect(text).toContain('user scope')
    expect(text).toContain('Installing the plugin does not sign you in.')
    expect(text).toContain('reads the tracking settings only when it starts')
    expect(text).toContain('never passes through the chat')
  })

  it('troubleshooting is one collapsed panel holding the edge cases and this deployment’s server', () => {
    const w = render('claude-code', cfg())
    const t = w.find('[data-testid="connect-troubleshooting"]')
    expect(t.element.tagName).toBe('DETAILS')
    expect(t.attributes('open')).toBeUndefined()
    expect(t.find('summary').text()).toBe('Trouble connecting?')
    expect(t.text()).toContain('winget install OpenJS.NodeJS.LTS')
    // Without Node the session-start refresh does not run, so a plugin update needs setup again.
    expect(t.text()).toContain(
      'Without it, a plugin update doesn’t update your tracking settings, so run /tokenscope:setup again after each update.',
    )
    expect(t.text()).toContain('URL is unset or invalid')
    expect(t.text()).toContain('restart once more if you see a “superseded device enrolment” warning')
    expect(t.find('[data-testid="connect-server-url"]').text()).toBe(PLUGIN_BUNDLED_ORIGIN)
  })
})

describe('ConnectClientGuide — rendered from the deployment config', () => {
  const other = 'https://tokenscope.acme.example'

  it('shows the server URL and names the marketplace source', () => {
    const w = render('claude-code', cfg({ origin: other, marketplaceSource: 'acme/ts-plugins', marketplaceRef: 'v2' }))
    expect(w.find('[data-testid="connect-server-url"]').text()).toBe(other)
    expect(w.find('[data-testid="connect-marketplace"]').text()).toContain('acme/ts-plugins')
    expect(w.find('[data-testid="connect-marketplace"]').text()).toContain('v2')
    expect(commands(w)).toContain('/plugin marketplace add acme/ts-plugins#v2')
  })

  it('Claude: a non-default origin adds a "point the plugin" step (user plugin option) and renumbers', () => {
    // #415: the plugin reads its server from the user-scope plugin option, which a
    // repository cannot set; the user pastes this deployment's ORIGIN there.
    const w = render('claude-code', cfg({ origin: other }))
    expect(titles(w)[1]).toBe('2. Point the plugin at this deployment')
    expect(titles(w).at(-1)).toBe('6. Check it works')
    expect(stepCommands(w)[2]).toBe(other)
    expect(w.text()).toContain('Configure options')
    expect(w.text()).toContain('TokenScope server URL')
    // The fallback for clients older than 2.1.207 is a visible note, not behind "More detail".
    const step = w.findAll('[data-testid="connect-step"]')[1]!
    const notes = step.findAll(':scope > p').map((p) => p.text())
    expect(notes).toContain('Needs Claude Code 2.1.207 or later.')
    expect(notes).toContain(
      `Older Claude Code? In a terminal, run: claude mcp add --transport http --scope user tokenscope ${other}/api/v1/mcp`,
    )
    expect(step.find('details').text()).not.toContain('claude mcp add')
  })

  it('Copilot: a non-default origin adds a copilot mcp add step', () => {
    const w = render('copilot-cli', cfg({ origin: other }))
    expect(titles(w)[1]).toBe('2. Point the plugin at this deployment')
    expect(stepCommands(w)).toContain(`copilot mcp add --transport http tokenscope ${other}/api/v1/mcp`)
    expect(titles(w).at(-1)).toBe('5. Check it works')
  })

  it('Copilot: a pinned ref is not silently dropped — the guide says Copilot cannot pin', () => {
    const w = render('copilot-cli', cfg({ marketplaceRef: 'v2' }))
    expect(commands(w)).toContain('copilot plugin marketplace add Insight-Services-APAC/tokenscope-public')
    expect(w.text()).toContain('no documented way to pin')
  })

  it('a missing origin is stated, never invented, and no registration step is offered', () => {
    const w = render('claude-code', cfg({ origin: null }))
    expect(w.find('[data-testid="connect-origin-missing"]').text()).toContain('appPublicOrigin')
    expect(w.find('[data-testid="connect-server-url"]').exists()).toBe(false)
    expect(w.text()).not.toContain('mcp add')
  })

  it('a client the admin has not enabled shows a notice instead of steps', () => {
    const w = render('copilot-cli', cfg({ enabledClients: ['claude-code'] }))
    expect(w.find('[data-testid="connect-client-disabled"]').exists()).toBe(true)
    expect(commands(w)).toEqual([])
  })

  it('a failed config fetch says so instead of showing guessed instructions', () => {
    const w = render('claude-code', null, true)
    expect(w.find('[data-testid="connect-config-error"]').exists()).toBe(true)
    expect(commands(w)).toEqual([])
  })

  it('shows the support link when one is set', () => {
    const w = render('claude-code', cfg({ supportUrl: 'https://help.acme.example/ts' }))
    expect(w.find('a[href="https://help.acme.example/ts"]').exists()).toBe(true)
  })
})

describe('ConnectClientGuide — a Claude plugin build that ships without a server (the public build)', () => {
  const placeholder = 'https://tokenscope.example.com'
  const pub = (over: Partial<ConnectConfig> = {}) =>
    cfg({ claudeBundledOrigin: '', copilotBundledOrigin: placeholder, ...over })

  it('always shows the "point the plugin" step, even when the origin equals the Copilot host', () => {
    const w = render('claude-code', pub({ origin: placeholder, mcpUrl: `${placeholder}/api/v1/mcp` }))
    expect(titles(w)[1]).toBe('2. Point the plugin at this deployment')
    expect(w.text()).toContain('ships without a server')
    expect(w.text()).not.toContain('built-in server')
    expect(stepCommands(w)).toContain(placeholder)
    // Copilot's build does name that host, so Copilot needs no step.
    const copilot = render('copilot-cli', pub({ origin: placeholder, mcpUrl: `${placeholder}/api/v1/mcp` }))
    expect(titles(copilot)).not.toContain('2. Point the plugin at this deployment')
  })

  it('with no known origin the step still appears, without inventing a URL', () => {
    const w = render('claude-code', pub({ origin: null, mcpUrl: null }))
    expect(titles(w)[1]).toBe('2. Point the plugin at this deployment')
    expect(w.text()).toContain('Ask your administrator for the address.')
    expect(w.text()).not.toContain('mcp add')
    expect(commands(w)).not.toContain('')
  })
})

describe('ConnectClientGuide — accessibility', () => {
  it('the steps keep their list role, and each "More detail" names its step for screen readers', () => {
    const w = render('claude-code', cfg())
    // Safari drops the list role from a list-none <ol>.
    expect(w.find('ol').attributes('role')).toBe('list')
    const steps = w.findAll('[data-testid="connect-step"]')
    for (const step of steps) {
      const title = step.find('div > span').text()
      const summary = step.find('details summary')
      if (!summary.exists()) continue
      const hidden = summary.find('.sr-only')
      expect(hidden.text()).toBe(`about ${title}`)
    }
    expect(w.findAll('summary .sr-only').length).toBeGreaterThan(1)
  })
})

describe('ConnectClientGuide — copy (#413, #408 S9)', () => {
  it('Copilot describes the usage-extension lane, not the retired shell-rc forwarder', () => {
    const w = render('copilot-cli', cfg())
    const text = w.text()
    expect(text).not.toContain('usage forwarder')
    expect(text).not.toContain('new terminal')
    expect(text).not.toContain('new shell')
    expect(text).toContain('usage extension')
    expect(titles(w)).toContain('3. Restart Copilot')
  })

  it('Claude carries a one-line prerequisite per platform', () => {
    expect(render('claude-code', cfg()).find('[data-testid="connect-prerequisites"]').text()).toBe(
      'Windows: nothing else to install. macOS / Linux: needs Node.js.',
    )
  })
})
