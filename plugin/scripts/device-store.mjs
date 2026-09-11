/*
 * device-store.mjs — the ONE definition of where a lane's enrolment lives.
 *
 * Each lane owns one file outright, so a whole-file write is correct here rather
 * than dangerous. SYNCED to copilot-plugin/ and gated by
 * check-copilot-plugin-sync.mjs: two lanes disagreeing about a filename would
 * each read the other's enrolment as absent. Dependency-free beyond node
 * builtins so it vendors verbatim.
 *
 * Why per-tool at all, and the source/binding rules the readers below implement:
 * docs/design/device-store-per-tool-sections.md.
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { assertSafeEndpoint, unsafeEndpointError } from './endpoint-guard.mjs'

/** The lanes that own an enrolment. Closed set: filenames derive from it. */
export const TOOLS = ['claude-code', 'copilot-cli']

function assertTool(tool) {
  if (!TOOLS.includes(tool)) throw new Error(`unknown tool: ${tool}`)
  return tool
}

/** This lane's device store: `<dir>/config.<tool>.json`. */
export function deviceStorePath(tool, dir) {
  return join(dir, `config.${assertTool(tool)}.json`)
}

/**
 * This lane's access-token cache: `<dir>/oauth-access.<tool>.json`.
 *
 * Per-tool for the same reason the store is. A shared cache is the same defect
 * one credential down: an access token minted from one lane's refresh
 * credential, presented to the other lane's bearer endpoint.
 */
export function accessCachePath(tool, dir) {
  return join(dir, `oauth-access.${assertTool(tool)}.json`)
}

/**
 * The pre-split shared store. READ-ONLY from the per-tool split onwards —
 * nothing writes it again. Each lane falls back to it only until its own file
 * exists, and the bar each lane clears to read it differs (see the design doc:
 * Claude must prove ownership, Copilot keeps today's read).
 */
export function legacyStorePath(dir) {
  return join(dir, 'config.json')
}

/**
 * The instance a `.../instances/<id>/bearer` URL addresses, or ''.
 *
 * For CORRELATING two values. It does not prove the stored token belongs to that
 * instance; use attrsInstance() when you need to NAME the instance.
 */
export function bearerInstance(url) {
  let u
  try {
    u = new URL(String(url ?? ''))
  } catch {
    return ''
  }
  // A query or fragment disqualifies the URL outright. `new URL().pathname`
  // silently drops both, so without this the JS would accept
  // `https://h/instances/a/bearer#/instances/b/bearer` as `a` while the shell
  // rejects it. A real bearer endpoint carries neither, and the two
  // implementations must not disagree about ownership.
  if (u.search || u.hash) return ''
  const pathname = u.pathname
  // END-ANCHORED, and on the PATHNAME only. An unanchored substring match over
  // the whole URL accepted `https://evil.example/?next=/instances/good/bearer`
  // as instance `good`, which would have let a crafted endpoint pass an
  // OWNERSHIP check. The `.*` is greedy so a repeated segment resolves to the
  // LAST one, matching the shell helper's sed exactly; the two must agree
  // because both decide the same question on the same data.
  const m = /^(?:.*\/)?instances\/([^/]+)\/bearer$/.exec(pathname)
  return m ? m[1] : ''
}

/** The single `tool=` marker inside an OTEL_RESOURCE_ATTRIBUTES string, or ''. */
export function attrsTool(attrs) {
  for (const part of String(attrs ?? '').split(',')) {
    const t = part.trim()
    if (t.startsWith('tool=')) return t.slice('tool='.length)
  }
  return ''
}

/**
 * The store path a READER should open: this lane's own file, else the legacy
 * shared one, else this lane's own path so an error names the right file.
 *
 * The legacy fallback keeps a device working until its next redeem. It is NOT
 * ownership proof: otel-headers-helper.sh resolves that itself (design doc,
 * source table) and readers here are downstream of its decision.
 */
export function resolveStorePath(tool, dir) {
  const own = deviceStorePath(tool, dir)
  if (existsSync(own)) return own
  const legacy = legacyStorePath(dir)
  return existsSync(legacy) ? legacy : own
}

/**
 * The `tokenscope.instance_id=` value inside an OTEL_RESOURCE_ATTRIBUTES
 * string, or ''.
 *
 * THE AUTHORITATIVE source of the instance id, and not interchangeable with
 * `bearerInstance`. This is what the server sent and what rides every emitted
 * record; `bearerInstance` only says which instance a URL addresses, and exists
 * to CORRELATE two values, not to name one. Deriving a stored instance_id from
 * a URL would put an empty string in the resource attributes the moment the
 * endpoint was not instance-shaped, which breaks the teammate join silently.
 */
export function attrsInstance(attrs) {
  for (const part of String(attrs ?? '').split(',')) {
    const t = part.trim()
    if (t.startsWith('tokenscope.instance_id=')) return t.slice('tokenscope.instance_id='.length)
  }
  return ''
}

/**
 * The cached access token, but ONLY when it was minted for `bearerEndpoint`.
 *
 * EVERY consumer that presents this token must apply this check, not just the
 * helper. A record with no `bearer_endpoint` predates the binding, fails the
 * compare, and is ignored. See the design doc's cache section.
 */
export function readBoundAccessToken(cache, bearerEndpoint) {
  if (!cache || typeof cache !== 'object') return null
  const bound = typeof cache.bearer_endpoint === 'string' ? cache.bearer_endpoint : ''
  if (!bound || !bearerEndpoint || bound !== bearerEndpoint) return null
  return typeof cache.access_token === 'string' && cache.access_token ? cache.access_token : null
}

/**
 * The ONE consistency rule for a v2 store, applied by every WRITER before it
 * persists anything. It is the COMPLETE mirror of what otel-headers-helper.sh
 * refuses on read (source 1 in its ordered list); a writer that satisfies this
 * cannot produce a store the helper permanently refuses. The eight checks, in
 * the helper's terms: tool is this lane; credential and both destinations are
 * present; the v2 envelope (version 2, tool, instance_id, attributes) is
 * present; the attributes name this tool and this instance; the bearer
 * endpoint addresses that instance; both endpoints are https or loopback; and
 * every field the helper reads survives its sed extraction (no `"`, `\` or
 * control character — the shell would read a different value than JS wrote).
 *
 * Throws naming the FIELD, never its value: the refresh token is among them,
 * and an endpoint is server-supplied and untrusted (endpoint-guard.mjs).
 */
export function assertStoreConsistent(tool, store) {
  assertTool(tool)
  const s = store ?? {}
  if (s.version !== 2) throw new Error(`store version is not 2`)
  if (s.tool !== tool) throw new Error(`store tool "${s.tool}" is not "${tool}"`)
  const str = (k) => (typeof s[k] === 'string' ? s[k] : '')
  for (const k of ['instance_id', 'oauth_refresh_token', 'oauth_token_endpoint', 'bearer_endpoint', 'otel_resource_attributes']) {
    if (!str(k)) throw new Error(`store has no ${k}`)
  }
  for (const k of ['tool', 'instance_id', 'oauth_refresh_token', 'oauth_token_endpoint', 'bearer_endpoint', 'oauth_client_id', 'otel_resource_attributes']) {
    // Controls, `"` (u0022) and `\` (u005c): the shell reader's own exclusion set.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u0022\u005c]/.test(str(k))) throw new Error(`store ${k} is not readable by the emit helper`)
  }
  for (const k of ['bearer_endpoint', 'oauth_token_endpoint']) {
    try {
      assertSafeEndpoint(s[k], { allowLoopback: true })
    } catch (err) {
      throw unsafeEndpointError(`store ${k}`, err)
    }
  }
  const instance = s.instance_id
  const attrs = s.otel_resource_attributes
  const t = attrsTool(attrs)
  if (t !== tool) throw new Error(`resource attributes name tool "${t}", not "${tool}"`)
  const ai = attrsInstance(attrs)
  if (ai !== instance) throw new Error(`resource attributes name instance "${ai}", not "${instance}"`)
  const bi = bearerInstance(s.bearer_endpoint)
  if (bi !== instance) throw new Error(`bearer endpoint addresses instance "${bi}", not "${instance}"`)
  return s
}
