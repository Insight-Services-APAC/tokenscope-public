#!/usr/bin/env node
/*
 * landed-check — ask the server whether this device's telemetry actually LANDED, and
 * cache the answer so the always-on statusline can render a real green `✓ landed`
 * WITHOUT making a network call itself.
 *
 * Calls GET /api/v1/instances/{id}/health (emit-credential authed — the same gate as
 * /bearer) using the emit access token the headers-helper already cached
 * (`<state>/oauth-access.json`). Best-effort + short timeout: ANY failure leaves the
 * last-landed cache untouched, so the statusline simply renders from the last good
 * answer. Called by the session-start hook, `/tokenscope:status`, AND — throttled +
 * detached, never blocking a render — by the always-on statusline itself, so the
 * landing state stays fresh through a long session without the statusline ever making
 * a synchronous network call.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const TIMEOUT_MS = 4000

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Refresh the last-landed cache. Returns a small result object; never throws.
 * @param {{ env?: Record<string,string>, stateDir?: string }} opts
 */
export async function refreshLanded({ env = {}, stateDir } = {}) {
  const dir = stateDir || process.env.TOKENSCOPE_STATE_DIR || join(homedir(), '.tokenscope')
  const bearerEndpoint = env.TOKENSCOPE_BEARER_ENDPOINT || process.env.TOKENSCOPE_BEARER_ENDPOINT || ''
  const attrs = env.OTEL_RESOURCE_ATTRIBUTES || process.env.OTEL_RESOURCE_ATTRIBUTES || ''
  const instanceId = attrs.match(/tokenscope\.instance_id=([^,]+)/)?.[1]
  if (!bearerEndpoint || !instanceId) return { ok: false, reason: 'not-configured' }

  // .../instances/{id}/bearer  →  .../instances/{id}/health
  const healthUrl = bearerEndpoint.replace(/\/bearer(\?.*)?$/, '/health')
  if (healthUrl === bearerEndpoint) return { ok: false, reason: 'bad-endpoint' }

  const access = readJson(join(dir, 'oauth-access.json'))
  const token = access?.access_token || access?.accessToken || access?.token
  if (!token) return { ok: false, reason: 'no-token' }

  let res
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    res = await fetch(healthUrl, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
    clearTimeout(t)
  } catch {
    return { ok: false, reason: 'fetch-failed' }
  }
  if (!res.ok) return { ok: false, reason: `http-${res.status}` }
  let body
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'bad-json' }
  }

  const lastEmission = body?.last_emission ?? null
  // The client's last bearer mint = a proxy for recent EMIT ACTIVITY. The
  // statusline uses it to tell a DEAD EXPORT (client actively emitting, landed
  // watermark frozen) apart from an IDLE client (nobody's emitting → a stale
  // last_emission is EXPECTED, not a fault). Without it, now−last_emission alone
  // false-alarms red on any idle session.
  const lastBearer = body?.last_bearer_at ?? null
  const silent = !!body?.silent
  const revoked = !!body?.revoked
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'last-landed.json'),
      // `ok:true` records that /health was REACHED (auth + read path both work) —
      // it lets the statusline tell a live-but-stale answer (dead export) apart
      // from an unreachable endpoint (unknown). `checkedAt` doubles as the poll
      // throttle stamp the statusline reads to decide when a background refresh
      // is due; `revoked` carries the enrolment-revoked flag through to the render.
      `${JSON.stringify({ ok: true, instanceId, lastEmission, lastBearer, silent, revoked, checkedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    )
  } catch {
    /* cache write is best-effort */
  }
  return { ok: true, lastEmission, lastBearer, silent, revoked }
}

// CLI: refresh using the global settings.json env (best-effort, prints the result).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const settings = readJson(join(homedir(), '.claude', 'settings.json'))
  refreshLanded({ env: settings?.env || {} }).then((r) => process.stdout.write(`${JSON.stringify(r)}\n`))
}
