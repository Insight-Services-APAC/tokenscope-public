/*
 * The spawned-hook sandbox must neutralise every reader that reaches the REAL
 * account's files (Copilot review, PR #416). Overriding HOME does not move the
 * passwd home, so an un-stubbed reader in the copied plugin would let a spawned
 * session-start hook rebuild the developer's real settings files against a
 * throwaway install that the test then deletes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { materialiseSandboxedPlugin } from './helpers/sandboxed-plugin'

const PLUGIN = resolve(__dirname, '../../../plugin')
let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('materialiseSandboxedPlugin', () => {
  it('stubs both session-scoped settings readers, even with populated files on disk', () => {
    root = mkdtempSync(join(tmpdir(), 'ts-sandbox-stubs-'))
    const dest = join(root, 'plugin')
    materialiseSandboxedPlugin(PLUGIN, dest)
    const state = join(root, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'settings-files.claude-code.json'), JSON.stringify({ version: 1, tool: 'claude-code', files: [join(root, 'x', 'settings.json')] }))
    writeFileSync(
      join(state, 'isolated-settings-files.claude-code.json'),
      JSON.stringify({ version: 1, tool: 'claude-code', entries: [{ file: join(root, 'y', 'settings.json'), stateDir: join(root, 'iso') }] }),
    )

    // Plain Node, not vitest's module loader (it refuses files outside the repo).
    const counts = (runtime: string) => {
      const src = `const m = await import(${JSON.stringify(pathToFileURL(runtime).href)});` +
        `console.log(JSON.stringify([m.readSettingsFilesList('claude-code', ${JSON.stringify(state)}).length, m.readIsolatedSettingsFiles('claude-code', ${JSON.stringify(state)}).length]))`
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(r.stderr)
      return JSON.parse(r.stdout.trim()) as [number, number]
    }
    // The real runtime reads both files; the sandboxed copy reads neither.
    expect(counts(join(PLUGIN, 'scripts', 'plugin-runtime.mjs'))).toEqual([1, 1])
    expect(counts(join(dest, 'scripts', 'plugin-runtime.mjs'))).toEqual([0, 0])
  })
})
