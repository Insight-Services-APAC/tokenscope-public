#!/usr/bin/env node
 
/*
 * cron-trigger.mjs — sign + POST to the internal run-worker HTTP endpoint.
 *
 * This is the Azure-native realisation of the external-cron contract in
 * docs/build/worker-scheduler.md. It runs as an Azure Container Apps *Cron Job*
 * (one job per worker, each with its own schedule), reusing the app image
 * (node 22 → node:crypto + global fetch; no extra deps). Plain .mjs so it runs
 * without tsx (which is pruned from the production image).
 *
 * Why HTTP and not a direct DB call: the run-worker endpoint is the documented,
 * multi-instance-safe, observable trigger surface. /api/v1/internal/* is NOT
 * front-door-exempt, so the job must call the public Front Door URL (which
 * injects X-Azure-FDID); calling the container-app FQDN directly would 403.
 *
 * Env:
 *   WORKER_NAME                   registry worker name (e.g. azure-monitor-read)
 *   TOKENSCOPE_BASE_URL           Front Door origin, e.g. https://<ep>.azurefd.net
 *   NUXT_INTERNAL_WORKER_HMAC_KEY shared HMAC key (same as the app's)
 *   CRON_TRIGGER_TIMEOUT_MS       optional, default 120000
 *   DEEP_RESCAN                   optional; 'true' forces azure-monitor-read to
 *                                 re-read the full window (read-path backlog
 *                                 recovery). Ignored by every other worker.
 */
import { createHash, createHmac } from 'node:crypto'

const name = process.env.WORKER_NAME
const base = (process.env.TOKENSCOPE_BASE_URL ?? '').replace(/\/+$/, '')
const key = process.env.NUXT_INTERNAL_WORKER_HMAC_KEY
const timeoutMs = Number(process.env.CRON_TRIGGER_TIMEOUT_MS ?? 120000)

if (!name || !base || !key) {
  console.error('cron-trigger: missing WORKER_NAME / TOKENSCOPE_BASE_URL / NUXT_INTERNAL_WORKER_HMAC_KEY')
  process.exit(2)
}

const path = `/api/v1/internal/run-worker/${name}`
// Operator lever: a one-off ACA job execution with DEEP_RESCAN=true forces the
// azure-monitor-read gatherer to ignore per-instance watermarks and re-read the
// full window (recover a read-path backlog). The body is INSIDE the signed
// payload (its sha256 below), so setting it keeps the signature valid — no
// scheme change. Every other worker ignores the flag.
const body = JSON.stringify(process.env.DEEP_RESCAN === 'true' ? { deepRescan: true } : {})
const ts = Math.floor(Date.now() / 1000)
const bodySha = createHash('sha256').update(body).digest('hex')
// payload = `${timestamp}\n${method}\n${path}\n${sha256_hex(body)}` (server contract)
const sig = createHmac('sha256', key).update(`${ts}\nPOST\n${path}\n${bodySha}`).digest('hex')

const ac = new AbortController()
const timer = setTimeout(() => ac.abort(), timeoutMs)
try {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Timestamp': String(ts),
      'X-Internal-Signature': sig,
    },
    body,
    signal: ac.signal,
  })
  const text = await res.text()
  console.log(`[cron-trigger] ${name} -> HTTP ${res.status} ${text.slice(0, 400)}`)
  process.exit(res.ok ? 0 : 1)
} catch (err) {
  console.error(`[cron-trigger] ${name} failed:`, err instanceof Error ? err.message : err)
  process.exit(1)
} finally {
  clearTimeout(timer)
}
