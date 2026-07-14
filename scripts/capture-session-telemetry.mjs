#!/usr/bin/env node
/*
 * capture-session-telemetry.mjs — STOPGAP "future-self" emit.
 *
 * Manually emit ONE `api_request` OTLP-logs record (the exact shape the future Copilot
 * transcode-forward unit will write — see docs/build/copilot-client-support.md §4) to the
 * sandbox Log Analytics Workspace, so a session's spend is captured in TokenScope BEFORE the
 * Copilot client/forwarder exists. Use it to bank the design session, the Sonnet build
 * session, etc. — they join once the project/instance are in place (the read joiner rescans
 * OTelLogs). DELETE this script once the real Copilot forwarder (Slice 3) ships.
 *
 * It reuses the production pieces: the plugin's OTLP-logs protobuf encoder + the
 * otel-headers-helper.sh bearer mint (refresh + 401 self-heal). NO secrets live here — creds
 * + endpoints are read from the enrolled device config (~/.claude/settings.json today,
 * ~/.tokenscope when Copilot enrol lands).
 *
 * Usage:
 *   node scripts/capture-session-telemetry.mjs --credits 5015 \
 *     [--model claude-opus-4.8] [--session <conversation-id>] [--project TokenScope-MVP] \
 *     [--instance <uuid>] [--tool copilot-cli] [--note "..."] \
 *     [--input N --output N --cache-read N --cache-creation N] [--dry-run]
 *
 * Required: --credits (the AI credits; cost_usd = credits × $0.01 once Slice-4 pricing lands).
 * Defaults: model=claude-opus-4.8, project=TokenScope-MVP, tool=copilot-cli, session=random,
 *   instance=auto-detected from the enrolled device. Token counts default to a representative
 *   split scaled from credits (so the record shows a plausible cost under today's token-based
 *   joiner too); pass explicit --input/--output/etc. if you know them.
 */
import fs from 'node:fs'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { encodeExportLogsServiceRequest } from '../plugin/scripts/backfill.mjs'

// ── args ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const k = argv[i].slice(2)
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i++, i)] : 'true'
    a[k] = v
  }
  return a
}
const args = parseArgs(process.argv.slice(2))
const credits = Number(args.credits)
if (!Number.isFinite(credits) || credits <= 0) {
  console.error('ERROR: --credits <positive number> is required (the session AI credits).')
  process.exit(2)
}
const model = args.model ?? 'claude-opus-4.8'
const projectCode = args.project ?? 'TokenScope-MVP'
const tool = args.tool ?? 'copilot-cli'
const sessionId = args.session ?? randomUUID()
const note = args.note ?? `TokenScope session capture (${projectCode})`
const dryRun = args['dry-run'] === 'true'

// ── enrolled-device config (no secrets in this file) ────────────────────────────
const HOME = process.env.HOME
function loadEnrolment() {
  // Prefer the Copilot-native ~/.tokenscope (future); fall back to ~/.claude/settings.json.
  const claude = join(HOME, '.claude', 'settings.json')
  if (fs.existsSync(claude)) {
    const env = JSON.parse(fs.readFileSync(claude, 'utf8')).env ?? {}
    if (env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT && env.TOKENSCOPE_BEARER_ENDPOINT) return env
  }
  throw new Error('No enrolled device config found (~/.claude/settings.json). Enrol first.')
}
const env = loadEnrolment()
const logsUrl = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
const instanceId =
  args.instance ??
  (/(?:^|,)\s*tokenscope\.instance_id=([^,]+)/.exec(env.OTEL_RESOURCE_ATTRIBUTES ?? '')?.[1]?.trim())
if (!instanceId) {
  console.error('ERROR: could not resolve --instance and none in the enrolment OTEL_RESOURCE_ATTRIBUTES.')
  process.exit(2)
}

const projectHash = createHash('sha256').update(projectCode).digest('hex')
const nanoAiu = String(Math.round(credits * 1_000_000_000)) // credits → nano_aiu
// representative token split scaled from credits (≈ agentic mix), unless overridden.
const tok = {
  input_tokens: Number(args.input ?? Math.round(credits * 660)),
  output_tokens: Number(args.output ?? Math.round(credits * 133)),
  cache_read_tokens: Number(args['cache-read'] ?? Math.round(credits * 400)),
  cache_creation_tokens: Number(args['cache-creation'] ?? Math.round(credits * 80)),
}
const reqId = randomBytes(8).toString('hex')
const ns = String(Date.now()) + '000000'

const KV = (k, v, t = 'stringValue') => ({ key: k, value: { [t]: v } })
const payload = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          KV('tokenscope.instance_id', instanceId),
          KV('project.code_hash', projectHash),
          KV('tool', tool),
          KV('service.name', 'github-copilot'),
        ],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: ns,
              severityNumber: 9,
              body: { stringValue: 'api_request' },
              attributes: [
                KV('event.name', 'api_request'),
                KV('session.id', sessionId),
                KV('request_id', reqId),
                KV('model', model),
                KV('input_tokens', String(tok.input_tokens), 'intValue'),
                KV('output_tokens', String(tok.output_tokens), 'intValue'),
                KV('cache_read_tokens', String(tok.cache_read_tokens), 'intValue'),
                KV('cache_creation_tokens', String(tok.cache_creation_tokens), 'intValue'),
                KV('github.copilot.nano_aiu', nanoAiu, 'intValue'),
                KV('ai_credits', String(credits), 'intValue'),
                KV('capture_note', note),
              ],
            },
          ],
        },
      ],
    },
  ],
}

console.log('project        =', projectCode, '→', projectHash)
console.log('instance       =', instanceId)
console.log('session        =', sessionId)
console.log('model / tool   =', model, '/', tool)
console.log('credits        =', credits, '(nano_aiu', nanoAiu + ') → future cost $' + (credits * 0.01).toFixed(2))
console.log('tokens (in/out/cr/cc) =', tok.input_tokens, tok.output_tokens, tok.cache_read_tokens, tok.cache_creation_tokens)
console.log('request_id     =', reqId)

function httpsReq(method, url, headers, body) {
  return new Promise((r) => {
    const u = new URL(url)
    const d = Buffer.isBuffer(body) ? body : Buffer.from(body)
    const rq = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers: { ...headers, 'content-length': d.length } },
      (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => r({ status: x.statusCode, body: b.slice(0, 300) })) },
    )
    rq.on('error', (e) => r({ status: 0, body: String(e) }))
    rq.write(d); rq.end()
  })
}

const proto = encodeExportLogsServiceRequest(payload)
if (dryRun) {
  console.log('\n[dry-run] protobuf bytes =', proto.length, '— NOT emitted.')
  process.exit(0)
}
// mint the Azure ingest bearer via the real helper (refresh + 401 self-heal)
const here = dirname(fileURLToPath(import.meta.url))
const helper = join(here, '..', 'plugin', 'scripts', 'otel-headers-helper.sh')
const az = JSON.parse(
  execFileSync('sh', [helper], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      TOKENSCOPE_BEARER_ENDPOINT: env.TOKENSCOPE_BEARER_ENDPOINT,
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: env.TOKENSCOPE_OAUTH_REFRESH_TOKEN,
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT,
      TOKENSCOPE_OAUTH_CLIENT_ID: env.TOKENSCOPE_OAUTH_CLIENT_ID,
      TOKENSCOPE_STATE_DIR: join(HOME, '.tokenscope'),
    },
  }),
).Authorization
const res = await httpsReq('POST', logsUrl, { authorization: az, 'content-type': 'application/x-protobuf' }, proto)
console.log('\n--> Azure LAW ingest HTTP', res.status, res.status === 204 ? '(accepted)' : res.body)
process.exit(res.status === 204 ? 0 : 1)
