/*
 * Device names (#576): the rule for a name and how a device reads.
 * The same rule backs PATCH /me/instances/{id} and the rename field.
 */
import { describe, it, expect } from 'vitest'
import {
  DEVICE_NAME_MAX,
  DeviceRenameBody,
  deviceFallbackLabel,
  deviceLabel,
} from '../../../shared/schemas/device-name'

const parse = (name: unknown) => DeviceRenameBody.safeParse({ name })

describe('DeviceRenameBody', () => {
  it('trims the name', () => {
    expect(parse('  Work laptop  ')).toMatchObject({ success: true, data: { name: 'Work laptop' } })
  })

  it('an empty, all-space or null name clears it', () => {
    for (const v of ['', '   ', null]) expect(parse(v)).toMatchObject({ success: true, data: { name: null } })
  })

  it('accepts 40 characters, counted as code points, and refuses 41', () => {
    expect(parse('a'.repeat(DEVICE_NAME_MAX)).success).toBe(true)
    expect(parse('a'.repeat(DEVICE_NAME_MAX + 1)).success).toBe(false)
    // 40 emoji are 80 UTF-16 units but 40 characters, as Postgres counts them.
    expect(parse('💻'.repeat(DEVICE_NAME_MAX)).success).toBe(true)
  })

  it('refuses control and formatting characters (a bidi override cannot disguise a device)', () => {
    expect(parse('laptop‮evil').success).toBe(false)
    expect(parse('lap\ntop').success).toBe(false)
    expect(parse('lap​top').success).toBe(false)
  })

  it('accepts names in any script, with punctuation and symbols', () => {
    expect(parse('Työkone #2 (koti) — 東京').success).toBe(true)
  })

  it('accepts combining marks: a decomposed accent and an Indic vowel sign', () => {
    expect(parse('Cafe\u0301 laptop').success).toBe(true)
    expect(parse('कंप्यूटर').success).toBe(true)
  })

  it('refuses a non-string', () => {
    expect(parse(42).success).toBe(false)
  })
})

describe('deviceLabel', () => {
  const id = '9a1e0000-0000-4000-8000-000000000001'
  it('reads as the name when there is one', () => {
    expect(deviceLabel({ instance_id: id, tool: 'claude-code', display_name: 'Home desktop' })).toBe('Home desktop')
  })

  it('without a name, reads as today: the tool and the short id, never blank', () => {
    expect(deviceLabel({ instance_id: id, tool: 'claude-code', display_name: null })).toBe('Claude Code · 9a1e0000')
    expect(deviceLabel({ instance_id: id, tool: 'claude-code', display_name: '  ' })).toBe('Claude Code · 9a1e0000')
    expect(deviceFallbackLabel('copilot-cli', id)).toMatch(/Copilot.* · 9a1e0000$/)
    expect(deviceFallbackLabel(null, id)).toBe('9a1e0000')
  })
})
