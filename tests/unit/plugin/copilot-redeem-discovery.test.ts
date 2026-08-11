// @vitest-environment node
/*
 * copilot-redeem.mjs — api-base resolution.
 *
 * WHY BEHAVIOURAL, NOT UNIT. discoverApiBaseFromMcpJson() is module-private and
 * resolves its search path from `import.meta.url`, so there is nothing to import
 * and calling it in-process could not exercise the path logic that is the whole
 * point. These tests copy the real scripts into a fixture plugin tree, write a
 * real .mcp.json beside it, and run the real script — the same shape a freshly
 * installed Copilot plugin has on disk.
 *
 * The observable signal is which host the script tries to reach. An unresolvable
 * .invalid TLD makes that deterministic and offline: DNS failure names the host
 * it attempted, and the "Cannot resolve a safe redeem URL" branch is the
 * distinguishable no-discovery outcome.
 *
 * WHAT THIS PROTECTS. Discovery is the ONLY thing that makes a fresh device
 * runnable without the user hand-passing --api-base, and the resolution chain
 * has already had two defects: the vendored-copy-only edit (fixed in de9b06b)
 * and `??` treating an empty TOKENSCOPE_API_BASE as authoritative, which
 * suppressed discovery entirely.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPTS = join(process.cwd(), 'plugin', 'scripts')
const DISCOVERED = 'discovered-host.invalid'

let root: string
let script: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ts-redeem-disc-'))
  mkdirSync(join(root, 'pkg'), { recursive: true })
  cpSync(SCRIPTS, join(root, 'pkg', 'scripts'), { recursive: true })
  script = join(root, 'pkg', 'scripts', 'copilot-redeem.mjs')
})

afterAll(() => {
  // Defensive: only ever remove a path we minted under the temp dir.
  if (root && root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
})

function writeMcpJson(url: string): void {
  writeFileSync(
    join(root, 'pkg', '.mcp.json'),
    JSON.stringify({ mcpServers: { tokenscope: { url } } }),
  )
}

function clearMcpJson(): void {
  rmSync(join(root, 'pkg', '.mcp.json'), { force: true })
}

/** Runs the redeem script and returns its combined output (it exits non-zero on failure). */
function run(env: Record<string, string | undefined>): string {
  try {
    return execFileSync(process.execPath, [script, '--handoff-code', 'fixture-code'], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, TOKENSCOPE_API_BASE: undefined, ...env },
      timeout: 30_000,
    })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

describe('copilot-redeem api-base resolution', () => {
  it('discovers the api base from the plugin tree .mcp.json when no flag or env is given', () => {
    writeMcpJson(`https://${DISCOVERED}/api/v1/mcp`)
    const out = run({})
    expect(out).toContain(DISCOVERED) // it actually tried the discovered origin
    expect(out).not.toContain('Cannot resolve a safe redeem URL')
  })

  it('an EMPTY TOKENSCOPE_API_BASE does not suppress discovery', () => {
    // The `??` bug: an empty string is not null, so it won the chain and the
    // fallback never ran, leaving a fresh device unable to redeem at all.
    writeMcpJson(`https://${DISCOVERED}/api/v1/mcp`)
    const out = run({ TOKENSCOPE_API_BASE: '' })
    expect(out).toContain(DISCOVERED)
    expect(out).not.toContain('Cannot resolve a safe redeem URL')
  })

  it('a whitespace-only TOKENSCOPE_API_BASE does not suppress discovery either', () => {
    writeMcpJson(`https://${DISCOVERED}/api/v1/mcp`)
    const out = run({ TOKENSCOPE_API_BASE: '   ' })
    expect(out).toContain(DISCOVERED)
  })

  it('TOKENSCOPE_API_BASE does NOT outrank discovery, because a repo can set it', () => {
    // This assertion used to run the other way round. It was wrong: Claude Code
    // merges a project's .claude/settings.local.json env over the global one,
    // so the variable is repo-settable, and this request carries a live
    // single-use handoff code whose response is a durable emit credential.
    // Letting a checked-out repository name that destination is the breach; the
    // documented local-dev override lives on --api-base, which a human types.
    writeMcpJson(`https://${DISCOVERED}/api/v1/mcp`)
    const out = run({ TOKENSCOPE_API_BASE: 'https://explicit-host.invalid' })
    expect(out).not.toContain('explicit-host.invalid')
    expect(out).toContain(DISCOVERED)
  })

  it('fails with the actionable message when there is nothing to discover', () => {
    clearMcpJson()
    const out = run({})
    expect(out).toContain('Cannot resolve a safe redeem URL')
    expect(out).toContain('--api-base')
  })

  it('a plain-http .mcp.json url is refused, and the rejected value is NOT printed', () => {
    // Discovery reads an on-disk file the user may not have written, so its
    // value is untrusted input. assertSafeEndpoint refuses http://, and the
    // refusal must not echo the endpoint (same class as CodeQL js/clear-text-logging).
    writeMcpJson(`http://${DISCOVERED}/api/v1/mcp`)
    const out = run({})
    expect(out).toContain('Cannot resolve a safe redeem URL')
    expect(out).not.toContain(DISCOVERED)
  })

  it('a malformed .mcp.json falls through to the actionable error rather than throwing', () => {
    writeFileSync(join(root, 'pkg', '.mcp.json'), '{ this is not json')
    const out = run({})
    expect(out).toContain('Cannot resolve a safe redeem URL')
    expect(out).not.toMatch(/SyntaxError|Unexpected token/)
  })
})
