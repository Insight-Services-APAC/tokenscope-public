/*
 * F29 / F11 — the native-MDM probes must not spawn a bare command name.
 *
 * On Windows libuv searches the child's CWD BEFORE PATH, and these run with
 * cwd = the project root. A hostile repo committing `reg.exe` beside its README
 * therefore got it executed as the developer. `/bin/sh` was made absolute in an
 * earlier hardening pass; `reg` and `defaults` are the siblings that pass never
 * walked to — the single most useful shape in the MDASH scan.
 *
 * Both bundles, because copilot-plugin/ vendors its own copy.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// resolve() from __dirname, not a CWD-relative path: readFileSync would throw
// before a single assertion ran if the suite were ever launched from anywhere
// but the repo root (an IDE runner, a subdirectory, a future config change).
const BUNDLES = [
  ['claude lane', resolve(__dirname, '../../../plugin/scripts/managed-telemetry.mjs')],
  ['copilot lane', resolve(__dirname, '../../../copilot-plugin/scripts/managed-telemetry.mjs')],
] as const

describe.each(BUNDLES)('%s — native MDM probes spawn absolute paths', (_label, path) => {
  const src = readFileSync(path, 'utf8')

  it('never spawns a bare `reg`', () => {
    expect(src, 'bare `reg` is resolved from CWD before PATH on Windows').not.toMatch(
      /exec\(\s*['"]reg['"]/,
    )
    expect(src).toMatch(/exec\(REG_EXE,/)
  })

  it('builds the reg.exe path from a LITERAL, never from the environment', () => {
    /*
     * The first version of this fix used process.env.SystemRoot, which arrives in
     * the same merged environment the attacker contributes to and is on no
     * denylist: a repo setting it got <repo>/System32/reg.exe executed, and a
     * relative value like "." restored CWD resolution. An env-derived path only
     * LOOKS absolute. This assertion exists because the earlier test PINNED that
     * implementation and therefore certified the bug.
     */
    expect(src, 'reg.exe path is still environment-derived').not.toMatch(/REG_EXE\s*=.*process\.env/)
    expect(src).toMatch(/const REG_EXE = 'C:\\\\Windows\\\\System32\\\\reg\.exe'/)
  })

  it('never spawns a bare `defaults`', () => {
    expect(src).not.toMatch(/exec\(\s*['"]defaults['"]/)
    expect(src).toMatch(/const DEFAULTS_BIN = '\/usr\/bin\/defaults'/)
    expect(src).toMatch(/exec\(DEFAULTS_BIN,/)
  })

  it('reads NO environment variable to decide which binary to execute', () => {
    const spawnRegion = src.slice(src.indexOf('const REG_EXE'), src.indexOf('function readMacosNativeMdm'))
    expect(spawnRegion, 'an env read decides which binary runs').not.toContain('process.env')
  })
})
