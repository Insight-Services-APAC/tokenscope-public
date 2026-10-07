/*
 * The telemetry-cap ops alert compares today's ingestion against
 * TELEMETRY_DAILY_CAP_GB. That number must be the one that actually caps the
 * telemetry workspace, so it travels from the Bicep value that sets the cap
 * rather than being stated twice (docs/design/scaling-to-1000-users.md 0.5).
 * Every hop is a plain string in Bicep; none fails a deploy when crossed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const MAIN = readFileSync(resolve(ROOT, 'infra/main.bicep'), 'utf8')
const MONITORING = readFileSync(resolve(ROOT, 'infra/modules/monitoring.bicep'), 'utf8')
const CONTAINER_APP = readFileSync(resolve(ROOT, 'infra/modules/container-app.bicep'), 'utf8')
const OPS_ALERT = readFileSync(resolve(ROOT, 'server/workers/ops-alert.ts'), 'utf8')

function resourceBlock(src: string, symbol: string): string {
  const start = src.search(new RegExp(`^resource ${symbol} `, 'm'))
  expect(start, `resource ${symbol} not found`).toBeGreaterThanOrEqual(0)
  const rest = src.slice(start)
  const end = rest.slice(1).search(/^(resource|module|output|var|param) /m)
  return end === -1 ? rest : rest.slice(0, end + 1)
}

describe('TELEMETRY_DAILY_CAP_GB comes from the value that caps the telemetry workspace', () => {
  it('the telemetry workspace is capped by dailyIngestionCapGb, and the module outputs that same param', () => {
    expect(resourceBlock(MONITORING, 'logAnalytics')).toMatch(/dailyQuotaGb:\s*dailyIngestionCapGb\b/)
    expect(MONITORING).toMatch(/^output telemetryDailyCapGb int = dailyIngestionCapGb$/m)
  })

  it('main.bicep hands the module output to the container app', () => {
    expect(MAIN).toMatch(/^\s*telemetryDailyCapGb:\s*monitoring\.outputs\.telemetryDailyCapGb$/m)
  })

  it('the container app sets the env var from that param, beside the telemetry reader it belongs to', () => {
    expect(CONTAINER_APP).toMatch(/^param telemetryDailyCapGb int = 0$/m)
    const readerBlock = CONTAINER_APP.slice(CONTAINER_APP.indexOf('var telemetryReaderEnvVars'))
    expect(readerBlock.slice(0, readerBlock.indexOf('] : []'))).toMatch(
      /\{\s*name:\s*'TELEMETRY_DAILY_CAP_GB',\s*value:\s*string\(telemetryDailyCapGb\)\s*\}/,
    )
  })

  it('the worker reads the same env var name', () => {
    expect(OPS_ALERT).toContain('process.env.TELEMETRY_DAILY_CAP_GB')
  })
})
