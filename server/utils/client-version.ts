/*
 * Client-asserted version headers — parsing + sanitising.
 *
 * WHY THIS EXISTS. The 2026-07-24 attribution-gap incident surfaced a live Dev
 * device eight days behind on attribution, and the first triage question — "is
 * that device on an old plugin?" — could not be answered from data. Nothing
 * recorded the plugin or CLI version per device. The client now states both on
 * the /bearer mint (headers, ~29 min per live device); this module is the
 * boundary that decides what we are willing to store.
 *
 * TRUST MODEL. These values are CLIENT-ASSERTED. Anyone holding a valid emit
 * credential can send any string. They are DIAGNOSTIC HINTS ONLY — never an
 * authorisation input, never a costing input. What this module guarantees is
 * therefore narrow and purely about STORAGE HYGIENE, not authenticity:
 *
 *   - the stored value is short (a version string, not a payload),
 *   - the stored value is charset-constrained, so it cannot smuggle control
 *     characters, quotes, or markup into an operator's console / CSV export /
 *     admin table, and
 *   - an unparseable header is DROPPED rather than stored mangled — a NULL
 *     ("never reported") is honest, a truncated half-value is not.
 *
 * The charset is deliberately permissive about SHAPE (no semver regex): Claude
 * Code has shipped versions like `2.1.212`, and a future client may report
 * `1.2.3-beta.4` or a build suffix. Rejecting an unexpected-but-harmless shape
 * would silently blind the exact fleet we most want to see.
 */

/** Header the client puts its TokenScope plugin version in. */
export const PLUGIN_VERSION_HEADER = 'x-tokenscope-plugin-version'
/** Header the client puts its agent CLI version in (Claude Code / Copilot CLI). */
export const CLIENT_VERSION_HEADER = 'x-tokenscope-client-version'

/*
 * Max stored length. A version string is a handful of characters; 40 leaves room
 * for a pre-release + build suffix and nothing else. Anything longer is not a
 * version, so it is REJECTED rather than truncated — a truncated value reads as
 * a real (wrong) version in the admin table, which is worse than "not reported".
 */
export const MAX_CLIENT_VERSION_LENGTH = 40

/*
 * Allowed charset: the characters semver and vendor build strings actually use.
 * Excludes whitespace, quotes, angle brackets, and control characters — the
 * things that would let a client's claimed "version" render as something else in
 * an operator surface. `v` prefixes and `+build` metadata pass through unchanged;
 * normalising them would be inventing information the client did not send.
 */
const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/**
 * Sanitise one client-asserted version string.
 *
 * Returns the trimmed value when it is plausibly a version, or `null` when it is
 * absent, empty, over-long, or carries a character outside the safe set. `null`
 * means "not reported" and is a first-class answer — callers must not substitute
 * a placeholder for it.
 */
export function sanitizeClientVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  // EQUIVALENT MUTANT, deliberately kept (mutation sweep: this line SURVIVES).
  // Deleting it changes nothing observable — SAFE_VERSION_RE requires at least
  // one leading alphanumeric, so '' falls out at the regex a few lines below with
  // the same null. It stays because "empty is not a version" is the clearest
  // statement of intent at the top of the function, and because a future relaxing
  // of the regex must not silently start accepting ''.
  if (!v) return null
  // Length check BEFORE the regex: the regex is unanchored-free and linear, but
  // bounding input first keeps a pathological header cheap regardless.
  if (v.length > MAX_CLIENT_VERSION_LENGTH) return null
  if (!SAFE_VERSION_RE.test(v)) return null
  return v
}

export interface ClientVersionClaim {
  /** The TokenScope plugin version the client claimed, or null if not reported. */
  pluginVersion: string | null
  /** The agent CLI version the client claimed, or null if not reported. */
  cliVersion: string | null
  /** True when at least one usable value was reported — the "write it" signal. */
  reported: boolean
}

/**
 * Read both version headers off a header bag (lower-cased keys, as h3/node give
 * them) and sanitise each independently.
 *
 * Independent on purpose: a client that reports a good plugin version and a
 * junk CLI version should still get its plugin version stored. Coupling them
 * would let one bad field blind the other.
 *
 * `reported` is false only when NEITHER value survived. Callers use it to decide
 * whether to touch the version columns at all — see the note in bearer.get.ts on
 * why a non-reporting mint must NOT null out a previous reading.
 */
export function readClientVersionHeaders(
  headers: Record<string, string | string[] | undefined> | undefined | null,
): ClientVersionClaim {
  const pick = (name: string): string | null => {
    const raw = headers?.[name]
    // A repeated header arrives as an array. Take the FIRST value rather than
    // joining: a join would produce "0.1.27, 0.1.26", which sanitises to null and
    // loses both readings.
    return sanitizeClientVersion(Array.isArray(raw) ? raw[0] : raw)
  }
  const pluginVersion = pick(PLUGIN_VERSION_HEADER)
  const cliVersion = pick(CLIENT_VERSION_HEADER)
  return { pluginVersion, cliVersion, reported: pluginVersion !== null || cliVersion !== null }
}
