/*
 * otlp-forwarder — the local Content-Length pass-through for Claude Code's OTLP
 * logs (CC #72671 workaround). This test spawns the REAL script (as production
 * does) pointed at a mock "DCE", POSTs a chunked body through it, and asserts:
 *   - the mock received a Content-Length header (NOT Transfer-Encoding: chunked)
 *   - the pass-through Authorization + Content-Type survived
 *   - the mock received the SAME body bytes
 *   - the caller got the mock's status code back
 *
 * No real Azure, no daemon lifecycle machinery — the forwarder is stateless.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const FORWARDER = resolve(fileURLToPath(import.meta.url), '../../../../plugin/scripts/otlp-forwarder.mjs')

/** Poll until `fn()` resolves truthy or the deadline passes. */
async function waitFor<T>(fn: () => Promise<T> | T, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* keep polling */
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for forwarder')
    await new Promise((r) => setTimeout(r, 50))
  }
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => res(p))
    })
    s.on('error', rej)
  })
}

let dir = ''
let child: ChildProcess | null = null
let mock: http.Server | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-otlp-fwd-'))
})
afterEach(() => {
  if (child) child.kill('SIGKILL')
  child = null
  if (mock) mock.close()
  mock = null
  rmSync(dir, { recursive: true, force: true })
})

describe('otlp-forwarder (spawned)', () => {
  it('adds Content-Length, passes through auth + body, and returns the DCE status', async () => {
    // ── mock DCE ──
    const received: {
      contentLength?: string
      transferEncoding?: string
      authorization?: string
      contentType?: string
      body?: Buffer
    } = {}
    const mockPort = await freePort()
    mock = http.createServer((req, res) => {
      received.contentLength = req.headers['content-length']
      received.transferEncoding = req.headers['transfer-encoding']
      received.authorization = req.headers.authorization
      received.contentType = req.headers['content-type']
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        received.body = Buffer.concat(chunks)
        res.writeHead(204).end() // mimic the DCE's success code
      })
    })
    await new Promise<void>((r) => mock!.listen(mockPort, '127.0.0.1', r))

    // ── stash the mock as the "DCE" the forwarder reads fresh per request ──
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'otlp-forward.json'),
      JSON.stringify({ dceLogsEndpoint: `http://127.0.0.1:${mockPort}/v1/logs` }),
    )

    // ── spawn the real forwarder on an ephemeral port ──
    const proxyPort = await freePort()
    child = spawn(process.execPath, [FORWARDER], {
      env: {
        ...process.env,
        TOKENSCOPE_STATE_DIR: dir,
        TOKENSCOPE_OTLP_PROXY_PORT: String(proxyPort),
      },
      stdio: 'ignore',
    })

    // ── wait for the port to accept connections ──
    await waitFor(
      () =>
        new Promise<boolean>((res) => {
          const req = http.request(
            { method: 'GET', host: '127.0.0.1', port: proxyPort, path: '/health', timeout: 200 },
            (r) => {
              r.resume()
              res(true)
            },
          )
          req.on('error', () => res(false))
          req.on('timeout', () => {
            req.destroy()
            res(false)
          })
          req.end()
        }),
    )

    // ── POST a CHUNKED body (no Content-Length) through the forwarder ──
    const payload = Buffer.from('the-otlp-protobuf-bytes-🚀', 'utf8')
    const status = await new Promise<number>((res, rej) => {
      const req = http.request(
        {
          method: 'POST',
          host: '127.0.0.1',
          port: proxyPort,
          path: '/v1/logs',
          headers: {
            authorization: 'Bearer secret-passthrough',
            'content-type': 'application/x-protobuf',
            // Deliberately NO content-length → Node uses Transfer-Encoding: chunked,
            // exactly the CC #72671 shape the forwarder exists to repair.
          },
        },
        (r) => {
          r.resume()
          r.on('end', () => res(r.statusCode || 0))
        },
      )
      req.on('error', rej)
      // Write in two chunks to force chunked framing.
      req.write(payload.subarray(0, 5))
      req.end(payload.subarray(5))
    })

    // ── assertions ──
    expect(status).toBe(204) // the mock's status piped back to the caller
    expect(received.contentLength).toBe(String(payload.length)) // the whole point
    expect(received.transferEncoding).toBeUndefined() // NOT chunked upstream
    expect(received.authorization).toBe('Bearer secret-passthrough') // passed through
    expect(received.contentType).toBe('application/x-protobuf')
    expect(received.body?.equals(payload)).toBe(true) // byte-for-byte identical
  })

  it('refuses a non-loopback plaintext (http) destination with 502 — no bearer exfil off-box', async () => {
    // A tampered/corrupt stash pointing at http://<remote> must NOT get the bearer:
    // the forwarder 502s at readDceEndpoint BEFORE any upstream call.
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'otlp-forward.json'),
      JSON.stringify({ dceLogsEndpoint: 'http://attacker.example.com/v1/logs' }),
    )
    const proxyPort = await freePort()
    child = spawn(process.execPath, [FORWARDER], {
      env: { ...process.env, TOKENSCOPE_STATE_DIR: dir, TOKENSCOPE_OTLP_PROXY_PORT: String(proxyPort) },
      stdio: 'ignore',
    })
    await waitFor(
      () =>
        new Promise<boolean>((res) => {
          const req = http.request(
            { method: 'GET', host: '127.0.0.1', port: proxyPort, path: '/health', timeout: 200 },
            (r) => {
              r.resume()
              res(true)
            },
          )
          req.on('error', () => res(false))
          req.on('timeout', () => {
            req.destroy()
            res(false)
          })
          req.end()
        }),
    )
    const status = await new Promise<number>((res, rej) => {
      const req = http.request(
        {
          method: 'POST',
          host: '127.0.0.1',
          port: proxyPort,
          path: '/v1/logs',
          headers: { authorization: 'Bearer secret', 'content-type': 'application/x-protobuf' },
        },
        (r) => {
          r.resume()
          r.on('end', () => res(r.statusCode || 0))
        },
      )
      req.on('error', rej)
      req.end(Buffer.from('x'))
    })
    expect(status).toBe(502) // refused before any upstream call
  })
})
