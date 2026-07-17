// Header+body capture server for the CC #72671 re-test (see retest-72671.sh).
// Logs each request's method/httpVersion/headers to a jsonl and saves the raw
// body to a .bin, so the re-test can verify (a) Content-Length vs chunked and
// (b) trace_id/span_id presence in OTLP log records when TRACEPARENT is set.
// Replies 200 like the DCE would. Args: <outJsonl> <port>.
import http from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

const OUT = process.argv[2] || '/tmp/otlp-capture.jsonl'
const PORT = Number(process.argv[3]) || 14319
let n = 0

http
  .createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const headers = { ...req.headers }
      if (headers.authorization) headers.authorization = '<redacted>'
      const bodyPath = `${OUT}.${++n}.bin`
      writeFileSync(bodyPath, body)
      appendFileSync(
        OUT,
        JSON.stringify({
          method: req.method,
          httpVersion: req.httpVersion,
          transferEncoding: headers['transfer-encoding'] ?? null,
          contentLength: headers['content-length'] ?? null,
          userAgent: headers['user-agent'] ?? null,
          bodyBytes: body.length,
          bodyPath,
        }) + '\n',
      )
      res.writeHead(200, { 'content-type': 'application/x-protobuf' })
      res.end()
    })
  })
  .listen(PORT, '127.0.0.1', () => console.log(`capture on ${PORT} → ${OUT}`))
