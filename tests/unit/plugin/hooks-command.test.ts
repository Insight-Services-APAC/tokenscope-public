// @vitest-environment node
/*
 * The SessionStart hook command (plugin/hooks/hooks.json) on a device WITHOUT
 * Node (#408 S5). Claude Code runs a shell-form hook with `sh -c` on POSIX, Git
 * Bash on Windows, or PowerShell on Windows without Git Bash; a non-zero exit is
 * a visible "hook error" notice every session, exit 0 sends stderr to the debug
 * log only (https://code.claude.com/docs/en/hooks). The command is a sh/PowerShell
 * polyglot (explained in plugin/hooks/session-start.mjs's header). Pinned here,
 * per shell:
 *   - `node` absent  -> exit 0
 *   - `node` present -> node's own exit code and stdout pass through unchanged
 *
 * `node` is a stub on a PATH we control, so "absent" is real. The PowerShell
 * leg runs pwsh 7 locally and Windows PowerShell 5.1 on the Windows CI job (the
 * production target). TOKENSCOPE_PWSH / TOKENSCOPE_SKIP_PWSH as in
 * otel-helper-conformance.test.ts: a missing pwsh FAILS, never skips silently.
 * On Windows the sh/bash legs run Git for Windows' shells (what Claude Code
 * uses there); a leg whose shell is absent is skipped with a logged reason.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolvePwsh, resolvePosixShell, childEnv } from './helpers/shells.js'

const ROOT = resolve(__dirname, '../../..')
const HOOKS = JSON.parse(readFileSync(join(ROOT, 'plugin/hooks/hooks.json'), 'utf8'))
const COMMAND: string = HOOKS.hooks.SessionStart[0].hooks[0].command
const PWSH = process.env.TOKENSCOPE_PWSH || 'pwsh'
const SKIP_PWSH = process.env.TOKENSCOPE_SKIP_PWSH === '1'

let tmp: string
let pluginRoot: string
let withNode: string
let withoutNode: string
let withNodeCmd: string
let pwshPath: string | null = null
const WIN = process.platform === 'win32'

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-hook-cmd-'))
  pluginRoot = join(tmp, 'plugin root') // a space, as under "C:\Users\First Last"
  mkdirSync(join(pluginRoot, 'hooks'), { recursive: true })
  withNode = join(tmp, 'bin-node')
  withoutNode = join(tmp, 'bin-empty')
  mkdirSync(withNode)
  mkdirSync(withoutNode)
  // The stub stands in for node: echoes the script it was given, exits $STUB_EXIT.
  const stub = join(withNode, 'node')
  writeFileSync(stub, '#!/bin/sh\nprintf "ran:%s\\n" "$1"\nexit "${STUB_EXIT:-0}"\n')
  chmodSync(stub, 0o755)
  // PowerShell on Windows resolves a command through PATHEXT, so its stub is a
  // .cmd, in a directory of its own so the extensionless sh stub is never the
  // file it picks. PowerShell elsewhere runs the sh stub directly.
  withNodeCmd = withNode
  if (WIN) {
    withNodeCmd = join(tmp, 'bin-node-cmd')
    mkdirSync(withNodeCmd)
    writeFileSync(join(withNodeCmd, 'node.cmd'), '@echo ran:%~1\r\n@exit /b %STUB_EXIT%\r\n')
  }
  if (!SKIP_PWSH) pwshPath = resolvePwsh(PWSH)
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

// Claude Code substitutes the placeholder before the shell sees the command.
const expanded = () => COMMAND.split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot)

type Shell = 'sh' | 'bash' | 'pwsh'
function run(shell: Shell, withStub: boolean, stubExit = 0) {
  const path = !withStub ? withoutNode : shell === 'pwsh' ? withNodeCmd : withNode
  const env = childEnv({ PATH: path, STUB_EXIT: String(stubExit), HOME: tmp })
  let r
  if (shell === 'pwsh') {
    if (!pwshPath) throw new Error(`pwsh missing (${PWSH}); set TOKENSCOPE_SKIP_PWSH=1 to skip this leg`)
    r = spawnSync(pwshPath, ['-NoProfile', '-NonInteractive', '-Command', expanded()], { encoding: 'utf8', env })
  } else {
    r = spawnSync(resolvePosixShell(shell) as string, ['-c', expanded()], { encoding: 'utf8', env })
  }
  // cmd.exe's echo ends a line with CRLF.
  return { ...r, stdout: (r.stdout ?? '').replace(/\r\n/g, '\n') }
}

const SHELLS: Shell[] = SKIP_PWSH ? ['sh', 'bash'] : ['sh', 'bash', 'pwsh']
const absent = (shell: Shell) => shell !== 'pwsh' && resolvePosixShell(shell) === null
for (const shell of SHELLS) {
  if (absent(shell)) console.warn(`[hooks-command] ${shell} not found on ${process.platform}; skipping its leg`)
}

describe.each(SHELLS)('SessionStart hook command under %s', (shell) => {
  it.skipIf(absent(shell))('exits 0 when node is not installed (no per-session hook error)', () => {
    const r = run(shell, false)
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it.skipIf(absent(shell))('runs session-start.mjs through node and passes a clean exit through', () => {
    const r = run(shell, true, 0)
    expect(r.status).toBe(0)
    // The literal argument the command passes: the substituted root, then the
    // forward-slashed tail from hooks.json (on Windows too).
    expect(r.stdout).toBe(`ran:${pluginRoot}/hooks/session-start.mjs\n`)
  })

  it.skipIf(absent(shell))("keeps node's own failure code, so a crash is still visible", () => {
    const r = run(shell, true, 3)
    expect(r.status).toBe(3)
  })
})
