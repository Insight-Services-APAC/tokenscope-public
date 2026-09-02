// @vitest-environment node
/*
 * query_source classification — the wire vocabulary, pinned.
 *
 * WHY THIS EXISTS. Every consumer used to test `query_source === 'main'`.
 * Claude Code has never emitted that string: it sends its own query-source
 * token (`repl_main_thread`, `agent:custom`, `compact`, …) and keeps `main`
 * for a *category* it puts in a separate field, off the OTLP wire. The result
 * was a live insight claiming "100% of your classified token volume is harness
 * overhead" over 16.9B tokens with `main_tokens: 0`.
 *
 * The vocabulary below is not invented: it is the allow-list extracted from the
 * shipped Claude Code binary (v2.1.247), recorded in
 * docs/development/claude-code-telemetry-contract.md §Query-source vocabulary.
 * If Anthropic adds a lane, this table is where it gets classified.
 *
 * RED ON REVERT: restore the `=== 'main'` equality in `classifyQuerySource` and
 * every CLAUDE_MAIN case below goes red.
 */
import { describe, it, expect } from 'vitest'
import { classifyQuerySource, querySourceLabel } from '../../../shared/usage/query-source'

/** Claude Code values whose category is `main` or `subagent` — the teammate's own work. */
const CLAUDE_MAIN = [
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Concise',
  'repl_main_thread:outputStyle:Proactive',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'hook_agent',
]

/** Claude Code values whose category is `auxiliary` — genuine harness overhead. */
const CLAUDE_AUX = [
  'compact',
  'hook_prompt',
  'side_question',
  'web_search_tool',
  'web_fetch_apply',
  'repl_sampling',
  'auto_mode',
  'compact_fab_check',
  'auto_mode_critique',
  'auto_mode_setup_propose',
  'chrome_mcp',
]

describe('classifyQuerySource — Claude Code wire vocabulary', () => {
  it('classifies every conversation/subagent token as main', () => {
    for (const v of CLAUDE_MAIN) expect(classifyQuerySource(v), v).toBe('main')
  })

  it('classifies every auxiliary token as aux', () => {
    for (const v of CLAUDE_AUX) expect(classifyQuerySource(v), v).toBe('aux')
  })

  it('matches repl_main_thread by PREFIX — an output style must not fall out of main', () => {
    // The suffix is the active output style, so equality would drop every turn
    // taken by a developer who has one set.
    expect(classifyQuerySource('repl_main_thread:outputStyle:Concise')).toBe('main')
  })
})

describe('classifyQuerySource — the Copilot transcoder lane', () => {
  it("keeps the literal 'main' the transcoder emits, and 'auto' as aux", () => {
    // plugin/scripts/otlp-logs.mjs derives these from github.copilot.initiator.
    expect(classifyQuerySource('main')).toBe('main')
    expect(classifyQuerySource('auto')).toBe('aux')
  })
})

describe('classifyQuerySource — absent signal is NOT overhead', () => {
  it('treats null/undefined/blank as unknown, never as aux', () => {
    expect(classifyQuerySource(null)).toBe('unknown')
    expect(classifyQuerySource(undefined)).toBe('unknown')
    expect(classifyQuerySource('')).toBe('unknown')
    expect(classifyQuerySource('   ')).toBe('unknown')
  })

  it('treats a stringified nullish as unknown — a capture defect is not a lane', () => {
    expect(classifyQuerySource('null')).toBe('unknown')
    expect(classifyQuerySource('undefined')).toBe('unknown')
  })

  it('tolerates casing and surrounding whitespace', () => {
    expect(classifyQuerySource('  REPL_MAIN_THREAD  ')).toBe('main')
    expect(classifyQuerySource('Main')).toBe('main')
  })
})

describe('classifyQuerySource — unrecognised values', () => {
  it('defaults to aux so a NEW Anthropic overhead lane counts without a code change', () => {
    expect(classifyQuerySource('some_future_harness_lane')).toBe('aux')
  })
})

describe('querySourceLabel', () => {
  it('names the conversation lane and leaves aux lanes readable as their raw token', () => {
    expect(querySourceLabel('repl_main_thread')).toBe('Your conversation')
    expect(querySourceLabel('agent:custom')).toBe('Your conversation')
    expect(querySourceLabel('compact')).toBe('compact')
    expect(querySourceLabel(null)).toBe('Unknown')
  })
})
