/*
 * Project budgets list (#632): budget lines grouped by project.
 *
 * The server pages by whole projects and sends each project's lines together,
 * newest period first, with `is_current` and the project's `project_budget_now`
 * (the budget in force, from the project page's own reader). This module only
 * arranges them; it never sums a budget of its own. The breakdown line
 * ("$1,000 baseline + $500 top-up") is shown only when the current pool lines
 * add up to the server's figure, so the two can never disagree on screen.
 */
import { budgetPeriodWords } from '#shared/budgets/period-words'

export interface BudgetLine {
  id: string
  scope_type: string
  scope_id: string
  budget_usd: string
  allocation_kind: string
  is_pool: boolean
  is_current: boolean
  effective_from: string | null
  effective_to: string | null
  project_code: string | null
  project_display_name: string | null
  project_budget_now: number | null
}

export interface BudgetGroup {
  key: string
  name: string
  code: string | null
  /* The line the project's headline row opens and whose period it shows. */
  headline: BudgetLine
  /* The budget in force now (server's figure); null for a non-project scope. */
  budgetNow: number | null
  /* "$1,000 baseline + $500 top-up" parts, only when there is a top-up and the parts agree with budgetNow. */
  breakdown: { baselineUsd: number; topupUsd: number } | null
  inForce: boolean
  /* Every other line, in the server's order. */
  others: BudgetLine[]
  othersLabel: string
}

const KIND_WORDS: Record<string, string> = {
  baseline: 'Baseline',
  'top-up': 'Top-up',
  burst: 'Burst',
}

/** The kind as a word a person reads; a per-developer cap says so. */
export function kindWord(line: Pick<BudgetLine, 'allocation_kind' | 'is_pool'>): string {
  if (!line.is_pool) return 'Developer cap'
  return KIND_WORDS[line.allocation_kind] ?? line.allocation_kind.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

export function periodOf(line: Pick<BudgetLine, 'effective_from' | 'effective_to'>): string {
  return budgetPeriodWords(line.effective_from, line.effective_to)
}

function cents(n: number): number {
  return Math.round(n * 100)
}

function othersLabel(others: BudgetLine[], now: BudgetLine | null): string {
  const n = others.length
  if (n === 0) return ''
  const fromMs = now?.effective_from ? Date.parse(now.effective_from) : Number.NaN
  const allEarlier = others.every((o) => !o.is_current && o.effective_from !== null && Number.isFinite(fromMs) && Date.parse(o.effective_from) < fromMs)
  if (allEarlier) return n === 1 ? '1 earlier budget' : `${n} earlier budgets`
  return n === 1 ? '1 other budget line' : `${n} other budget lines`
}

/** Group the server's lines (already in order) into one entry per project. */
export function groupBudgetLines(lines: readonly BudgetLine[]): { inForce: BudgetGroup[]; notInForce: BudgetGroup[] } {
  const byKey = new Map<string, BudgetLine[]>()
  for (const l of lines) {
    const key = `${l.scope_type}:${l.scope_id}`
    const list = byKey.get(key)
    if (list) list.push(l)
    else byKey.set(key, [l])
  }
  const inForce: BudgetGroup[] = []
  const notInForce: BudgetGroup[] = []
  for (const [key, list] of byKey) {
    const first = list[0]!
    const currentPool = list.filter((l) => l.is_current && l.is_pool && (l.allocation_kind === 'baseline' || l.allocation_kind === 'top-up'))
    const currentBaseline = currentPool.find((l) => l.allocation_kind === 'baseline') ?? null
    const headline = currentBaseline ?? currentPool[0] ?? first
    const budgetNow = first.project_budget_now
    const isInForce = currentPool.length > 0 && (budgetNow === null || budgetNow > 0)

    let breakdown: BudgetGroup['breakdown'] = null
    if (isInForce && budgetNow !== null) {
      const baselineUsd = currentPool.filter((l) => l.allocation_kind === 'baseline').reduce((s, l) => s + Number(l.budget_usd), 0)
      const topupUsd = currentPool.filter((l) => l.allocation_kind === 'top-up').reduce((s, l) => s + Number(l.budget_usd), 0)
      if (topupUsd > 0 && cents(baselineUsd + topupUsd) === cents(budgetNow)) breakdown = { baselineUsd, topupUsd }
    }

    const others = list.filter((l) => l.id !== headline.id)
    const group: BudgetGroup = {
      key,
      name: first.project_display_name ?? first.scope_id,
      code: first.project_code,
      headline,
      budgetNow,
      breakdown,
      inForce: isInForce,
      others,
      othersLabel: othersLabel(others, isInForce ? headline : null),
    }
    ;(isInForce ? inForce : notInForce).push(group)
  }
  return { inForce, notInForce }
}
