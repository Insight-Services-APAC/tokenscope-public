// @vitest-environment node
/*
 * LocalCollectorReader — interface against the telemetry store HTTP shape.
 *
 * Spins a tiny in-process HTTP server matching the store's contract
 * (GET /v1/sessions/:sid/usage); verifies the reader parses and returns
 * UsageRecords correctly.
 */
import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { LocalCollectorReader } from '../../../server/azure/reader'

let server: Server
let url = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && /^\/v1\/sessions\/[^/]+\/usage$/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          session_id: req.url!.split('/')[3],
          usage: [
            { tokens: 100, tokenType: 'input', model: 'claude-sonnet', tsEvent: '2026-05-24T10:00:00Z' },
            { tokens: 200, tokenType: 'output', model: 'claude-sonnet', tsEvent: '2026-05-24T10:00:01Z' },
          ],
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      url = `http://127.0.0.1:${port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('LocalCollectorReader', () => {
  it('fetches usage for a session and validates the response shape', async () => {
    const reader = new LocalCollectorReader(url)
    const usage = await reader.getSessionUsage('11111111-1111-1111-1111-111111111111')
    expect(usage).toHaveLength(2)
    expect(usage[0]!.tokens).toBe(100)
    expect(usage[0]!.tokenType).toBe('input')
    expect(usage[1]!.tokens).toBe(200)
  })

  it('throws on non-2xx', async () => {
    const reader = new LocalCollectorReader(url + '/wrong')
    await expect(
      reader.getSessionUsage('11111111-1111-1111-1111-111111111111'),
    ).rejects.toThrow(/HTTP 404/)
  })

  it('ING-10: rejects a non-UUID-shaped session id before any network call', async () => {
    // Charset guard — only DB-sourced UUIDs are legitimate; anything carrying a
    // quote/backslash could break out of the KQL string literal in the
    // LogAnalyticsReader twin, so both implementations refuse at the top.
    const reader = new LocalCollectorReader(url)
    await expect(reader.getSessionUsage('any')).rejects.toThrow(/36-char UUID/)
    await expect(reader.getSessionUsage(`' | union OTelLogs | where 1==1 --pad`)).rejects.toThrow(/36-char UUID/)
  })

  it('throws on schema mismatch', async () => {
    const localServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ session_id: 'sid', usage: [{ unexpected: 'shape' }] }))
    })
    await new Promise<void>((r) => localServer.listen(0, '127.0.0.1', () => r()))
    const addr = localServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const reader = new LocalCollectorReader(`http://127.0.0.1:${port}`)
    await expect(reader.getSessionUsage('22222222-2222-2222-2222-222222222222')).rejects.toThrow()
    await new Promise<void>((r) => localServer.close(() => r()))
  })
})
