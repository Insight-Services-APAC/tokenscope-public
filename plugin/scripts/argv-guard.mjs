/*
 * argv-guard — the ONE validator for the ARGUMENTS handed to the redeem
 * helpers, shared by both lanes (vendored into copilot-plugin/, see
 * scripts/sync-copilot-plugin.mjs).
 *
 * WHY THIS EXISTS. Both setup lanes hand a LIVE single-use handoff code to a
 * local helper, and in both lanes the argv is composed by a MODEL:
 *
 *   - Claude Code: `plugin/commands/setup.md`'s `allowed-tools` grant ends in
 *     `:*` — `Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.mjs":*)`.
 *     That is a PREFIX grant: every argv tail is pre-approved, with no
 *     permission prompt. The prose in that file asks the model to pass only
 *     `--handoff-code`; prose is not a control, and a prompt-injected model
 *     (a hostile repo's auto-loaded CLAUDE.md/AGENTS.md, or any file read
 *     earlier in the session) is precisely a model that ignores it.
 *   - Copilot CLI: there is no `allowed-tools` mechanism at all. Its skills are
 *     plain SKILL.md prose, so there is nothing to narrow.
 *
 * So the control cannot live in the grant, and cannot live in either lane's
 * instructions. It lives HERE, in the process that actually spends the secret.
 *
 * THE INVARIANT, stated once: argv may SELECT which of the hosts this device
 * already knows the handoff is posted to, and which of the files under the
 * account's own home is written — it may never INTRODUCE either. The hosts a
 * device knows come from configuration a human wrote outside the conversation
 * (the MCP registration the two redeem helpers discover — see mcp-origin.mjs),
 * from the packaged default, or from loopback. A model relaying a value through
 * the conversation cannot add to that set.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { assertSafeEndpoint, isLoopbackHostname, unsafeEndpointError } from './endpoint-guard.mjs'
import { realHome } from './real-home.mjs'

/**
 * A rejection carrying a stable, value-free `reason` — the same
 * classify-then-redact split endpoint-guard.mjs uses, for the same purpose:
 * these values are argv chosen by a model, so the MESSAGE must be safe to
 * print without echoing what was rejected.
 */
function argvError(message, reason) {
  const err = new Error(message)
  err.reason = reason
  return err
}

/**
 * Render an argv token for a human-readable error WITHOUT handing a terminal
 * whatever bytes the caller chose. A rejected flag name is attacker-composable
 * text on its way to stderr; ANSI escapes and control characters in it would be
 * interpreted, not displayed. Names the token (so the error is actionable) but
 * only in the character set a flag can legitimately use.
 */
function safeToken(token) {
  return String(token)
    .slice(0, 40)
    .replace(/[^A-Za-z0-9._=/:-]/g, '?')
}

/**
 * Read the value that follows a flag, or throw.
 *
 * `--api-base --settings-path /x` used to silently make `--settings-path` the
 * api base and `/x` the positional handoff code. A flag missing its value is
 * argv nobody meant to write, so it is refused rather than reinterpreted.
 *
 * `allowLeadingDash` exists for exactly one flag: a base64url handoff code can
 * begin with `-`, which is the whole reason `--handoff-code` exists instead of
 * a bare positional.
 *
 * @param {string[]} argv
 * @param {number} i index of the VALUE (i.e. the flag's index + 1)
 * @param {string} flag the flag name, for the message
 * @param {{ allowLeadingDash?: boolean }} [opts]
 */
export function flagValue(argv, i, flag, { allowLeadingDash = false } = {}) {
  const v = argv[i]
  if (typeof v !== 'string' || v === '') {
    throw argvError(`${safeToken(flag)} requires a value`, 'missing-value')
  }
  if (!allowLeadingDash && v.startsWith('--')) {
    throw argvError(`${safeToken(flag)} requires a value (got another flag)`, 'missing-value')
  }
  return v
}

/**
 * Refuse any `--flag` the caller does not implement.
 *
 * Tolerating an unknown flag is how `--redeem-url` survived: a flag nothing in
 * the product passes, accepted anyway, that bypassed every api-base control by
 * naming the POST target outright. Refusing the whole argv means a NEW flag
 * cannot be exploited before it is reviewed — and that a flag deleted for being
 * dangerous cannot come back as "silently ignored", where its VALUE would still
 * be reachable as a stray positional.
 *
 * Only `--` prefixed tokens are treated as flags. A single leading `-` is left
 * alone because a bare positional handoff code may legitimately start with one.
 */
export function assertKnownFlag(token) {
  if (typeof token === 'string' && token.startsWith('--')) {
    throw argvError(`unknown flag: ${safeToken(token)}`, 'unknown-flag')
  }
}

/** A path deeper than this is pathological — the realpath walk stops regardless. */
const MAX_PATH_DEPTH = 64

/**
 * The REAL (symlink-resolved) form of an absolute path that may not exist yet.
 *
 * `realpathSync` throws ENOENT on a missing leaf, which is the normal case for
 * a file we are about to create — so resolve the deepest EXISTING ancestor and
 * re-append the tail below it. A path component that is genuinely absent cannot
 * be a symlink, so the result is fully symlink-resolved either way.
 *
 * "GENUINELY ABSENT" IS THE LOAD-BEARING WORD. `realpathSync` also raises
 * ENOENT for a component that very much exists — a symlink whose TARGET is
 * missing — and opening a dangling symlink with `O_CREAT` creates the target,
 * at a location nothing here ever inspected. Treating that as "not there yet"
 * would reopen the exact hole this function exists to close, on a link an
 * attacker can plant precisely because it needs no target. `lstatSync` sees the
 * link itself rather than following it, so a component it can stat is NOT
 * missing, and the ENOENT is re-thrown.
 *
 * ONLY a genuinely-absent component continues the walk. Any other error
 * (EACCES, ELOOP, ENOTDIR, a dangling link) means we cannot establish where the
 * path really points, and the caller is a confinement check — so it throws and
 * the caller fails CLOSED, rather than silently falling back to the unresolved
 * string, which is the very thing being distrusted.
 */
function realpathForWrite(p) {
  const tail = []
  let dir = p
  for (let i = 0; i <= MAX_PATH_DEPTH; i++) {
    try {
      const real = realpathSync(dir)
      return tail.length ? join(real, ...tail) : real
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err
      if (existsAsEntry(dir)) throw err // a dangling symlink, not an absent name
      const parent = dirname(dir)
      if (parent === dir) throw err // walked to the filesystem root; nothing exists
      tail.unshift(basename(dir))
      dir = parent
    }
  }
  throw new Error('path is too deep to resolve')
}

/** Does a directory entry exist at `p` — WITHOUT following it? See realpathForWrite. */
function existsAsEntry(p) {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * Confine a path-valued flag to the account's own home (or, where the caller
 * says so, to either home this process can name).
 *
 * WHAT IT BUYS. `--settings-path` names the file a durable OAuth emit
 * credential is written to; `--shell-rc` names a file that gets an export block
 * appended and is then executed by every future shell. Unconstrained, either is
 * a model-chosen write target.
 *
 * The comparison is between REAL paths on both sides: `realpathForWrite` on the
 * candidate (so a symlinked component — a `~/.claude` pointing at an
 * attacker-controlled directory, which a cloned repository can ship and which
 * container/shared-home setups make likelier — is resolved before the prefix
 * test rather than after it), and `realpathSync` on each root (so a home that
 * is itself reached through a symlink still matches). `resolve()` alone, which
 * this check used to rely on, does not read the filesystem and therefore cannot
 * see a symlink at all. The returned path is the resolved one, so the caller
 * writes to the location that was actually checked.
 *
 * WHAT IT DOES NOT BUY, stated so nobody reads more into it:
 *   - It is a path check, not an atomic one. The file is opened later, by the
 *     caller; a symlink swapped in AFTER this returns is still followed. Closing
 *     that needs the open itself to refuse (`O_NOFOLLOW`), not a stricter path.
 *   - It says nothing about what is INSIDE the home. Anything that can already
 *     write there can present a real path this accepts.
 * Both residuals require local write access to the account's own home; the
 * symlink case above did not, which is why it is closed here.
 *
 * @param {string} value
 * @param {{ flag: string, roots?: string[], allowedBasenames?: string[] }} opts
 * @returns {string} the resolved, symlink-free, confined path
 */
export function assertConfinedPath(value, { flag, roots = [realHome()], allowedBasenames } = {}) {
  const resolved = resolve(value)
  let real
  try {
    real = realpathForWrite(resolved)
  } catch {
    // Fail CLOSED: an unresolvable path is one whose destination we cannot
    // establish, and this function exists to establish exactly that.
    throw argvError(
      `${safeToken(flag)} could not be resolved to a real path inside your home directory (${roots[0]})`,
      'unresolvable-path',
    )
  }
  const inside = roots
    .filter((r) => typeof r === 'string' && r)
    .map((r) => {
      // A root that cannot be realpath'd is compared as-is: the candidate side
      // IS fully resolved, so a stale root can only fail to match (safe), never
      // widen what is accepted.
      try {
        return realpathSync(resolve(r))
      } catch {
        return resolve(r)
      }
    })
    .some((root) => real === root || real.startsWith(root + sep))
  if (!inside) {
    throw argvError(
      `${safeToken(flag)} must name a path inside your home directory (${roots[0]}), and must not be a symlink out of it`,
      'outside-home',
    )
  }
  // Checked on the REAL basename: a symlink named `settings.json` pointing at
  // `notes.txt` writes to `notes.txt`, and this flag exists to name the file
  // that is actually written.
  if (allowedBasenames && !allowedBasenames.includes(basename(real))) {
    throw argvError(
      `${safeToken(flag)} must name one of: ${allowedBasenames.join(', ')}`,
      'unexpected-filename',
    )
  }
  return real
}

/** Canonical origin of a candidate base, or null when it is not usable as one. */
function originOf(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return new URL(value.trim()).origin
  } catch {
    return null
  }
}

/**
 * Validate an `--api-base` VALUE against the origins this device already knows.
 *
 * Accepts, and returns the canonical origin of:
 *   - any loopback host, on any port — the documented local-dev target. To be
 *     served by 127.0.0.1 an attacker must already be running a process on the
 *     machine, which is a shorter path to the credential than this flag.
 *   - any origin in `allowed` — supplied by the caller as (a) the packaged
 *     default and (b) the MCP registration discovered in the human's own
 *     client configuration. Both are origins by construction, so comparing on
 *     origin loses nothing.
 *
 * Comparison is on `URL#origin`, which is why the usual near-miss shapes do not
 * pass: `https://good.example@evil.example` has origin `https://evil.example`
 * (userinfo is additionally refused outright), a homoglyph host punycodes to a
 * different origin, `:443` on https canonicalises away, scheme and host
 * lowercase, and any path/query/fragment is discarded rather than carried into
 * the POST target.
 *
 * @param {string} value
 * @param {{ allowed?: Array<string|null|undefined>, flag?: string }} [opts]
 * @returns {string} the canonical origin to use
 */
export function assertAllowedApiBase(value, { allowed = [], flag = '--api-base' } = {}) {
  let parsed
  try {
    parsed = assertSafeEndpoint(String(value ?? '').trim(), { allowLoopback: true })
  } catch (err) {
    // assertSafeEndpoint's own message embeds the rejected value; this one came
    // from argv, so redact structurally rather than by convention.
    throw unsafeEndpointError(flag, err)
  }
  if (parsed.username || parsed.password) {
    throw argvError(`${safeToken(flag)} must not carry userinfo`, 'userinfo')
  }
  const loopback = isLoopbackHostname(parsed.hostname)
  // assertSafeEndpoint takes an early exit for loopback and therefore does not
  // check the scheme there; this is the gate that has to say http(s), or
  // `ftp://127.0.0.1` becomes an "api base" that fails later and confusingly.
  // (Same reasoning, and the same fix, as api-base.mjs's isLoopbackBase.)
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    throw argvError(`${safeToken(flag)} must be https (or http on loopback)`, 'insecure-scheme')
  }
  if (loopback) return parsed.origin
  const allowedOrigins = new Set(allowed.map(originOf).filter(Boolean))
  if (!allowedOrigins.has(parsed.origin)) {
    throw argvError(
      `${safeToken(flag)} is not an origin this device recognises`,
      'origin-not-allowed',
    )
  }
  return parsed.origin
}

/**
 * The POLICY around assertAllowedApiBase, shared so both lanes behave the same:
 * a rejected `--api-base` is WARNED ABOUT and IGNORED, not fatal.
 *
 * Why ignore rather than exit. Every remaining source — a loopback
 * TOKENSCOPE_API_BASE, the discovered MCP registration, the packaged default —
 * is a value the conversation cannot choose, so continuing without the flag is
 * safe by construction. When the two disagree it is also the better guess:
 * discovery reads the registration the human made with THIS CLI, while the flag
 * is the server's own self-report relayed through the model. And exiting would
 * hand a prompt injection a denial of setup for free.
 *
 * The warning is not decoration: an ignored flag is the only visible sign that
 * something composed an argv the flow does not produce.
 *
 * @param {string|null|undefined} value
 * @param {{ allowed?: Array<string|null|undefined>, flag?: string, warn?: (msg: string) => void }} [opts]
 * @returns {string|null} the canonical origin to use, or null to resolve without it
 */
export function acceptApiBaseArg(
  value,
  { allowed = [], flag = '--api-base', warn = (m) => process.stderr.write(`${m}\n`) } = {},
) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return assertAllowedApiBase(value, { allowed, flag })
  } catch (err) {
    warn(
      `[tokenscope] WARN: ignoring ${safeToken(flag)} (${err.reason ?? 'invalid'}) — it does not name ` +
        'loopback, the packaged deployment, or the TokenScope MCP server registered in your own client ' +
        'config. Resolving the redeem host from local configuration instead. If this deployment really ' +
        'is yours, register it with your CLI (e.g. `claude mcp add`) so the helper can discover it.',
    )
    return null
  }
}
