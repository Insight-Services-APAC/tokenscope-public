/**
 * mcp-origin.mjs — WHERE the redeem helpers learn which server to talk to.
 *
 * The load-bearing property is a trust boundary, not a lookup: whatever this
 * resolver returns becomes the API base a one-time emit-handoff code is POSTed
 * to. A wrong answer does not merely fail, it sends a live single-use
 * credential to a host that never issued it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MODULE = '../../../plugin/scripts/mcp-origin.mjs'

async function loadFresh(): Promise<{ discoverMcpOrigin: (dir: string) => string | null }> {
  // Cache-bust so each case sees the module resolve against the current HOME.
  const mod = await import(`${MODULE}?t=${Math.random()}`)
  return mod as { discoverMcpOrigin: (dir: string) => string | null }
}

describe('discoverMcpOrigin', () => {
  let home: string
  let cwd: string
  let scripts: string
  let originalHome: string | undefined
  let originalCwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ts-mcp-home-'))
    cwd = mkdtempSync(join(tmpdir(), 'ts-mcp-repo-'))
    scripts = mkdtempSync(join(tmpdir(), 'ts-mcp-scripts-'))
    originalHome = process.env.HOME
    originalCwd = process.cwd()
    process.env.HOME = home
    process.chdir(cwd)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    for (const d of [home, cwd, scripts]) rmSync(d, { recursive: true, force: true })
  })

  it('IGNORES a repo-supplied .mcp.json in the working directory', async () => {
    // THE security property. `.mcp.json` in a checked-out repository is
    // attacker-controlled content: cloning a repo must not be able to redirect
    // where this machine posts a live handoff code. This is the same hole
    // plugin-runtime.mjs closes by refusing to restore a repo-supplied
    // TOKENSCOPE_API_BASE; a file is not a safer channel than an env var.
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: { tokenscope: { url: 'https://attacker.example/api/v1/mcp' } },
      }),
    )
    const { discoverMcpOrigin } = await loadFresh()
    expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBeNull()
  })

  it('a repo .mcp.json cannot outrank a real user-scope registration either', async () => {
    // Ordering matters as much as presence: if the repo file were merely LOWER
    // priority it would still win whenever the user has no registration, and
    // would be one reordering away from winning outright. It must not be
    // consulted at all.
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: { tokenscope: { url: 'https://attacker.example/api/v1/mcp' } },
      }),
    )
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { tokenscope: { url: 'https://real.example/api/v1/mcp' } } }),
    )
    const { discoverMcpOrigin } = await loadFresh()
    expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBe('https://real.example')
  })

  it('reads a user-scope Claude registration', async () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { tokenscope: { url: 'https://ts.example/api/v1/mcp' } } }),
    )
    const { discoverMcpOrigin } = await loadFresh()
    expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBe('https://ts.example')
  })

  it("reads THIS project's entry under projects{}", async () => {
    // Claude Code stores project-scoped servers under a per-directory key in
    // the USER's own ~/.claude.json. That file is user-scope (the human wrote
    // it by running the registration), which is why keying off cwd is safe here
    // while reading a repo's own .mcp.json is not: cwd only selects among
    // registrations the human already authored.
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: {
          [realpathSync(cwd)]: {
            mcpServers: { tokenscope: { url: 'https://nested.example/api/v1/mcp' } },
          },
        },
      }),
    )
    const { discoverMcpOrigin } = await loadFresh()
    expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBe('https://nested.example')
  })

  it("IGNORES an unrelated project's registration", async () => {
    // A developer with a production enrolment in one checkout and a sandbox in
    // another must not have the sandbox decide where production's handoff is
    // redeemed. Scanning all projects and taking the first match made the answer
    // depend on JSON key order rather than on anything the human chose.
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: {
          '/some/other/checkout': {
            mcpServers: { tokenscope: { url: 'https://other-project.example/api/v1/mcp' } },
          },
        },
      }),
    )
    const { discoverMcpOrigin } = await loadFresh()
    expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBeNull()
  })

  it("this project's entry outranks the user's global entry", async () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { tokenscope: { url: 'https://global.example/api/v1/mcp' } },
        projects: {
          [realpathSync(cwd)]: {
            mcpServers: { tokenscope: { url: 'https://scoped.example/api/v1/mcp' } },
          },
        },
      }),
    )
    const { discoverMcpOrigin } = await loadFresh()
    expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBe('https://scoped.example')
  })

  it('reads a user-scope Copilot registration', async () => {
    mkdirSync(join(home, '.copilot'), { recursive: true })
    writeFileSync(
      join(home, '.copilot', 'mcp-config.json'),
      JSON.stringify({ mcpServers: { tokenscope: { url: 'https://cop.example/api/v1/mcp' } } }),
    )
    const { discoverMcpOrigin } = await loadFresh()
    expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBe('https://cop.example')
  })

  it('falls back to the packaged bundle default last', async () => {
    writeFileSync(
      join(scripts, '.mcp.json'),
      JSON.stringify({ mcpServers: { tokenscope: { url: 'https://baked.example/api/v1/mcp' } } }),
    )
    const { discoverMcpOrigin } = await loadFresh()
    expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBe('https://baked.example')
  })

  it('prefers a user registration over the packaged default', async () => {
    // The whole point: a stock install has only the bundled file and is correct
    // by construction, but an operator who registered elsewhere must win, or
    // their handoff is minted by their server and redeemed against ours.
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { tokenscope: { url: 'https://mine.example/api/v1/mcp' } } }),
    )
    writeFileSync(
      join(scripts, '.mcp.json'),
      JSON.stringify({ mcpServers: { tokenscope: { url: 'https://baked.example/api/v1/mcp' } } }),
    )
    const { discoverMcpOrigin } = await loadFresh()
    expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBe('https://mine.example')
  })

  it('never throws on malformed, unreadable, or non-URL config', async () => {
    writeFileSync(join(home, '.claude.json'), '{ this is not json')
    mkdirSync(join(home, '.copilot'), { recursive: true })
    writeFileSync(
      join(home, '.copilot', 'mcp-config.json'),
      JSON.stringify({ mcpServers: { tokenscope: { url: 'not a url' } } }),
    )
    const { discoverMcpOrigin } = await loadFresh()
    expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBeNull()
  })

  it('returns an ORIGIN, discarding any path the registration carried', async () => {
    // The result is concatenated with '/api/v1/setup/redeem', so a retained
    // path would produce a doubled, non-existent endpoint.
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { tokenscope: { url: 'https://ts.example/deep/path/api/v1/mcp?x=1' } },
      }),
    )
    const { discoverMcpOrigin } = await loadFresh()
    expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBe('https://ts.example')
  })

  describe('co-installed clients', () => {
    // Both CLIs on one host, registered against DIFFERENT servers. A handoff
    // code is only redeemable at the server that minted it, so whichever config
    // is read first decides whether redeem succeeds or 401s against a host that
    // never issued the code.
    function registerBoth() {
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          mcpServers: { tokenscope: { url: 'https://claude-host.example/api/v1/mcp' } },
        }),
      )
      mkdirSync(join(home, '.copilot'), { recursive: true })
      writeFileSync(
        join(home, '.copilot', 'mcp-config.json'),
        JSON.stringify({
          mcpServers: { tokenscope: { url: 'https://copilot-host.example/api/v1/mcp' } },
        }),
      )
    }

    it('each client resolves its OWN registration, not whichever is checked first', async () => {
      registerBoth()
      const { discoverMcpOrigin } = await loadFresh()
      expect(discoverMcpOrigin(scripts, { client: 'copilot', home })).toBe(
        'https://copilot-host.example',
      )
      expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBe(
        'https://claude-host.example',
      )
    })

    it('falls back to the other client only when its own is absent', async () => {
      // Not merely tolerated: the other CLI's user-scope config is still
      // written by the human who ran the registration, so it beats the baked
      // bundle default, which is simply wrong for a custom install.
      writeFileSync(
        join(scripts, '.mcp.json'),
        JSON.stringify({ mcpServers: { tokenscope: { url: 'https://baked.example/api/v1/mcp' } } }),
      )
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          mcpServers: { tokenscope: { url: 'https://claude-host.example/api/v1/mcp' } },
        }),
      )
      const { discoverMcpOrigin } = await loadFresh()
      expect(discoverMcpOrigin(scripts, { client: 'copilot', home })).toBe(
        'https://claude-host.example',
      )
    })

    it('refuses to guess when the caller does not name itself', async () => {
      registerBoth()
      const { discoverMcpOrigin } = await loadFresh()
      // No default, because any default is silently wrong for one of the two
      // callers -- which is the bug. Failing at the call is the point.
      expect(() => discoverMcpOrigin(scripts, { home })).toThrow(/requires client/)
      expect(() => discoverMcpOrigin(scripts, { client: 'vscode', home })).toThrow(
        /requires client/,
      )
    })
  })

  it('ignores $HOME, because $HOME is not a trust boundary', () => {
    // The lookup resolves ~ through the passwd entry, which an env var cannot
    // move. plugin-runtime.mjs's realHome() records a live incident where a
    // leaked HOME silently broke exports; here the same leak would choose the
    // host a one-time handoff code is POSTed to.
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { tokenscope: { url: 'https://attacker.example/api/v1/mcp' } },
      }),
    )
    process.env.HOME = home

    // Control: the fixture IS a valid registration. Without this the assertion
    // below could pass simply because the file was malformed and nothing was
    // discoverable, which would prove nothing at all.
    return loadFresh().then(({ discoverMcpOrigin }) => {
      expect(discoverMcpOrigin(scripts, { client: 'claude', home })).toBe(
        'https://attacker.example',
      )
      // And the real call, which resolves its own home, must not reach it.
      expect(discoverMcpOrigin(scripts, { client: 'claude' })).not.toBe('https://attacker.example')
    })
  })
})
