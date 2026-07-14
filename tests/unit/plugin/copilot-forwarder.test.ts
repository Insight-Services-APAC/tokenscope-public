/**
 * copilot-forwarder — unit tests for readNewSpans + offset tracking (L5)
 *
 * These tests guard the core file-tail + offset-persistence logic:
 *   - readNewSpans reads only new data (correct offset advancing)
 *   - persistOffset + loadPersistedOffset round-trip (M3 guard)
 *   - File shrink resets offset (L2 guard — prevents silent "skip forever")
 *   - Inode change resets offset (L2 guard — handles file recreation)
 *
 * All tests use temp files; no network, no Azure, no daemon spawning.
 * The forwarder exports these functions specifically to make this suite possible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, writeSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The forwarder reads TOKENSCOPE_FWD_OFFSET_FILE ONCE at module load, so the
// override must be in place BEFORE the dynamic import — setting it in beforeEach
// (the old shape) was too late and the suite silently round-tripped through the
// developer's real ~/.tokenscope/forwarder-offset.
const suiteDir = mkdtempSync(join(tmpdir(), 'ts-fwd-suite-'))
const offsetFile = join(suiteDir, 'forwarder-offset')
process.env.TOKENSCOPE_FWD_OFFSET_FILE = offsetFile

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { readNewSpans, loadPersistedOffset, persistOffset, _resetStateForTest, clampForwardIntervalMs } = await import(
  '../../../plugin/scripts/copilot-forwarder.mjs'
)

// ── Shared span line builders ─────────────────────────────────────────────────
function chatSpanLine(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'span',
    name: 'chat claude-sonnet-4.6',
    spanId: `span-${Math.random().toString(36).slice(2, 10)}`,
    startTime: [1780825134, 0],
    endTime: [1780825137, 0],
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'claude-sonnet-4.6',
      'gen_ai.conversation.id': 'test-conv',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 5,
      'github.copilot.nano_aiu': 1000000000,
      ...overrides,
    },
    resource: { attributes: {} },
    ...overrides,
  })
}

function invokeAgentSpanLine() {
  return JSON.stringify({
    type: 'span',
    name: 'invoke_agent',
    spanId: 'invoke-span',
    attributes: { 'gen_ai.operation.name': 'invoke_agent' },
    resource: { attributes: {} },
  })
}

// ── Test setup ────────────────────────────────────────────────────────────────
let dir: string
let spanFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-fwd-'))
  spanFile = join(dir, 'copilot-otel.ndjson')
  rmSync(offsetFile, { force: true }) // fresh persisted-offset state per test
  _resetStateForTest()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('clampForwardIntervalMs — PLG-7 garbage-interval guard', () => {
  it('passes a sane numeric interval through (number or numeric string)', () => {
    expect(clampForwardIntervalMs(5_000)).toBe(5_000)
    expect(clampForwardIntervalMs('30000')).toBe(30_000)
  })
  it('clamps NaN/garbage to 60s (was: setInterval(fn, NaN) → 1ms hot loop)', () => {
    expect(clampForwardIntervalMs('bogus')).toBe(60_000)
    expect(clampForwardIntervalMs(NaN)).toBe(60_000)
    expect(clampForwardIntervalMs('')).toBe(60_000) // Number('') === 0 → not > 0
  })
  it('clamps zero/negative/Infinity (a non-positive interval breaks the heartbeat math)', () => {
    expect(clampForwardIntervalMs(0)).toBe(60_000)
    expect(clampForwardIntervalMs(-5)).toBe(60_000)
    expect(clampForwardIntervalMs(Infinity)).toBe(60_000)
  })
  it('floors sub-second positives (1.5ms would still be a hot loop)', () => {
    expect(clampForwardIntervalMs(1.5)).toBe(60_000)
    expect(clampForwardIntervalMs(999)).toBe(60_000)
    expect(clampForwardIntervalMs(1_000)).toBe(1_000)
  })
  it('defaults to 60s when the env var is unset', () => {
    expect(clampForwardIntervalMs(undefined)).toBe(60_000)
  })
  it('a clamped value keeps HEARTBEAT_STALE_MS finite (singleton guard intact)', () => {
    // HEARTBEAT_STALE_MS = max(2.5 * interval, 150_000); with the old NaN this
    // was NaN → isAlreadyRunning() never true → daemon-per-session spawn storm.
    const stale = Math.max(2.5 * clampForwardIntervalMs('garbage'), 150_000)
    expect(Number.isFinite(stale)).toBe(true)
  })
})

describe('readNewSpans — basic tailing', () => {
  it('returns empty array when file does not exist', () => {
    const spans = readNewSpans(spanFile)
    expect(spans).toEqual([])
  })

  it('reads chat spans from a new file', () => {
    writeFileSync(spanFile, chatSpanLine() + '\n')
    const spans = readNewSpans(spanFile)
    expect(spans).toHaveLength(1)
    expect(spans[0].attributes['gen_ai.operation.name']).toBe('chat')
  })

  it('excludes invoke_agent spans (double-count guard)', () => {
    writeFileSync(spanFile, invokeAgentSpanLine() + '\n')
    const spans = readNewSpans(spanFile)
    expect(spans).toHaveLength(0)
  })

  it('advances offset — second call returns only new spans', () => {
    writeFileSync(spanFile, chatSpanLine({ spanId: 'span-1' }) + '\n')
    const first = readNewSpans(spanFile)
    expect(first).toHaveLength(1)

    // Append another span
    const fd = openSync(spanFile, 'a')
    writeSync(fd, chatSpanLine({ spanId: 'span-2' }) + '\n')
    closeSync(fd)

    const second = readNewSpans(spanFile)
    expect(second).toHaveLength(1)
    expect(second[0].spanId).toBe('span-2')
  })

  it('returns empty array when no new data', () => {
    writeFileSync(spanFile, chatSpanLine() + '\n')
    readNewSpans(spanFile) // consume
    const second = readNewSpans(spanFile)
    expect(second).toHaveLength(0)
  })

  it('handles partial lines (buffers incomplete JSON until next read)', () => {
    const line = chatSpanLine() + '\n'
    // Write only half the line
    const half = line.slice(0, Math.floor(line.length / 2))
    writeFileSync(spanFile, half)
    const partial = readNewSpans(spanFile)
    expect(partial).toHaveLength(0) // no complete line yet

    // Write the rest
    const fd = openSync(spanFile, 'a')
    writeSync(fd, line.slice(Math.floor(line.length / 2)))
    closeSync(fd)
    const complete = readNewSpans(spanFile)
    expect(complete).toHaveLength(1)
  })
})

describe('offset persistence — M3 + L2 guards', () => {
  it('persistOffset + loadPersistedOffset round-trip restores offset', () => {
    writeFileSync(spanFile, chatSpanLine() + '\n')
    readNewSpans(spanFile) // advances offset
    persistOffset(spanFile)

    // Reset state and reload
    _resetStateForTest()
    loadPersistedOffset(spanFile)

    // Should have no new spans (offset restored to end of file)
    const spans = readNewSpans(spanFile)
    expect(spans).toHaveLength(0)
  })

  it('persistOffset + loadPersistedOffset with new spans — only new spans returned', () => {
    writeFileSync(spanFile, chatSpanLine({ spanId: 'old-span' }) + '\n')
    readNewSpans(spanFile)
    persistOffset(spanFile)

    // Simulate a new process loading the offset
    _resetStateForTest()
    loadPersistedOffset(spanFile)

    // Append a new span
    const fd = openSync(spanFile, 'a')
    writeSync(fd, chatSpanLine({ spanId: 'new-span' }) + '\n')
    closeSync(fd)

    const spans = readNewSpans(spanFile)
    expect(spans).toHaveLength(1)
    expect(spans[0].spanId).toBe('new-span')
  })

  it('L2: file shrink resets offset (never skip-forever on truncation)', () => {
    // Write and consume spans to advance offset
    writeFileSync(spanFile, chatSpanLine({ spanId: 'old' }) + '\n')
    readNewSpans(spanFile) // offset now at end (e.g. 200 bytes)

    // Simulate file truncation/recreation (smaller file)
    writeFileSync(spanFile, chatSpanLine({ spanId: 'new' }) + '\n')
    // File is recreated at a small size (triggers shrink detection)
    // Force the file to be smaller by rewriting with a short line
    writeFileSync(spanFile, JSON.stringify({ type: 'span', name: 'chat', spanId: 'small',
      attributes: { 'gen_ai.operation.name': 'chat' }, resource: {} }) + '\n')

    // If the new file is smaller than our module offset, the shrink guard fires.
    // In this test the new file's content was written fresh so its size may vary.
    // We test by explicitly checking that readNewSpans doesn't return empty forever:
    // reset offset to a value larger than the file to simulate shrink scenario.
    // (The shrink guard runs: if st.size < offset → reset)
    _resetStateForTest()
    // Manually simulate a large stale offset by reading a bigger file first
    const bigContent = (chatSpanLine() + '\n').repeat(50) // ~10KB
    writeFileSync(spanFile, bigContent)
    readNewSpans(spanFile) // offset now ~10KB

    // Now write a much smaller file (simulate truncation to new session)
    writeFileSync(spanFile, chatSpanLine({ spanId: 'after-truncate' }) + '\n')

    // readNewSpans must detect shrink, reset offset, and return the new span
    const spans = readNewSpans(spanFile)
    expect(spans).toHaveLength(1)
    expect(spans[0].spanId).toBe('after-truncate')
  })

  it('L2: stale offset with different inode does not restore (file recreated)', () => {
    // Write and consume, then persist offset (records spanFile's inode)
    writeFileSync(spanFile, chatSpanLine({ spanId: 'original' }) + '\n')
    readNewSpans(spanFile)
    persistOffset(spanFile)

    // Simulate recreation under a DIFFERENT inode with a coexisting file: two
    // files that exist simultaneously are guaranteed distinct inodes, whereas
    // unlink+recreate at the same path is NOT — ext4/tmpfs routinely hand the
    // freed inode straight back, which made this test flaky.
    const recreated = join(dir, 'copilot-otel-recreated.ndjson')
    writeFileSync(recreated, chatSpanLine({ spanId: 'recreated' }) + '\n')

    // Load persisted offset against the recreated file — must NOT restore
    // (stored ino belongs to the old file).
    _resetStateForTest()
    loadPersistedOffset(recreated)

    // Should read from start (offset=0) since the inode differs
    const spans = readNewSpans(recreated)
    expect(spans).toHaveLength(1)
    expect(spans[0].spanId).toBe('recreated')
  })
})
