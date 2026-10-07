// @vitest-environment node
/*
 * The liveness probe answers without the database, through the real Front Door
 * gate, over a node socket (so the router sees the raw request path).
 *
 * Liveness restarts the replica. When it shared the bare path's `SELECT 1`, a
 * saturated pool or a Postgres blip failed it and Container Apps restarted a
 * process that was fine. `?probe=live` answers from the process alone; the bare
 * path keeps the DB check for startup, readiness and the Front Door origin probe.
 *
 * The DB module is mocked to fail exactly as an unreachable database does, so
 * the bare path's 503 in the same app proves the mock is in force.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp, createRouter, toNodeListener } from 'h3'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const dbCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('nitropack/runtime', () => ({
  useRuntimeConfig: () => ({ public: { appVersion: '9.9.9' } }),
}))
vi.mock('../../../server/db', () => ({
  getDb: () => {
    dbCalls.count++
    return { execute: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')) }
  },
}))

const { default: requireFrontDoor } = await import('../../../server/middleware/require-front-door')
const { default: health } = await import('../../../server/api/health.get')

const FDID = '9a1e0000-0000-4000-8000-000000000001'

let server: Server
let port: number

beforeAll(async () => {
  const app = createApp()
  app.use(requireFrontDoor)
  app.use(createRouter().get('/api/health', health))
  server = createServer(toNodeListener(app))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  dbCalls.count = 0
  process.env.AZURE_FRONT_DOOR_ID = FDID
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  delete process.env.AZURE_FRONT_DOOR_ID
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolvePromise, reject) => {
    // No x-azure-fdid header: this is the Container Apps probe, which does not transit Front Door.
    const req = request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (raw += c))
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: JSON.parse(raw) }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('GET /api/health?probe=live', () => {
  it('answers 200 with the DB down, Front Door enforced and no FDID header', async () => {
    const res = await get('/api/health?probe=live')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', version: '9.9.9' })
    expect(dbCalls.count, 'the live probe must not touch the database').toBe(0)
  })

  it('the bare path still checks the database (503 when it is down)', async () => {
    const res = await get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ status: 'degraded', checks: { db: 'down' } })
    expect(dbCalls.count).toBe(1)
  })

  it('any other probe value is the bare path, not liveness', async () => {
    const res = await get('/api/health?probe=ready')
    expect(res.status).toBe(503)
  })
})

describe('the rate-limiter exemption covers the live probe', () => {
  /*
   * nuxt-security 2.6.0 resolves per-route security rules by matching
   * `event.path.split('?')[0]` against the routeRules keys with radix3
   * (node_modules/nuxt-security/dist/runtime/nitro/context/index.js,
   * resolveSecurityRules). Its module ships extensionless imports that only a
   * Nuxt build resolves, so this pins that expression in the shipped module and
   * the routeRules key it is matched against, rather than importing it.
   */
  it('nuxt-security strips the query before matching', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../node_modules/nuxt-security/dist/runtime/nitro/context/index.js'),
      'utf8',
    )
    expect(src).toContain('const eventPathNoQuery = event.path.split("?")[0]')
    expect(src).toContain('matcher.matchAll(eventPathNoQuery)')
  })

  it('nuxt.config exempts /api/health from the limiter, the key the live probe strips to', () => {
    const config = readFileSync(resolve(__dirname, '../../../nuxt.config.ts'), 'utf8')
    expect(config).toMatch(/'\/api\/health':\s*\{\s*security:\s*\{\s*rateLimiter:\s*false\s*\}\s*\}/)
  })
})

describe('container-app.bicep probe wiring', () => {
  const bicep = readFileSync(resolve(__dirname, '../../../infra/modules/container-app.bicep'), 'utf8')
  const probePath = (type: string) =>
    bicep.match(new RegExp(`type:\\s*'${type}'\\s*httpGet:\\s*\\{\\s*path:\\s*'([^']+)'`))?.[1]

  it('only Liveness uses the DB-free probe', () => {
    expect(probePath('Liveness')).toBe('/api/health?probe=live')
    expect(probePath('Startup')).toBe('/api/health')
    expect(probePath('Readiness')).toBe('/api/health')
  })

  it('the Front Door origin probe keeps the DB check', () => {
    const fd = readFileSync(resolve(__dirname, '../../../infra/modules/front-door.bicep'), 'utf8')
    expect(fd).toMatch(/probePath:\s*'\/api\/health'\s*$/m)
  })
})
