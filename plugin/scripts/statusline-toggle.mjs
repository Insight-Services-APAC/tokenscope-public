#!/usr/bin/env node
/*
 * statusline-toggle.mjs — implements `/tokenscope:statusline [on|off]`.
 *
 * Turns the TokenScope status line (emission health + session id) on or off in
 * the GLOBAL ~/.claude/settings.json. It's installed ON by default at enrolment;
 * this lets a developer opt out, or opt in (replacing a custom status line).
 *
 *   on   — install TokenScope's status line (replaces a custom one if present)
 *   off  — remove TokenScope's status line (a non-TokenScope one is left untouched)
 *   (no arg) — report current state
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync, rmSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installStatusLine, removeStatusLine } from './env-builder.mjs'

const arg = (process.argv[2] || '').trim().toLowerCase()
const settingsPath = join(homedir(), '.claude', 'settings.json')
const scriptsDir = process.env.CLAUDE_PLUGIN_ROOT
  ? join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts')
  : dirname(fileURLToPath(import.meta.url))
const statuslinePath = join(scriptsDir, 'statusline.mjs')

let settings = {}
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    // NEVER proceed with {} — saving would rewrite settings.json as just
    // {statusLine}, wiping the env block (the durable emit credential, OTel
    // endpoints), otelHeadersHelper, and permissions: silent de-enrolment.
    // Same refuse-on-unparseable contract as claude-redeem's writeClaudeSettings.
    console.error(`[tokenscope] Existing ${settingsPath} is not valid JSON — refusing to touch it. Fix or move it, then re-run.`)
    process.exit(1)
  }
}
const hasOurs =
  settings.statusLine &&
  typeof settings.statusLine === 'object' &&
  typeof settings.statusLine.command === 'string' &&
  settings.statusLine.command.includes('statusline.mjs')

// Atomic temp+rename write (same pattern as claude-redeem's writeClaudeSettings)
// so a concurrent `claude` / SessionStart hook never reads a half-written file.
function save(next) {
  mkdirSync(dirname(settingsPath), { recursive: true })
  const tmp = `${settingsPath}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(tmp, 0o600) // defeat umask so the file is 0600 even if writeFileSync's mode was masked
    } catch {
      /* best-effort */
    }
    renameSync(tmp, settingsPath) // atomic on the same filesystem
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* best-effort cleanup */ }
    throw err
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
}

if (arg === 'off') {
  const { settings: next, removed } = removeStatusLine(settings)
  if (removed) save(next)
  emit({ action: 'off', changed: removed, message: removed ? 'TokenScope status line turned OFF.' : 'No TokenScope status line was set (left any custom one untouched).' })
} else if (arg === 'on') {
  // Explicit opt-in: force-install, replacing a custom status line if present.
  const replacedCustom = Boolean(settings.statusLine) && !hasOurs
  const { settings: next } = installStatusLine(settings, statuslinePath, { force: true })
  save(next)
  emit({ action: 'on', changed: true, replacedCustom, message: replacedCustom ? 'TokenScope status line turned ON (replaced your previous custom status line).' : 'TokenScope status line turned ON (emission health + session id).' })
} else {
  emit({ action: 'status', enabled: Boolean(hasOurs), hasCustom: Boolean(settings.statusLine) && !hasOurs, message: hasOurs ? 'TokenScope status line is ON.' : (settings.statusLine ? 'A custom (non-TokenScope) status line is set. Run `/tokenscope:statusline on` to replace it.' : 'TokenScope status line is OFF. Run `/tokenscope:statusline on` to enable it.') })
}
