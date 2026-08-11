/*
 * endpoint-guard — the ONE endpoint validator for every plugin network call
 * that carries credential material (a bearer, an OAuth grant, the ingest
 * payload). Deliberately dependency-free (Node builtins only; NO imports
 * from plugin/scripts/*) so it survives being copied verbatim into the
 * standalone copilot-plugin distribution (scripts/sync-copilot-plugin.mjs) —
 * a second, hand-maintained guard for the Copilot lane is exactly what this
 * epic's opening principle forbids ("where a correct implementation already
 * exists, the fix is to reach it — not to write a second one beside it"),
 * and only a vendored copy of ONE file can't drift from it.
 *
 * Modelled on the two correct siblings this codebase already had (promoted
 * into one place instead of re-implemented a third time):
 *   - otlp-forwarder.mjs's https-off-box refusal + self-loop guard (readDceEndpoint)
 *   - env-builder.mjs's isUsableDce — promoted here VERBATIM (env-builder.mjs
 *     now imports it rather than keeping a private module-scoped copy).
 */

/**
 * Loopback hostnames the plugin treats as "on this box" (dev / a local
 * collector). `URL#hostname` for an IPv6 literal INCLUDES the brackets
 * (`new URL('http://[::1]/x').hostname === '[::1]'`, not `'::1'`) — match
 * both forms so an IPv6-loopback dev endpoint isn't misclassified as off-box.
 */
function isLoopbackHostname(hostname) {
  const h = (hostname || '').toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

/**
 * Validate `urlStr` is safe to use for a plugin network call. Throws a
 * descriptive Error on any failure; returns the parsed `URL` on success.
 *
 *   - must be a non-empty string that parses as an absolute URL
 *   - must NOT start with '-' — a value later interpolated as a bare CLI
 *     argument (e.g. into curl, in otel-headers-helper.sh) must never be
 *     readable as a flag
 *   - must be https:// for an off-box host; a loopback host (127.0.0.1 /
 *     localhost / ::1) is exempted from that requirement ONLY when the
 *     caller opts in via `allowLoopback` — the explicit dev exception
 *     (api-base.mjs's local :3450 override, and the CC #72671 forwarder's
 *     own on-box relay). Every other destination is refused in plaintext.
 *
 * @param {string} urlStr
 * @param {{ allowLoopback?: boolean }} [opts]
 * @returns {URL}
 */
function endpointError(reason, message) {
  const err = new Error(message)
  // A stable, VALUE-FREE classification. Callers validating SERVER-supplied
  // input (the redeem bundle) log `reason` instead of `message`, so untrusted
  // bytes never reach a log sink; callers validating the developer's OWN
  // config keep the fuller message, which is theirs to read. Same
  // classify-then-redact split as server/utils/redact-probe-error.ts.
  err.reason = reason
  return err
}

/**
 * Build a VALUE-FREE error for a rejected endpoint that came from an UNTRUSTED
 * source (the server-supplied redeem bundle, a stashed DCE endpoint).
 *
 * Why this exists rather than each caller hand-rolling the same string: the
 * "reason only, never the value" rule above was convention, and convention was
 * not holding it. Two ways it leaked:
 *
 *  1. `new Error(msg, { cause: err })` looks safe because `msg` is value-free,
 *     but the CAUSE is not. Node PRINTS the cause chain — both for
 *     `console.error(err)` in object form and for an uncaught throw — so the
 *     rejected value reached a clear-text sink anyway, via a field the calling
 *     code never names. (CodeQL js/clear-text-logging #7 traced exactly this
 *     edge; a comment at the call site asserted the opposite, which is worse
 *     than no comment because it stops a reviewer checking. Verified against
 *     Node's actual printer, not assumed.)
 *  2. otlp-forwarder.mjs interpolated `err.message` — which DOES carry the
 *     value — straight into the outer message, violating this module's own
 *     documented contract for server-supplied input.
 *
 * So the redaction is now structural: callers cannot accidentally retain the
 * tainted original because this never takes it beyond reading `.reason`. The
 * classification is preserved as `.reason` on the returned error, which is
 * what diagnosis actually needs; the discarded stack pointed back into this
 * module and carried no caller information.
 *
 * @param {string} label  Field name being validated — OURS, never untrusted.
 * @param {unknown} err   The error from assertSafeEndpoint. Only `.reason` is read.
 * @returns {Error}
 */
export function unsafeEndpointError(label, err) {
  const reason = typeof err?.reason === 'string' ? err.reason : 'invalid'
  const out = new Error(`${label} is unsafe (${reason})`)
  out.reason = reason
  return out
}

export function assertSafeEndpoint(urlStr, { allowLoopback = false } = {}) {
  if (typeof urlStr !== 'string' || !urlStr.trim()) {
    throw endpointError('empty', 'endpoint is empty')
  }
  const trimmed = urlStr.trim()
  if (trimmed.startsWith('-')) {
    throw endpointError(
      'leading-dash',
      `endpoint must not start with '-' (would be read as a flag): ${trimmed.slice(0, 60)}`,
    )
  }
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw endpointError('not-a-url', `endpoint is not a valid URL: ${trimmed.slice(0, 80)}`)
  }
  const loopback = isLoopbackHostname(parsed.hostname)
  if (loopback && allowLoopback) return parsed
  if (parsed.protocol !== 'https:') {
    throw endpointError(
      'insecure-scheme',
      `endpoint must be https for an off-box host, got ${parsed.protocol}//${parsed.hostname}`,
    )
  }
  return parsed
}

/**
 * A usable "real DCE" value: a parseable, https, NON-loopback URL. Promoted
 * from env-builder.mjs (was module-private `isUsableDce`) so the OTLP
 * forwarder's stash validation and the repoint/reconcile logic share ONE
 * definition instead of two hand-maintained copies. Loopback is rejected
 * UNCONDITIONALLY here (not merely "off by default") — the proxy's own
 * address must never masquerade as the real DCE, which `assertSafeEndpoint`'s
 * `allowLoopback` flag alone would not prevent for an (unusual but possible)
 * `https://127.0.0.1/...` value.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isUsableDce(v) {
  if (typeof v !== 'string' || !v.trim()) return false
  let parsed
  try {
    parsed = assertSafeEndpoint(v, { allowLoopback: false })
  } catch {
    return false
  }
  return !isLoopbackHostname(parsed.hostname)
}
