// @vitest-environment node
/*
 * check-copilot-plugin-sync's host-consistency rules after #415.
 *
 * The Claude plugin's .mcp.json no longer carries a host: it is the
 * `${user_config.server_url}` template, and the host is the option's `default`
 * (plugin.json) mirrored by api-base.mjs's DEFAULT_API_BASE. The public build
 * empties both defaults. The check must still catch a partial host update in
 * either build.
 */
import { describe, it, expect } from 'vitest'

/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore — mjs import resolved by Vitest
const { checkApiHosts, readHostSources, CLAUDE_MCP_URL_TEMPLATE } =
  await import('../../../scripts/check-copilot-plugin-sync.mjs')
/* eslint-enable @typescript-eslint/ban-ts-comment */

const DEV = 'https://ts-internal.example.org'
const internal = {
  claudeApiBaseDefault: DEV,
  claudeOptionDefault: DEV,
  claudeMcpUrl: CLAUDE_MCP_URL_TEMPLATE,
  copilotMcpUrl: `${DEV}/api/v1/mcp`,
  copilotEnrollDefault: DEV,
  serverBundledOrigin: DEV,
  serverClaudeDefault: DEV,
}
const PUB = 'https://ts-public.example.org'
const publicBuild = {
  claudeApiBaseDefault: '',
  claudeOptionDefault: '',
  claudeMcpUrl: CLAUDE_MCP_URL_TEMPLATE,
  copilotMcpUrl: `${PUB}/api/v1/mcp`,
  copilotEnrollDefault: PUB,
  serverBundledOrigin: PUB,
  serverClaudeDefault: '',
}

describe('checkApiHosts', () => {
  it('passes this repository as committed', () => {
    const r = checkApiHosts(readHostSources(process.cwd()))
    expect(r.errors).toEqual([])
  })

  it('passes the internal shape and the public shape (empty Claude defaults)', () => {
    expect(checkApiHosts(internal).ok).toBe(true)
    expect(checkApiHosts(publicBuild).ok).toBe(true)
  })

  it('fails a literal host in the Claude .mcp.json (it would ignore server_url)', () => {
    const r = checkApiHosts({ ...internal, claudeMcpUrl: `${DEV}/api/v1/mcp` })
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/plugin\/\.mcp\.json/)
  })

  it('fails any other template in the Claude .mcp.json (a repo env could fill it)', () => {
    const r = checkApiHosts({ ...internal, claudeMcpUrl: '${TOKENSCOPE_API_BASE}/api/v1/mcp' })
    expect(r.ok).toBe(false)
  })

  it('fails when the two Claude defaults differ, including one emptied and not the other', () => {
    expect(
      checkApiHosts({ ...internal, claudeOptionDefault: 'https://other.example.com' }).ok,
    ).toBe(false)
    expect(checkApiHosts({ ...internal, claudeApiBaseDefault: '' }).ok).toBe(false)
    expect(checkApiHosts({ ...publicBuild, claudeOptionDefault: PUB }).ok).toBe(false)
  })

  it('fails when the connect dialog names a Claude default the plugin does not ship', () => {
    // The public build empties the plugin's default; a dialog still naming the
    // Copilot placeholder would tell users the plugin has a server it lacks.
    const r = checkApiHosts({ ...publicBuild, serverClaudeDefault: PUB })
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/CLAUDE_PLUGIN_DEFAULT_ORIGIN/)
    expect(checkApiHosts({ ...internal, serverClaudeDefault: '' }).ok).toBe(false)
    expect(checkApiHosts({ ...internal, serverClaudeDefault: null }).ok).toBe(false)
  })

  it('fails a missing server_url default', () => {
    expect(checkApiHosts({ ...internal, claudeOptionDefault: null }).ok).toBe(false)
  })

  it('fails when the internal Claude default and the Copilot/server hosts disagree', () => {
    const r = checkApiHosts({
      ...internal,
      claudeApiBaseDefault: 'https://x.example.com',
      claudeOptionDefault: 'https://x.example.com',
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toMatch(/differs between/)
  })

  it('still fails a split among the Copilot and server hosts in the public build', () => {
    expect(checkApiHosts({ ...publicBuild, serverBundledOrigin: DEV }).ok).toBe(false)
    expect(checkApiHosts({ ...publicBuild, copilotEnrollDefault: DEV }).ok).toBe(false)
  })
})
