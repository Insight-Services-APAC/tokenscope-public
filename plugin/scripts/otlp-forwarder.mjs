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
 * (harmless). Still no byte-offset, catch-up, or retry — this is a stateless
 * header-add, not the copilot daemon. It DOES expose GET /healthz ({ok,pid,dir})
 * and write a pidfile, purely so the SessionStart hook can tell a working forwarder
 * from a bound-but-broken one (a prior run under a leaked HOME resolving a different
 * stateDir) and replace the latter — the port bind alone can't. The listening
 * server keeps the process alive; it dies with the container.
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

/** Read the real DCE logs endpoint FRESH per request (from the re-point stash). */
function readDceEndpoint() {
  const { dceLogsEndpoint } = JSON.parse(readFileSync(FORWARD_CONFIG, 'utf8'))
  if (!dceLogsEndpoint) throw new Error('otlp-forward.json missing dceLogsEndpoint')
  // Defence-in-depth: this process relays the emit bearer to whatever URL the stash
  // holds. Refuse to ship it in PLAINTEXT off-box — require https for any non-loopback
  // destination (the real DCE is remote https; loopback stays on-box and is what
  // tests / local collectors use, so http there is harmless).
  const parsed = new URL(dceLogsEndpoint)
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1'
  if (parsed.protocol !== 'https:' && !loopback) {
    throw new Error(`otlp-forward.json endpoint must be https for a non-loopback host, got ${parsed.protocol}//${parsed.hostname}`)
  }
  return dceLogsEndpoint
}

const server = http.createServer((req, res) => {
  // Health probe (the hook's self-heal signal). Cheap + synchronous; reports the
  // stateDir THIS process resolved so the hook can spot a stale/wrong-HOME instance.
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, pid: process.pid, dir: DIR }))
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
    if (req.headers['content-encoding']) headers['content-encoding'] = req.headers['content-encoding']

    const mod = url.protocol === 'https:' ? https : http
    const up = mod.request(
      { method: 'POST', hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, { 'content-type': upRes.headers['content-type'] || 'text/plain' })
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
  // Singleton via the port bind: a second forwarder just exits 0 (harmless).
  if (e.code === 'EADDRINUSE') process.exit(0)
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
