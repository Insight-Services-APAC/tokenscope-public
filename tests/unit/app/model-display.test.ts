// @vitest-environment node
/*
 * useModelDisplay — model-id → label/family mapping + the dominant-model
 * chip selection (sprint design §4). Unknown ids must DISPLAY (raw id),
 * never break: new model names arrive before mappings do.
 */
import { describe, it, expect } from 'vitest'
import {
  dominantModel,
  modelDisplay,
  modelMixTitle,
} from '../../../app/composables/useModelDisplay'

describe('modelDisplay', () => {
  it('maps Claude family ids with versions', () => {
    expect(modelDisplay('claude-fable-5')).toEqual({ label: 'Fable 5', family: 'fable' })
    expect(modelDisplay('claude-opus-4-8')).toEqual({ label: 'Opus 4.8', family: 'opus' })
    expect(modelDisplay('claude-sonnet-4-6')).toEqual({ label: 'Sonnet 4.6', family: 'sonnet' })
  })

  it('ignores 8-digit date stamps in the version', () => {
    expect(modelDisplay('claude-haiku-4-5-20251001')).toEqual({ label: 'Haiku 4.5', family: 'haiku' })
  })

  it('handles legacy claude-<version>-<family> ordering (claude-3-5-sonnet-20241022)', () => {
    const d = modelDisplay('claude-3-5-sonnet-20241022')
    expect(d.family).toBe('sonnet')
    expect(d.label).toBe('Sonnet') // version precedes the family word — label stays family-only
  })

  it('strips Bedrock-style prefixes (us.anthropic.claude-sonnet-4-6)', () => {
    expect(modelDisplay('us.anthropic.claude-sonnet-4-6')).toEqual({
      label: 'Sonnet 4.6',
      family: 'sonnet',
    })
  })

  it('maps GPT ids for the Copilot lane', () => {
    expect(modelDisplay('gpt-5.1')).toEqual({ label: 'GPT-5.1', family: 'gpt' })
    expect(modelDisplay('gpt-5-1')).toEqual({ label: 'GPT-5.1', family: 'gpt' })
    expect(modelDisplay('gpt-4o')).toEqual({ label: 'GPT-4o', family: 'gpt' })
  })

  it('unknown ids fall back to the raw id, never throw', () => {
    expect(modelDisplay('totally-new-model-x')).toEqual({
      label: 'totally-new-model-x',
      family: 'other',
    })
    expect(modelDisplay('')).toEqual({ label: '—', family: 'other' })
  })
})

describe('dominantModel', () => {
  const MIX = [
    { model: 'claude-fable-5', tokens: 1_400_000, cost_usd: '1.28' },
    { model: 'claude-haiku-4-5', tokens: 6_000, cost_usd: '0.01' },
  ]

  it('picks the first slice (API order = cost-share desc) with its cost share', () => {
    const d = dominantModel(MIX)!
    expect(d.model).toBe('claude-fable-5')
    expect(d.share).toBeCloseTo(1.28 / 1.29, 4)
  })

  it('falls back to token share when total cost is 0', () => {
    const d = dominantModel([
      { model: 'a', tokens: 900, cost_usd: '0.00' },
      { model: 'b', tokens: 100, cost_usd: '0.00' },
    ])!
    expect(d.share).toBeCloseTo(0.9, 6)
  })

  it('null on empty (legacy conversations) — the chip renders nothing', () => {
    expect(dominantModel([])).toBeNull()
  })
})

describe('modelMixTitle', () => {
  it('one line per model with share and cost', () => {
    const title = modelMixTitle([
      { model: 'claude-fable-5', tokens: 1_400_000, cost_usd: '1.28' },
      { model: 'claude-haiku-4-5', tokens: 6_000, cost_usd: '0.01' },
    ])
    const lines = title.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Fable 5')
    expect(lines[0]).toContain('99%')
    expect(lines[0]).toContain('$1.28')
    expect(lines[1]).toContain('Haiku 4.5')
  })
})
