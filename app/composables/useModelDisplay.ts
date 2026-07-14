/*
 * Model-display mapping — raw model ids → human labels + family tint
 * (sprint design §4). Same single-place rule as useFormat (SYS-5/FE-12):
 * model naming lives HERE; per-view reimplementations will drift.
 *
 * Unknown models fall back to the raw id (truncated by the caller's CSS) —
 * a new model name must display, never break.
 */

export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'gpt' | 'other'

export interface ModelDisplay {
  /** Human label, e.g. "Fable 5", "Opus 4.8", "GPT-5.1". */
  label: string
  family: ModelFamily
}

const CLAUDE_FAMILIES: ReadonlyArray<{ key: Exclude<ModelFamily, 'gpt' | 'other'>; name: string }> = [
  { key: 'fable', name: 'Fable' },
  { key: 'opus', name: 'Opus' },
  { key: 'sonnet', name: 'Sonnet' },
  { key: 'haiku', name: 'Haiku' },
]

/**
 * Version from the id segments after the family word: numeric runs joined
 * with '.', ignoring 8-digit date stamps (claude-haiku-4-5-20251001 → 4.5)
 * and non-numeric suffixes ('latest', '[1m]').
 */
function versionAfter(segments: string[], familyIdx: number): string {
  const nums: string[] = []
  for (const seg of segments.slice(familyIdx + 1)) {
    if (!/^\d+$/.test(seg)) break
    if (seg.length >= 8) break // date stamp, not a version part
    nums.push(seg)
  }
  return nums.join('.')
}

export function modelDisplay(modelId: string): ModelDisplay {
  const id = (modelId || '').toLowerCase().trim()
  if (!id) return { label: '—', family: 'other' }

  // Claude families: anchor at the 'claude' substring so Bedrock-style
  // prefixes (us.anthropic.claude-…) drop away without touching version dots.
  const claudeIdx = id.indexOf('claude')
  if (claudeIdx >= 0) {
    const segments = id.slice(claudeIdx).split('-')
    for (const fam of CLAUDE_FAMILIES) {
      const idx = segments.indexOf(fam.key)
      if (idx >= 0) {
        const v = versionAfter(segments, idx)
        return { label: v ? `${fam.name} ${v}` : fam.name, family: fam.key }
      }
    }
  }

  // GPT ids (Copilot lane): gpt-5.1, gpt-5-1, gpt-4o… Dots are version
  // separators here, so match on the raw id.
  const gpt = /(?:^|[./:])gpt[-_]?([a-z0-9.-]*)/.exec(id)
  if (gpt) {
    const v = (gpt[1] ?? '').replace(/-/g, '.').replace(/\.$/, '')
    return { label: v ? `GPT-${v}` : 'GPT', family: 'gpt' }
  }

  return { label: modelId, family: 'other' }
}

export interface ModelSlice {
  model: string
  tokens: number
  cost_usd: string
}

/**
 * The chip contract: by_model arrives cost-share desc from the API, so the
 * dominant model is the first slice. share is by cost (fallback: tokens when
 * the total cost is 0, e.g. all-cache-read freebies). null on empty input
 * (legacy conversations with no breakdown).
 */
export function dominantModel(byModel: ModelSlice[]): { model: string; share: number } | null {
  if (!byModel.length) return null
  const totalCost = byModel.reduce((a, m) => a + Number(m.cost_usd), 0)
  const totalTokens = byModel.reduce((a, m) => a + m.tokens, 0)
  const top = byModel[0]!
  const share =
    totalCost > 0
      ? Number(top.cost_usd) / totalCost
      : totalTokens > 0
        ? top.tokens / totalTokens
        : 1
  return { model: top.model, share }
}

/** Multi-line tooltip body: one "Label · 92% · $1.28" line per model. */
export function modelMixTitle(byModel: ModelSlice[]): string {
  const totalCost = byModel.reduce((a, m) => a + Number(m.cost_usd), 0)
  return byModel
    .map((m) => {
      const pct = totalCost > 0 ? Math.round((Number(m.cost_usd) / totalCost) * 100) : null
      return `${modelDisplay(m.model).label}${pct != null ? ` · ${pct}%` : ''} · $${m.cost_usd}`
    })
    .join('\n')
}

export function useModelDisplay() {
  return { modelDisplay, dominantModel, modelMixTitle }
}
