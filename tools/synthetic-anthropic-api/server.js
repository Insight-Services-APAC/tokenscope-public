// synthetic-anthropic-api — mock /v1/organizations/usage_report/claude_code.
//
// Real API shape (per RN-15 + docs.anthropic.com):
//   GET /v1/organizations/usage_report/claude_code
//     ?starting_at=YYYY-MM-DD&ending_at=YYYY-MM-DD
//   → {
//       data: [{
//         date: "YYYY-MM-DD",
//         records: [{
//           actor: { type: "user", email_address: "..." },
//           subscription_type: "Claude Code (per token)",
//           total_input_tokens: N,
//           total_output_tokens: N,
//           total_cache_read_tokens: N,
//           total_cache_creation_tokens: N,
//           total_cost_usd: "0.0000"
//         }]
//       }],
//       has_more: false
//     }
//
// Deterministic: same window → same payload (date * user-index sets a
// pseudo-random scale factor). This means the poller can re-pull and
// the upsert is genuinely idempotent.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const seed = JSON.parse(readFileSync(join(here, 'seed.json'), 'utf8'))
const port = Number(process.env.PORT || 8080)

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function scaleFor(date, idx) {
  // tiny deterministic LCG so repeated calls return identical data.
  const seedNum = date.split('-').reduce((acc, p) => acc * 31 + Number(p), 0) * 17 + idx * 7
  const n = (seedNum * 9301 + 49297) % 233280
  return 0.6 + (n / 233280) * 0.8 // 0.6 .. 1.4
}

function buildResponse(start, end) {
  const startDate = new Date(start)
  const endDate = new Date(end)
  const data = []
  for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10)
    const records = seed.users.map((u, idx) => {
      const scale = scaleFor(date, idx)
      const inT = Math.round(u.base_input * scale)
      const outT = Math.round(u.base_output * scale)
      const cost =
        (inT / 1_000_000) * seed.price_per_million_input +
        (outT / 1_000_000) * seed.price_per_million_output
      return {
        actor: { type: 'user', email_address: u.email },
        subscription_type: 'Claude Code (per token)',
        total_input_tokens: inT,
        total_output_tokens: outT,
        total_cache_read_tokens: 0,
        total_cache_creation_tokens: 0,
        total_cost_usd: cost.toFixed(4),
      }
    })
    data.push({ date, records })
  }
  return { data, has_more: false }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, { service: 'synthetic-anthropic-api', status: 'ok' })
  }

  if (req.method === 'GET' && url.pathname === '/v1/organizations/usage_report/claude_code') {
    const start = url.searchParams.get('starting_at')
    const end = url.searchParams.get('ending_at')
    if (!start || !end) {
      return send(res, 400, { error: 'starting_at + ending_at required' })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return send(res, 400, { error: 'dates must be YYYY-MM-DD' })
    }
    return send(res, 200, buildResponse(start, end))
  }

  send(res, 404, { error: 'not found', path: url.pathname })
})

server.listen(port, '0.0.0.0', () => {
  console.log(`synthetic-anthropic-api listening on :${port}`)
})
