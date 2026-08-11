#!/usr/bin/env node
/*
 * otlp-forwarder — a DELIBERATELY LIGHT local pass-through for Claude Code's
 * OTLP/HTTP logs. It exists to work around ONE Claude Code regression:
 * CC 2.1.191+ sends the logs body with `Transfer-Encoding: chunked` and NO
 * `Content-Length`, which the Azure Monitor DCE rejects (HTTP 400
 * `MissingContentLengthHeader`; the same body WITH a Content-Length → 204).
 * Filed upstream as anthropics/claude-code#72671; delete this once fixed
 * (kill-switch: TOKENSCOPE_OTLP_PROXY=0, see env-builder.applyOtlpProxyRepoint).
 *
 * Flow: Claude Code → http://127.0.0.1:<port>/v1/logs (here) → buffer the body,
 * add Content-Length → real Azure DCE → pipe the response back.
 *
 * SINGLETON = THE PORT BIND. A second spawn EADDRINUSEs on listen and exits 0
 * (logged, not silent — see the `server.on('error', ...)` handler below).
 * Still no byte-offset, catch-up, or retry — this is a stateless header-add,
 * not the copilot daemon. It DOES expose GET /healthz ({ok,dirMatches,ready})
 * and write a pidfile, purely so the SessionStart hook can tell a working
 * forwarder from a bound-but-broken one (a prior run under a leaked HOME
 * resolving a different stateDir) and replace the latter — the port bind
 * alone can't. The listening server keeps the process alive; it dies with
 * the container.
 *
 * /healthz reports NEITHER a raw pid NOR the absolute state-dir path (S1 fix
 * 6): it is an UNAUTHENTICATED local HTTP endpoint, so its response is
 * untrusted input — a `pid` field would let anything able to bind or answer
 * on the port choose what the SessionStart hook's self-heal kills, and the
 * absolute dir is a needless filesystem-layout leak. `dirMatches` is a
 * boolean computed HERE against a caller-supplied `?dir=` query param; every
 * kill decision on the hook side goes through the PIDFILE instead (this
 * process's own `otlp-forwarder.pid`, inside the 0700 state dir it wrote —
 * filesystem-trusted, not network-trusted).
 *
 * Routing is restricted to exactly `GET /healthz` and `POST /v1/logs` — every
 * other method/path 404s — and any request carrying an `Origin` header is
 * refused outright: this relay has no CORS boundary of its own, and `Origin`
 * only appears on a browser-initiated request (e.g. a page a developer was
 * lured into opening), which should never be able to reach a loopback relay
 * that forwards the emit bearer at all.
 *
 * Two accepted, documented gaps: (1) on the FIRST session after a fresh re-point,
 * Claude Code's exporter may fire its first export before this detached spawn
 * finishes listen() → that one batch ECONNREFUSEs; OTLP batching recovers every
 * subsequent export. (2) after a plugin update the OLD forwarder keeps the port
 * until the container restarts — but config (the stash) is re-read per request, so
 * only forwarder CODE is stale, and this is a pure header-add with no versioning.
 */
import http from 'node:http'
import https from 'node:https'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './plugin-runtime.mjs'
import { assertSafeEndpoint, unsafeEndpointError } from './endpoint-guard.mjs'

const PORT = Number(process.env.TOKENSCOPE_OTLP_PROXY_PORT) || 14318
const DIR = stateDir()
const FORWARD_CONFIG = join(DIR, 'otlp-forward.json')
const LOG_FILE = join(DIR, 'otlp-forwarder.log')
// Pidfile + /healthz let the SessionStart hook self-heal a wedged/stale forwarder:
// the port bind alone can't tell "listening" from "listening but broken" (e.g. a prior
// run under a leaked HOME whose FORWARD_CONFIG resolves elsewhere). /healthz reports
// THIS process's pid + the stateDir it resolved, so the hook can detect a mismatch
// (stale) and kill the right pid; the pidfile covers the hung (no-/healthz) case.
const PID_FILE = join(DIR, 'otlp-forwarder.pid')

/** Best-effort log — NEVER logs the Authorization value. */
function log(msg) {
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* best effort */
  }
}

/** A candidate DCE value normalized to a trimmed, URL-parseable string, or null.
 * Selection-time check only — the security guards (https off-box, self-loop)
 * apply AFTER selection, to whichever source won. */
function usableCandidate(v) {
  if (typeof v !== 'string' || !v.trim()) return null
  try {
    new URL(v.trim())
  } catch {
    return null
  }
  return v.trim()
}

/** Read the real DCE logs endpoint FRESH per request: the re-point stash first,
 * else the durable env copy (TOKENSCOPE_DCE_LOGS_ENDPOINT — handed to this
 * process in its spawn env). A stash that is missing, unreadable, OR
 * malformed-but-truthy (whitespace, non-URL garbage) falls through to the env
 * copy — a corrupt stash must not defeat the durability design by shadowing a
 * valid durable value. Keeps the relay serving instead of 502ing every export
 * until a re-provision. */
function readDceEndpoint() {
  let stashed = null
  try {
    stashed = usableCandidate(JSON.parse(readFileSync(FORWARD_CONFIG, 'utf8')).dceLogsEndpoint)
  } catch {
    /* stash lost/unreadable — fall through to the durable env copy */
  }
  const envCopy = usableCandidate(process.env.TOKENSCOPE_DCE_LOGS_ENDPOINT)
  const dceLogsEndpoint = stashed ?? envCopy
  if (!dceLogsEndpoint) {
    throw new Error(
      'no usable DCE endpoint: otlp-forward.json missing/unreadable/malformed and no valid TOKENSCOPE_DCE_LOGS_ENDPOINT',
    )
  }
  const source = stashed ? 'otlp-forward.json' : 'TOKENSCOPE_DCE_LOGS_ENDPOINT'
  // Defence-in-depth: this process relays the emit bearer to whatever URL won the
  // selection. Refuse to ship it in PLAINTEXT off-box — require https for any
  // non-loopback destination (the real DCE is remote https; loopback stays on-box
  // and is what tests / local collectors use, so http there is harmless). The
  // shared validator (S1 fix 3, endpoint-guard.mjs — promoted from this exact
  // check) is the host allowlist layered ON TOP of the pre-existing self-loop
  // guard below, which stays: assertSafeEndpoint has no notion of "this
  // forwarder's own listen port".
  let parsed
  try {
    parsed = assertSafeEndpoint(dceLogsEndpoint, { allowLoopback: true })
  } catch (err) {
    // `dceLogsEndpoint` is SERVER-supplied (redeem bundle / stash), so the
    // rejected value must not reach this message — err.message embeds it.
    throw unsafeEndpointError(`${source} endpoint`, err)
  }
  // URL#hostname for an IPv6 literal INCLUDES the brackets ('[::1]', not
  // '::1') — match both forms.
  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]'
  // Never relay to OUR OWN listen address — a self-referential endpoint would loop
  // every export back into this handler forever.
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  if (loopback && port === PORT)
    throw new Error(
      `refusing self-referential DCE endpoint from ${source} (points at this forwarder)`,
    )
  return dceLogsEndpoint
}

const server = http.createServer((req, res) => {
  // Reject any request carrying an Origin header (S1 fix 6). A loopback HTTP
  // server has no CORS boundary of its own; Origin only appears on a
  // browser-initiated request, which must never be able to reach a relay
  // that forwards the emit bearer.
  if (req.headers.origin) {
    res.writeHead(403).end()
    return
  }

  // Health probe (the hook's self-heal signal). Cheap + synchronous.
  // `dirMatches` (S1 fix 6) is a BOOLEAN computed against a caller-supplied
  // `?dir=` — never the raw absolute path, and never a `pid` (see the module
  // header for why: /healthz is unauthenticated, so its response is
  // untrusted input the hook must not use to pick a SIGTERM target).
  if (req.method === 'GET' && (req.url === '/healthz' || req.url?.startsWith('/healthz?'))) {
    // `ready` = can this forwarder actually resolve its DCE endpoint RIGHT NOW.
    // Liveness (answering /healthz) is not readiness: a forwarder can be bound
    // and answering while its stash is missing/unreadable, in which case it
    // 502s every export. Reporting readiness lets the SessionStart self-heal
    // replace a dir-correct-but-stashless forwarder, not just a dead one.
    const ready = (() => {
      try {
        readDceEndpoint()
        return true
      } catch {
        return false
      }
    })()
    let expectedDir = null
    try {
      expectedDir = new URL(req.url, 'http://internal').searchParams.get('dir')
    } catch {
      /* malformed query — dirMatches stays null (unknown), never a false match */
    }
    const dirMatches = expectedDir ? expectedDir === DIR : null
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, dirMatches, ready }))
    return
  }

  // Everything else is exactly ONE route: POST /v1/logs. Restricting routing
  // (S1 fix 6) closes an overly-permissive relay that used to forward ANY
  // method/path (e.g. a stray GET) straight upstream with the bearer attached.
  if (!(req.method === 'POST' && req.url === '/v1/logs')) {
    res.writeHead(404).end()
    return
  }

  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    let url
    try {
      url = new URL(readDceEndpoint())
    } catch (err) {
      log(`config error: ${String(err)}`)
      res.writeHead(502).end('otlp-forwarder: cannot resolve DCE endpoint')
      return
    }
    // Pass through only what the DCE needs; ADD Content-Length, and never set
    // Transfer-Encoding (adding the length is the whole point of this proxy).
    const headers = { 'content-length': body.length }
    if (req.headers.authorization) headers.authorization = req.headers.authorization
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type']
    if (req.headers['content-encoding'])
      headers['content-encoding'] = req.headers['content-encoding']

    const mod = url.protocol === 'https:' ? https : http
    const up = mod.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, {
          'content-type': upRes.headers['content-type'] || 'text/plain',
        })
        upRes.pipe(res)
      },
    )
    up.on('error', (err) => {
      log(`forward error: ${String(err)}`)
      if (!res.headersSent) res.writeHead(502)
      res.end('otlp-forwarder: upstream error')
    })
    up.end(body)
  })
  req.on('error', (err) => {
    log(`request error: ${String(err)}`)
    if (!res.headersSent) res.writeHead(400)
    res.end()
  })
})

server.on('error', (e) => {
  // Singleton via the port bind: a second forwarder just exits 0 — but LOUD
  // now (S1 fix 6), not silent, so a respawn that lost the race is at least
  // attributable instead of vanishing with no trace.
  if (e.code === 'EADDRINUSE') {
    log(
      `EADDRINUSE on 127.0.0.1:${PORT} — another forwarder already holds the port; exiting (respawn lost the race, or the SessionStart self-heal did not evict the prior owner first)`,
    )
    process.exit(0)
  }
  log(`server error: ${String(e)}`)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  // Record our pid so the hook can kill a HUNG instance (one that stops answering
  // /healthz). The healthy owner's pidfile is the last writer to win the port.
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    writeFileSync(PID_FILE, String(process.pid))
  } catch {
    /* best effort — /healthz still covers the responding-but-stale case */
  }
  log(`listening on 127.0.0.1:${PORT} (pid ${process.pid})`)
})
