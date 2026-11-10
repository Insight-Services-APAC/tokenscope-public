/*
 * Every inbox category the server writes has words and a filter group (#546).
 *
 * The list of what the server writes is READ from the server, not copied:
 * the InboxCategory union in server/notifications/dispatch.ts, plus any
 * `'x' as InboxCategory` cast anywhere in server/ (went-silent writes one the
 * union does not name). A new category with no label or group fails here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  INBOX_CATEGORY_GROUPS,
  INBOX_CATEGORY_INFO,
  KNOWN_INBOX_CATEGORIES,
  categoriesInGroup,
  inboxCategoryBadge,
  inboxCategoryGroup,
  inboxCategoryLabel,
} from '../../../shared/inbox/categories'
import { INBOX_CATEGORIES } from '../../../shared/schemas/inbox'

const ROOT = resolve(__dirname, '../../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

function serverCategories(): string[] {
  const dispatch = readFileSync(join(ROOT, 'server/notifications/dispatch.ts'), 'utf8')
  const start = dispatch.indexOf('export type InboxCategory =')
  const end = dispatch.indexOf('\n\n', start)
  const union = dispatch.slice(start, end)
  const found = new Set([...union.matchAll(/^\s*\|\s*'([a-z][a-z-]*)'/gm)].map((m) => m[1]!))
  for (const f of walk(join(ROOT, 'server'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/'([a-z][a-z-]*)' as InboxCategory/g)) found.add(m[1]!)
  }
  return [...found].sort()
}

describe('inbox categories', () => {
  const written = serverCategories()

  it('finds what the server writes (the scan is live)', () => {
    expect(written.length).toBeGreaterThan(20)
    expect(written).toContain('went-silent')
    expect(written).toContain('ops-alert')
  })

  it.each(written.map((c) => [c]))('%s has a label and a group', (category) => {
    const info = (INBOX_CATEGORY_INFO as Record<string, { label: string; group: string }>)[category]
    expect(info, `${category} is written by the server but has no entry in shared/inbox/categories.ts`).toBeDefined()
    expect(info!.label).toMatch(/^[A-Z]/)
    expect(info!.label).not.toMatch(/[a-z]-[a-z]/)
    expect(INBOX_CATEGORY_GROUPS).toContain(info!.group)
  })

  it('lists nothing the server does not write', () => {
    expect([...KNOWN_INBOX_CATEGORIES].sort()).toEqual(written)
  })

  it('the list route accepts every category', () => {
    expect([...INBOX_CATEGORIES].sort()).toEqual(written)
  })

  it('every category is in exactly one group, and every group has some', () => {
    const grouped = INBOX_CATEGORY_GROUPS.flatMap((g) => categoriesInGroup(g))
    expect(grouped.sort()).toEqual([...KNOWN_INBOX_CATEGORIES].sort())
    for (const g of INBOX_CATEGORY_GROUPS) expect(categoriesInGroup(g).length).toBeGreaterThan(0)
  })

  it('badges read group and kind, and an unknown key never shows', () => {
    expect(inboxCategoryBadge('quota-request')).toBe('Requests · Budget request')
    expect(inboxCategoryBadge('attribution-gap')).toBe('Data health · Device behind')
    expect(inboxCategoryBadge('untagged-backlog')).toBe('Data health · Usage not recorded')
    expect(inboxCategoryLabel('brand-new-thing')).toBe('Notice')
    expect(inboxCategoryGroup('brand-new-thing')).toBe('other')
  })
})
