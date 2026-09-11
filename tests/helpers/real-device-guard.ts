/*
 * vitest globalSetup: the suite must not leave the developer's REAL device
 * changed.
 *
 * The files below hold the durable emit enrolment under the PASSWD home, which
 * product code anchors on so a repo-supplied HOME cannot move a credential; the
 * same anchor means no test can redirect them. A fingerprint (type, mode,
 * bytes) is taken before the run and compared after: a test that creates,
 * replaces, re-permissions, symlinks or corrupts one of them and leaves it so
 * fails the run. Not seen: a write restored before teardown; a run that dies
 * before teardown (already failing). Not guarded, deliberately: the access
 * cache and the failure sentinel, which the live device rewrites every ~29
 * minutes. On CI none of these exist and "absent stays absent" is asserted.
 * Incident history: docs/design/device-store-per-tool-sections.md, "Bundled".
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'

const HOME = userInfo().homedir

function guarded(): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const f of ['config.json', 'config.claude-code.json', 'config.copilot-cli.json']) {
    const p = join(HOME, '.tokenscope', f)
    out[p] = existsSync(p) ? fingerprint(p) : null
  }
  const settings = join(HOME, '.claude', 'settings.json')
  if (existsSync(settings)) {
    const raw = readFileSync(settings)
    const meta = typeMode(settings)
    try {
      const s = JSON.parse(raw.toString('utf8'))
      out[`${settings}#env+helper`] = `${meta}:${sha(JSON.stringify({ env: s.env ?? null, otelHeadersHelper: s.otelHeadersHelper ?? null }))}`
    } catch {
      // Malformed: fingerprint the bytes, so two different corruptions differ.
      out[`${settings}#env+helper`] = `${meta}:unparseable:${sha(raw)}`
    }
  } else {
    out[`${settings}#env+helper`] = null
  }
  return out
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
/** File type and permission bits: a store left world-readable or replaced by a symlink is drift too. */
const typeMode = (p: string) => {
  const st = lstatSync(p)
  return `${st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other'}:${(st.mode & 0o777).toString(8)}`
}
const fingerprint = (p: string) => `${typeMode(p)}:${sha(readFileSync(p))}`

export default function setup() {
  const before = guarded()
  return () => {
    const after = guarded()
    const changed = Object.keys(before).filter((k) => before[k] !== after[k])
    if (changed.length) {
      const msg =
        `The REAL device changed during the run (${changed.join(', ')}). ` +
        'Spawned hooks must use tests/unit/plugin/helpers/sandboxed-plugin.ts; anything minting must pass --state-dir. ' +
        'If a redeem or migration ran on this machine during the suite, re-run.'
      // A thrown teardown is only LOGGED ("error during close") and the run
      // still exits 0, so the exit code is forced from the exit hook, which runs
      // after vitest has set its own.
      process.stderr.write(`\n\u001b[31mREAL DEVICE GUARD: ${msg}\u001b[0m\n\n`)
      process.on('exit', () => {
        process.exitCode = 1
      })
      throw new Error(msg)
    }
  }
}
