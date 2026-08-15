#!/usr/bin/env node
/**
 * forwarder-lifecycle.mjs — Copilot plugin hook driver for the file-forwarder.
 *
 * Called by hooks.json on SessionStart (start) and Stop (stop).
 * Delegates to the co-located launcher in ../scripts/copilot-forwarder.mjs
 *
 * Usage:
 *   node forwarder-lifecycle.mjs start   → called on SessionStart
 *   node forwarder-lifecycle.mjs stop    → called on Stop
 *
 * IMPORTANT — two different spawn strategies per action:
 *   start: spawn detached + unref so the daemon outlives the hook's 15s timeout.
 *          stderr is redirected to ~/.tokenscope/forwarder.log (D1b fix —
 *          previously stdio:'ignore' made all failures completely silent).
 *   stop:  spawnSync (short-lived flush + exit; must complete within timeout).
 */
import { spawn, spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs'
// enroll.mjs owns the ONE state-dir resolver on this side (TOKENSCOPE_STATE_DIR pin,
// else ~/.tokenscope under the PASSWD home). Imported rather than re-derived so the
// log this hook opens lands in the same directory the enrol it runs writes into and
// the forwarder it spawns reads from — a second `homedir()`-based copy here used to
// put the log in a phantom dir whenever `$HOME` was leaked.
import { enrollIfNeeded, stateDir } from '../scripts/enroll.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const action = process.argv[2] ?? 'start'

// Co-located launcher in scripts/ (one level up from hooks/).
// H1 fix: was 3x ".." (resolved to filesystem root); correct is 2x from hooks/
// to reach copilot-plugin/, then down into scripts/.
const forwarderPath = resolve(__dir, '..', 'scripts', 'copilot-forwarder.mjs')

/**
 * Resolve the SESSION's project root. Copilot runs hooks with cwd = the PLUGIN install
 * dir, NOT the project — but it passes the project root as COPILOT_PROJECT_DIR (and
 * CLAUDE_PROJECT_DIR for compat; it is also in the SessionStart stdin payload's `cwd`).
 * The per-project forwarder MUST run with this as its cwd: the span file, byte-offset,
 * PID lock, `.tokenscope`, and `.gitignore` all resolve against it, so process.cwd()
 * (the plugin dir) is the wrong base. Falls back to cwd, where the forwarder's own guard
 * then warns loudly rather than mis-attributing silently.
 */
export function resolveProjectDir() {
  const fromEnv = (process.env.COPILOT_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || '').trim()
  return fromEnv || process.cwd()
}

/**
 * Spawn the file-forwarder daemon, detached + unref'd so it outlives this hook's
 * 15s timeout. Idempotent at the daemon layer (copilot-forwarder.mjs's PID-file
 * singleton — does not double-spawn). Factored out so the enroll step can run
 * BEFORE it on the start path.
 */
function spawnForwarder() {
  // D1b fix: redirect daemon stderr to a log file so failures are visible.
  // Previously stdio:'ignore' made spawn errors completely silent.
  const tokenscopeDir = stateDir()
  try { fs.mkdirSync(tokenscopeDir, { recursive: true }) } catch { /* pre-exists */ }
  const logFd = fs.openSync(join(tokenscopeDir, 'forwarder.log'), 'a')

  // Detached: the daemon must outlive the hook's 15-second timeout.
  // unref() lets this lifecycle process exit without waiting for the child.
  const child = spawn(process.execPath, [forwarderPath, 'start'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    // Copilot runs the hook in the PLUGIN dir; the project root arrives via
    // COPILOT_PROJECT_DIR. The per-project forwarder resolves the span file, offset,
    // lock, and .gitignore against this cwd — NOT process.cwd() (which is the plugin dir).
    cwd: resolveProjectDir(),
  })
  child.unref()
  fs.closeSync(logFd)
}

// Only dispatch when invoked directly (node forwarder-lifecycle.mjs <action>) so unit
// tests can import resolveProjectDir() without triggering enrol / spawn / process.exit.
const isDirectRun = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun && (action === 'start' || action === '--start')) {
  // EMIT-ON-INSTALL: on a FRESH install of the real (publish-injected) plugin,
  // enrol now — BEFORE spawning the forwarder — so this very session emits with no
  // login. enrollIfNeeded writes ~/.tokenscope/config.json, which the forwarder
  // then reads (loadConfig) on spawn, so the order matters on a fresh install. It
  // is a strict NO-OP when already enrolled or when no bundled secret is configured
  // (dev), and is bounded by its own ~4s timeout. Fail-OPEN + fast: any failure (or
  // a slow network) must NEVER block the forwarder spawn or break the session, so
  // we await it but always fall through to spawnForwarder().
  enrollIfNeeded()
    .catch(() => {
      /* fail-open: never break session start over enrolment */
    })
    .finally(() => {
      try {
        spawnForwarder()
      } finally {
        process.exit(0)
      }
    })
} else if (isDirectRun) {
  // stop / --final-forward: synchronous — the Stop hook must wait for the
  // final flush to complete before the session closes.
  const result = spawnSync(process.execPath, [forwarderPath, 'stop'], {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: resolveProjectDir(), // final-forward must resolve the SAME project span file
  })
  process.exit(result.status ?? 0)
}

