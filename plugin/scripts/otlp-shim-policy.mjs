// Single source of truth for whether the local OTLP Content-Length forwarder
// (the CC #72671 shim) should run for the CLI that launched THIS session.
//
// Design: version-aware AUTO by default. The forwarder activates ONLY on CLI
// versions known to ship the chunked-OTLP regression (which Azure Monitor DCEs
// reject with 400 MissingContentLengthHeader), and stays dormant — direct
// emission — on every other version. This keeps the client zero-touch (emission
// principle 1): a user on a broken CLI is fixed with no action, a user on a
// fixed CLI carries no shim, and a FUTURE re-regression is handled by appending
// one range below — the only change needed to re-arm the fleet.
//
// Manual override via TOKENSCOPE_OTLP_PROXY: `1` forces the forwarder ON
// (e.g. a suspected regression not yet listed), `0` forces it OFF; anything
// else (incl. unset) is version-aware AUTO.

// Half-open [from, to): every CLI with from <= v < to is affected. #72671 was
// the 2.1.191–2.1.211 span, fixed in 2.1.212. Append a new entry here if a
// future CLI re-regresses — re-validate first with tools/otlp-72671/retest-72671.sh
// (relocated there from plugin/scripts/ — a dev-only harness, not part of the
// shipped plugin distribution).
export const OTLP_BROKEN_RANGES = [
  { from: [2, 1, 191], to: [2, 1, 212], issue: 'anthropics/claude-code#72671' },
]

/** Parse "2.1.212" (or "2.1.212 (Claude Code)") → [2,1,212]; null if unparseable. */
export function parseCliVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

// Version of the CLI that launched THIS session, from the env Claude sets at
// spawn: CLAUDE_CODE_EXECPATH=.../versions/X.Y.Z (preferred), else
// AI_AGENT=claude-code_X-Y-Z_agent. Both reflect the session's REAL version even
// if the CLI was upgraded on disk since launch. Null if neither is present
// (→ AUTO fails open to dormant/direct — the safe default on a fixed fleet).
export function detectCliVersion(env = process.env) {
  const execPath = env.CLAUDE_CODE_EXECPATH || ''
  const mp = /versions[/\\](\d+\.\d+\.\d+)/.exec(execPath)
  if (mp) return parseCliVersion(mp[1])
  const agent = env.AI_AGENT || '' // e.g. claude-code_2-1-211_agent
  const ma = /claude-code_(\d+)-(\d+)-(\d+)/.exec(agent)
  if (ma) return [Number(ma[1]), Number(ma[2]), Number(ma[3])]
  return null
}

/** The broken range covering this version, or null. */
export function brokenRangeFor(version) {
  if (!version) return null
  return OTLP_BROKEN_RANGES.find((r) => cmp(version, r.from) >= 0 && cmp(version, r.to) < 0) || null
}

/**
 * Resolve whether the shim is active for this env.
 * @returns {{active: boolean, reason: 'forced-on'|'forced-off'|'auto-affected'|'auto-clear', range?: object, version?: number[]|null}}
 */
export function resolveShim(env = process.env) {
  const flag = env.TOKENSCOPE_OTLP_PROXY
  if (flag === '1') return { active: true, reason: 'forced-on' }
  if (flag === '0') return { active: false, reason: 'forced-off' }
  const version = detectCliVersion(env)
  const range = brokenRangeFor(version)
  return range
    ? { active: true, reason: 'auto-affected', range, version }
    : { active: false, reason: 'auto-clear', range: null, version }
}

/** Convenience boolean: should the forwarder run for this env? */
export function shimActive(env = process.env) {
  return resolveShim(env).active
}
