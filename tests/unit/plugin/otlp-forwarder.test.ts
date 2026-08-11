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

  it('serves from the DURABLE env copy when the stash file is lost (ephemeral state dir)', async () => {
    // The stash can die with a container rebuild while the settings env (which
    // reaches this process via its spawn environment) survives. The forwarder must
    // keep relaying — and report ready:true so the session-start self-heal does not
    // kill-loop it as "dir-correct-but-stashless".
    const received: { contentLength?: string } = {}
    const mockPort = await freePort()
    mock = http.createServer((req, res) => {
      received.contentLength = req.headers['content-length']
      req.resume()
      req.on('end', () => res.writeHead(204).end())
    })
    await new Promise<void>((r) => mock!.listen(mockPort, '127.0.0.1', r))

    mkdirSync(dir, { recursive: true }) // state dir exists but has NO otlp-forward.json
    const proxyPort = await freePort()
    child = spawn(process.execPath, [FORWARDER], {
      env: {
        ...process.env,
        TOKENSCOPE_STATE_DIR: dir,
        TOKENSCOPE_OTLP_PROXY_PORT: String(proxyPort),
        TOKENSCOPE_DCE_LOGS_ENDPOINT: `http://127.0.0.1:${mockPort}/v1/logs`,
      },
      stdio: 'ignore',
    })
    const health = await waitFor(
      () =>
        new Promise<{ ready?: boolean } | false>((res) => {
          const req = http.request(
            { method: 'GET', host: '127.0.0.1', port: proxyPort, path: '/healthz', timeout: 200 },
            (r) => {
              const chunks: Buffer[] = []
              r.on('data', (c) => chunks.push(c))
              r.on('end', () => {
                try {
                  res(JSON.parse(Buffer.concat(chunks).toString()))
                } catch {
                  res(false)
                }
              })
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
    expect(health && health.ready).toBe(true) // env fallback counts as ready

    const status = await new Promise<number>((res, rej) => {
      const req = http.request(
        {
          method: 'POST',
          host: '127.0.0.1',
          port: proxyPort,
          path: '/v1/logs',
          headers: { 'content-type': 'application/x-protobuf' },
        },
        (r) => {
          r.resume()
          r.on('end', () => res(r.statusCode || 0))
        },
      )
      req.on('error', rej)
      req.write(Buffer.from('ab'))
      req.end(Buffer.from('c')) // chunked framing, as CC sends it
    })
    expect(status).toBe(204) // relayed via the env fallback
    expect(received.contentLength).toBe('3') // and still repaired to Content-Length
  })

  it('a CORRUPT (malformed-but-truthy) stash does not shadow the durable env copy', async () => {
    // Copilot review catch: a stash whose dceLogsEndpoint is truthy garbage used
    // to be accepted as authoritative and 502 at new URL(), never consulting the
    // env fallback — a corrupt stash defeated the durability design.
    const mockPort = await freePort()
    mock = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => res.writeHead(204).end())
    })
    await new Promise<void>((r) => mock!.listen(mockPort, '127.0.0.1', r))

    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'otlp-forward.json'), JSON.stringify({ dceLogsEndpoint: '   not a url   ' }))

    const proxyPort = await freePort()
    child = spawn(process.execPath, [FORWARDER], {
      env: {
        ...process.env,
        TOKENSCOPE_STATE_DIR: dir,
        TOKENSCOPE_OTLP_PROXY_PORT: String(proxyPort),
        TOKENSCOPE_DCE_LOGS_ENDPOINT: `http://127.0.0.1:${mockPort}/v1/logs`,
      },
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
        { method: 'POST', host: '127.0.0.1', port: proxyPort, path: '/v1/logs' },
        (r) => {
          r.resume()
          r.on('end', () => res(r.statusCode || 0))
        },
      )
      req.on('error', rej)
      req.end(Buffer.from('x'))
    })
    expect(status).toBe(204) // relayed via the env copy — corrupt stash skipped
  })

  it('refuses a SELF-REFERENTIAL DCE (its own listen address) with 502 — no infinite relay loop', async () => {
    // A DCE value pointing back at the forwarder itself would loop every export
    // into this handler forever. The guard must fire from the env fallback too.
    mkdirSync(dir, { recursive: true }) // no stash — env fallback path
    const proxyPort = await freePort()
    child = spawn(process.execPath, [FORWARDER], {
      env: {
        ...process.env,
        TOKENSCOPE_STATE_DIR: dir,
        TOKENSCOPE_OTLP_PROXY_PORT: String(proxyPort),
        TOKENSCOPE_DCE_LOGS_ENDPOINT: `http://127.0.0.1:${proxyPort}/v1/logs`,
      },
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
        { method: 'POST', host: '127.0.0.1', port: proxyPort, path: '/v1/logs' },
        (r) => {
          r.resume()
          r.on('end', () => res(r.statusCode || 0))
        },
      )
      req.on('error', rej)
      req.end(Buffer.from('x'))
    })
    expect(status).toBe(502) // refused before any relay — no loop
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

  // ── S1 fix 6: /healthz shape, Origin rejection, routing restriction ────────
  describe('S1 fix 6 — forwarder hardening', () => {
    async function spawnForwarderReady(proxyPort: number, extraEnv: Record<string, string> = {}) {
      mkdirSync(dir, { recursive: true })
      child = spawn(process.execPath, [FORWARDER], {
        env: { ...process.env, TOKENSCOPE_STATE_DIR: dir, TOKENSCOPE_OTLP_PROXY_PORT: String(proxyPort), ...extraEnv },
        stdio: 'ignore',
      })
      await waitFor(
        () =>
          new Promise<boolean>((res) => {
            const req = http.request(
              { method: 'GET', host: '127.0.0.1', port: proxyPort, path: '/healthz', timeout: 200 },
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
    }

    /** GET a path, optionally with an Origin header; resolve {status, body}. */
    function getPath(proxyPort: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
      return new Promise((resolve_, reject) => {
        const req = http.request({ method: 'GET', host: '127.0.0.1', port: proxyPort, path, headers }, (r) => {
          const chunks: Buffer[] = []
          r.on('data', (c) => chunks.push(c))
          r.on('end', () => resolve_({ status: r.statusCode || 0, body: Buffer.concat(chunks).toString() }))
        })
        req.on('error', reject)
        req.end()
      })
    }

    it('/healthz omits pid and the absolute dir — reports dirMatches (boolean) instead', async () => {
      const proxyPort = await freePort()
      await spawnForwarderReady(proxyPort)
      const { status, body } = await getPath(proxyPort, `/healthz?dir=${encodeURIComponent(dir)}`)
      expect(status).toBe(200)
      const parsed = JSON.parse(body)
      expect(parsed.ok).toBe(true)
      expect(parsed).not.toHaveProperty('pid')
      expect(parsed).not.toHaveProperty('dir')
      expect(parsed.dirMatches).toBe(true) // we passed OUR OWN dir — matches
      expect(typeof parsed.ready).toBe('boolean')
    })

    it('/healthz dirMatches is false for a mismatched ?dir= (and null when omitted)', async () => {
      const proxyPort = await freePort()
      await spawnForwarderReady(proxyPort)
      const mismatched = await getPath(proxyPort, `/healthz?dir=${encodeURIComponent('/some/other/dir')}`)
      expect(JSON.parse(mismatched.body).dirMatches).toBe(false)
      const omitted = await getPath(proxyPort, '/healthz')
      expect(JSON.parse(omitted.body).dirMatches).toBeNull()
    })

    it('rejects any request carrying an Origin header (403) — a loopback relay has no CORS boundary of its own', async () => {
      const proxyPort = await freePort()
      await spawnForwarderReady(proxyPort)
      const { status } = await getPath(proxyPort, '/healthz', { Origin: 'https://evil.example.com' })
      expect(status).toBe(403)
    })

    it('an unknown path 404s (routing restricted to GET /healthz + POST /v1/logs)', async () => {
      const proxyPort = await freePort()
      await spawnForwarderReady(proxyPort)
      const { status } = await getPath(proxyPort, '/anything-else')
      expect(status).toBe(404)
    })

    it('GET /v1/logs (wrong method for that path) 404s — routing is method-AND-path restricted', async () => {
      const proxyPort = await freePort()
      await spawnForwarderReady(proxyPort)
      const { status } = await getPath(proxyPort, '/v1/logs')
      expect(status).toBe(404)
    })
  })
})
