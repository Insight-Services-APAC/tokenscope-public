/*
 * Portable interpreter resolution for the plugin tests that run real shells.
 *
 * The tests used `spawnSync('/bin/sh', ['-c', 'command -v …'])` to find
 * PowerShell, which cannot work on Windows — the one OS where the PowerShell
 * legs matter most. Here:
 *
 *   - PowerShell: TOKENSCOPE_PWSH if it is an absolute path; otherwise looked up
 *     (`where.exe` on win32, `command -v` elsewhere), and on win32 a bare
 *     `powershell`/`powershell.exe` falls back to the fixed System32 location.
 *   - sh / bash: `/bin/sh`, `/bin/bash` on POSIX. On win32, Git for Windows'
 *     shells — the ones Claude Code runs a hook through there — never a PATH
 *     lookup, which on a runner finds System32\bash.exe (the WSL launcher).
 *
 * Every resolver answers an ABSOLUTE path or null; the caller decides whether
 * null fails or skips.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const WIN = process.platform === 'win32'

/** The PowerShell named by TOKENSCOPE_PWSH (default `pwsh`) as an absolute path, or null. */
export function resolvePwsh(name = process.env.TOKENSCOPE_PWSH || 'pwsh'): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null
  if (WIN) {
    const r = spawnSync('where.exe', [name], { encoding: 'utf8' })
    const first = r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) : undefined
    if (first && isAbsolute(first)) return first
    if (/^powershell(\.exe)?$/i.test(name)) {
      const fixed = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      if (existsSync(fixed)) return fixed
    }
    return null
  }
  const r = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' })
  const out = r.status === 0 ? r.stdout.trim() : ''
  return out && isAbsolute(out) ? out : null
}

/** `sh` or `bash` as Claude Code would run it on this OS, or null when absent. */
export function resolvePosixShell(shell: 'sh' | 'bash'): string | null {
  const path = WIN
    ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', `${shell}.exe`)
    : `/bin/${shell}`
  return existsSync(path) ? path : null
}

/**
 * A child environment. On POSIX the given keys ARE the environment (tests rely
 * on that to make "not installed" real). On win32 a process with no SystemRoot,
 * TEMP or PATHEXT is not a working Windows process — PowerShell and .NET
 * networking fail before the code under test runs — so the given keys are laid
 * over the inherited environment, replacing case-insensitively (Path vs PATH).
 */
export function childEnv(extra: Record<string, string>): Record<string, string> {
  if (!WIN) return { ...extra }
  const lowered = new Set(Object.keys(extra).map((k) => k.toLowerCase()))
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !lowered.has(k.toLowerCase())) base[k] = v
  }
  return { ...base, ...extra }
}
