/*
 * useFormat guards (FE-12 / SYS-5) — money/token/time formatters must never
 * render "$NaN" / "NaNd ago" into financial columns: missing or malformed
 * input falls back to an em-dash. Also covers the consolidated options the
 * per-page copies needed (whole-dollar mode, B token tier, signed negatives).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fmtUsd,
  fmtTokens,
  fmtDurationMs,
  fmtTimeAgo,
  fmtPct,
  fmtSharePct,
  signedPct,
  clientMeta,
} from '../../../app/composables/useFormat'

describe('fmtUsd', () => {
  it('formats cents with thousands separators by default', () => {
    expect(fmtUsd(1234.5)).toBe('$1,234.50')
    expect(fmtUsd('1234.5')).toBe('$1,234.50')
    expect(fmtUsd(0)).toBe('$0.00')
  })

  it('whole-dollar mode rounds to integers (finance/rollup tables)', () => {
    expect(fmtUsd(1234.56, { whole: true })).toBe('$1,235')
    expect(fmtUsd('0.4', { whole: true })).toBe('$0')
  })

  it('renders negatives with a leading sign, not "$-x"', () => {
    expect(fmtUsd(-12.5)).toBe('-$12.50')
    expect(fmtUsd('-1234.56')).toBe('-$1,234.56')
  })

  it('falls back to an em-dash for missing/malformed input', () => {
    expect(fmtUsd(undefined)).toBe('—')
    expect(fmtUsd(null)).toBe('—')
    expect(fmtUsd('')).toBe('—')
    expect(fmtUsd('not-a-number')).toBe('—')
    expect(fmtUsd(Number.NaN)).toBe('—')
    expect(fmtUsd(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('fmtTokens', () => {
  it('tiers K / M / B', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(1_500)).toBe('1.5K')
    expect(fmtTokens(2_500_000)).toBe('2.50M')
    expect(fmtTokens(3_250_000_000)).toBe('3.25B')
  })

  it('accepts numeric strings (rollup rows return numerics as strings)', () => {
    expect(fmtTokens('1500')).toBe('1.5K')
  })

  it('falls back to an em-dash for missing/malformed input', () => {
    expect(fmtTokens(undefined)).toBe('—')
    expect(fmtTokens(null)).toBe('—')
    expect(fmtTokens('')).toBe('—')
    expect(fmtTokens('garbage')).toBe('—')
    expect(fmtTokens(Number.NaN)).toBe('—')
  })
})

describe('fmtDurationMs', () => {
  it('keeps milliseconds below a second — the fast run must stay legible', () => {
    // 288 ms is ops-alert's fastest observed run; rounding it to "0.3s" would
    // erase the distance to the 5 293 ms one that raised the alert.
    expect(fmtDurationMs(288)).toBe('288ms')
    expect(fmtDurationMs(999)).toBe('999ms')
    expect(fmtDurationMs(0)).toBe('0ms')
  })

  it('reads in seconds from one second, to one decimal', () => {
    expect(fmtDurationMs(1000)).toBe('1.0s')
    expect(fmtDurationMs(5293)).toBe('5.3s')
    expect(fmtDurationMs(59_999)).toBe('60.0s')
  })

  it('is m:ss from a minute', () => {
    expect(fmtDurationMs(60_000)).toBe('1:00')
    expect(fmtDurationMs(725_000)).toBe('12:05')
  })

  it('null / unparseable is an em-dash — never a zero duration', () => {
    expect(fmtDurationMs(null)).toBe('—')
    expect(fmtDurationMs(undefined)).toBe('—')
    expect(fmtDurationMs('')).toBe('—')
    expect(fmtDurationMs('nonsense')).toBe('—')
  })
})

describe('fmtPct', () => {
  it('formats a 0..1 fraction as a whole percent by default', () => {
    expect(fmtPct(0.423)).toBe('42%')
    expect(fmtPct(1)).toBe('100%')
    expect(fmtPct(0)).toBe('0%')
  })

  it('honours a digits option', () => {
    expect(fmtPct(0.4237, { digits: 1 })).toBe('42.4%')
  })

  it('falls back to an em-dash for missing/malformed input', () => {
    expect(fmtPct(null)).toBe('—')
    expect(fmtPct(undefined)).toBe('—')
    expect(fmtPct('')).toBe('—')
    expect(fmtPct(Number.NaN)).toBe('—')
  })
})

/*
 * fmtSharePct renders a PART's share of a whole, so at 0 decimal places `0%`
 * reads as "none of it" and `100%` reads as "all of it". Neither claim may be
 * manufactured by rounding — these pin BOTH bands and, just as importantly,
 * that the absolutes still reach the screen when they are true.
 */
describe('fmtSharePct', () => {
  it('rounds to a whole percent in the ordinary middle band', () => {
    expect(fmtSharePct(0.423)).toBe('42%')
    expect(fmtSharePct(0.5)).toBe('50%')
    expect(fmtSharePct(0.985)).toBe('99%')
  })

  it('a tiny non-zero share reads "<1%", never a rounded-away "0%"', () => {
    expect(fmtSharePct(0.004)).toBe('<1%')
    expect(fmtSharePct(0.0001)).toBe('<1%')
  })

  it('a share SHORT of the whole reads ">99%", never a rounded-up "100%"', () => {
    // 99.6% is the shape that produced the defect: $400 outside a $100,000
    // denominator, printed as "100%" — a claim of totality with $400 left over.
    expect(fmtSharePct(0.996)).toBe('>99%')
    expect(fmtSharePct(0.9999)).toBe('>99%')
    expect(fmtSharePct(0.991)).toBe('>99%')
  })

  it('reserves "0%" and "100%" for the actual absolutes', () => {
    // The guards must not swallow the two readings they exist to protect: a
    // genuine nothing and a genuine everything are the informative cases.
    expect(fmtSharePct(0)).toBe('0%')
    expect(fmtSharePct(1)).toBe('100%')
  })

  it('passes an over-100% share through — an overrun is a reading, not an artefact', () => {
    expect(fmtSharePct(1.25)).toBe('125%')
    expect(fmtSharePct(2.21)).toBe('221%')
  })

  it('falls back to an em-dash for malformed input', () => {
    // A 0/0 share upstream must not print "NaN%" into a governance sentence.
    expect(fmtSharePct(Number.NaN)).toBe('—')
    expect(fmtSharePct(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('signedPct', () => {
  it('always carries an explicit sign', () => {
    expect(signedPct(0.12)).toBe('+12%')
    expect(signedPct(-0.12)).toBe('-12%')
    expect(signedPct(0)).toBe('+0%')
  })

  it('falls back to an em-dash for missing/malformed input', () => {
    expect(signedPct(null)).toBe('—')
    expect(signedPct(Number.NaN)).toBe('—')
  })
})

describe('fmtTimeAgo', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders relative tiers from a valid ISO timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-09T12:00:00Z'))
    expect(fmtTimeAgo('2026-06-09T11:59:50Z')).toBe('just now')
    expect(fmtTimeAgo('2026-06-09T11:30:00Z')).toBe('30m ago')
    expect(fmtTimeAgo('2026-06-09T07:00:00Z')).toBe('5h ago')
    expect(fmtTimeAgo('2026-06-06T12:00:00Z')).toBe('3d ago')
  })

  it('falls back to an em-dash for missing/unparseable timestamps', () => {
    expect(fmtTimeAgo(undefined)).toBe('—')
    expect(fmtTimeAgo(null)).toBe('—')
    expect(fmtTimeAgo('')).toBe('—')
    expect(fmtTimeAgo('not-a-date')).toBe('—')
  })
})

describe('clientMeta — the tool label', () => {
  /*
   * The function used to be "contains copilot ? Copilot : Claude Code", so every
   * non-Code Claude surface rendered as Claude Code. On the surface-split card
   * that printed "Claude Code 75% · Claude Code 25%" — one card, one subject
   * (WHICH surface), two identical labels.
   *
   * Each case below fails against that implementation, which is the point of
   * having them: the sweep survived because nothing asserted a label at all.
   */
  it('gives every Claude surface its OWN name, not the Code one', () => {
    expect(clientMeta('claude-code').name).toBe('Claude Code')
    expect(clientMeta('claude-ai').name).toBe('Claude Chat')
    expect(clientMeta('claude-office').name).toBe('Claude Office Agents')
    expect(clientMeta('claude-cowork').name).toBe('Claude Cowork')
    expect(clientMeta('claude-design').name).toBe('Claude Design')
  })

  it('never renders two different surfaces under one label', () => {
    const tools = ['claude-code', 'claude-ai', 'claude-office', 'claude-cowork', 'claude-design']
    const names = tools.map((t) => clientMeta(t).name)
    expect(new Set(names).size).toBe(tools.length)
  })

  it('names the GitHub surfaces from the registry, and marks them GitHub', () => {
    expect(clientMeta('copilot-cli').icon).toBe('logos:github-copilot')
    expect(clientMeta('copilot-agent').icon).toBe('logos:github-copilot')
    // Distinct: the coding agent is not the CLI.
    expect(clientMeta('copilot-agent').name).not.toBe(clientMeta('copilot-cli').name)
  })

  it('leaves an unknown tool as itself rather than claiming a vendor', () => {
    // The old fallback answered "Claude Code" for literally anything.
    expect(clientMeta('some-future-surface').name).toBe('some-future-surface')
  })

  it('still degrades safely on empty input', () => {
    expect(() => clientMeta('')).not.toThrow()
  })
})
