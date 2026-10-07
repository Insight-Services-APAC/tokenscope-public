/*
 * shared/connect.ts — the admin "Client connection" body validation (#415).
 * Every accepted value ends up in a command a user pastes into a terminal, so the
 * rejections that matter most are whitespace and shell metacharacters.
 */
import { describe, it, expect } from 'vitest'
import {
  ClientConnectionBody,
  DEFAULT_CLIENT_CONNECTION,
  claudeMarketplaceArg,
  isValidMarketplaceSource,
  needsMcpRegistration,
} from '../../../shared/connect'

const base = {
  marketplace_source: 'Insight-Services-APAC/tokenscope-public',
  marketplace_name: 'tokenscope',
  claude_plugin: 'tokenscope',
  copilot_plugin: 'tokenscope-copilot',
  enabled_clients: ['claude-code', 'copilot-cli'],
}

describe('marketplace source', () => {
  it.each([
    'Insight-Services-APAC/tokenscope-public',
    'acme/ts.plugins',
    'https://github.com/acme/ts-plugins.git',
    'https://gitlab.acme.example:8443/group/sub/marketplace',
  ])('accepts %s', (s) => expect(isValidMarketplaceSource(s)).toBe(true))

  it.each([
    'acme',
    'acme/..',
    '-acme/repo',
    'acme/repo; rm -rf ~',
    'acme/$(id)',
    'acme/repo extra',
    'http://github.com/acme/repo',
    'https://user:pw@github.com/acme/repo',
    'https://github.com/acme/repo?x=1',
    'https://github.com/acme/repo#main',
    'https://github.com/acme/re`id`po',
    'ssh://git@github.com/acme/repo',
    './local/path',
    // cmd.exe expands %NAME% even inside quotes.
    'https://github.com/acme/%USERPROFILE%',
    'https://github.com/acme/re%20po',
  ])('rejects %s', (s) => expect(isValidMarketplaceSource(s)).toBe(false))
})

describe('ClientConnectionBody', () => {
  it('accepts the defaults and normalises optional fields to null', () => {
    const r = ClientConnectionBody.parse({ ...base, marketplace_ref: '', support_url: '' })
    expect(r.marketplace_ref).toBeNull()
    expect(r.support_url).toBeNull()
  })

  it('orders enabled clients canonically and refuses an empty set', () => {
    expect(ClientConnectionBody.parse({ ...base, enabled_clients: ['copilot-cli', 'claude-code'] }).enabled_clients)
      .toEqual(['claude-code', 'copilot-cli'])
    expect(ClientConnectionBody.safeParse({ ...base, enabled_clients: [] }).success).toBe(false)
    expect(ClientConnectionBody.safeParse({ ...base, enabled_clients: ['cursor'] }).success).toBe(false)
  })

  it.each(['Tokenscope', 'token scope', 'ts;id', '', 'a'.repeat(65)])('rejects plugin name %j', (n) => {
    expect(ClientConnectionBody.safeParse({ ...base, claude_plugin: n }).success).toBe(false)
    expect(ClientConnectionBody.safeParse({ ...base, copilot_plugin: n }).success).toBe(false)
    expect(ClientConnectionBody.safeParse({ ...base, marketplace_name: n }).success).toBe(false)
  })

  it.each(['v1.2.0', 'release/2026-10', 'main'])('accepts ref %s', (ref) => {
    expect(ClientConnectionBody.safeParse({ ...base, marketplace_ref: ref }).success).toBe(true)
  })

  it.each(['-x', '../x', 'a..b', 'x/', 'x.lock', 'a b', 'a;b', '$(id)'])('rejects ref %j', (ref) => {
    expect(ClientConnectionBody.safeParse({ ...base, marketplace_ref: ref }).success).toBe(false)
  })

  it.each(['http://help.example', 'javascript:alert(1)', 'https://x.example/"onmouseover', 'not a url', 'https://[bad'])(
    'rejects support link %j',
    (u) => expect(ClientConnectionBody.safeParse({ ...base, support_url: u }).success).toBe(false),
  )

  it('refuses unknown keys', () => {
    expect(ClientConnectionBody.safeParse({ ...base, server_url: 'https://x.example' }).success).toBe(false)
  })
})

describe('command helpers', () => {
  it('appends #ref for Claude only when pinned', () => {
    expect(claudeMarketplaceArg(DEFAULT_CLIENT_CONNECTION)).toBe('Insight-Services-APAC/tokenscope-public')
    expect(claudeMarketplaceArg({ marketplaceSource: 'a/b', marketplaceRef: 'v1' })).toBe('a/b#v1')
  })

  it('asks for MCP registration only for a known origin that is not the baked one', () => {
    const baked = 'https://baked.example'
    for (const client of ['claude-code', 'copilot-cli'] as const) {
      const b = { claudeBundledOrigin: baked, copilotBundledOrigin: baked }
      expect(needsMcpRegistration({ origin: baked, ...b }, client)).toBe(false)
      expect(needsMcpRegistration({ origin: null, ...b }, client)).toBe(false)
      expect(needsMcpRegistration({ origin: 'https://other.example', ...b }, client)).toBe(true)
    }
  })

  it('a plugin that ships WITHOUT a server always needs the step, whatever the origin', () => {
    // The public Claude build: its server_url default is empty.
    const c = { claudeBundledOrigin: '', copilotBundledOrigin: 'https://placeholder.example' }
    for (const origin of ['https://placeholder.example', 'https://other.example', null]) {
      expect(needsMcpRegistration({ ...c, origin }, 'claude-code')).toBe(true)
    }
    expect(needsMcpRegistration({ ...c, origin: 'https://placeholder.example' }, 'copilot-cli')).toBe(false)
  })
})
