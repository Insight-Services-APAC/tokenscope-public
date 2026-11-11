// @vitest-environment node
/*
 * #604: the /help text and the wiki page say the same thing, and the page keeps
 * the promises the issue made about its language.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { HELP_TERMS, HELP_WHAT_HAPPENS } from '../../../shared/help/using-tokenscope'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

const entries = [...HELP_TERMS, ...HELP_WHAT_HAPPENS]
const everyBody = entries.flatMap((e) => e.body)
const wiki = readFileSync('docs/wiki/Using-TokenScope.md', 'utf8')

describe('How TokenScope works (#604)', () => {
  it('covers the agreed terms and situations', () => {
    expect(HELP_TERMS.map((t) => t.id)).toEqual([
      'session', 'device', 'provider-recorded-day', 'unallocated', 'allowance', 'budget',
      'business-unit', 'usage', 'chargeback', 'estimated', 'dismissed',
    ])
    expect(HELP_WHAT_HAPPENS).toHaveLength(5)
  })

  it('every anchor is unique', () => {
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length)
  })

  it('the wiki page carries every term and sentence verbatim', () => {
    for (const e of entries) {
      expect(wiki).toContain(`### ${e.term}`)
      for (const b of e.body) expect(wiki).toContain(b)
    }
  })

  it('has no em dash, role code or retired noun', () => {
    for (const text of [...everyBody, ...entries.map((e) => e.term)]) {
      expect(text).not.toContain('—')
      expect(text).not.toMatch(/platform-admin|global-finops|cost cent/i)
    }
    expect(wiki).not.toContain('—')
  })

  // The public snapshot swaps `_Sidebar.public.md` in as `_Sidebar.md`
  // (tools/publish), so there the one sidebar IS the public one. In the source
  // tree both are required: keyed on the snapshot marker, not on the file, so a
  // deleted public sidebar fails here instead of skipping.
  it('both wiki sidebars link the page', () => {
    const sidebars = PUBLIC_SNAPSHOT ? ['docs/wiki/_Sidebar.md'] : ['docs/wiki/_Sidebar.md', 'docs/wiki/_Sidebar.public.md']
    for (const f of sidebars) {
      expect(readFileSync(f, 'utf8')).toContain('(Using-TokenScope.md)')
    }
  })

  it('the menu and footer link to /help from every layout', () => {
    expect(readFileSync('app/components/nav/AppHeader.vue', 'utf8')).toContain('to="/help"')
    expect(readFileSync('app/components/nav/AppFooter.vue', 'utf8')).toContain('to="/help"')
  })
})
