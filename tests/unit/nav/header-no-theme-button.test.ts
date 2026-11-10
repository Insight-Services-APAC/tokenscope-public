/*
 * The header carries no theme button (#542). It was a disabled "placeholder
 * for v1" that did nothing when clicked; dark mode is built only if asked
 * (REMAINING E16). The bell and the account menu keep their order, so focus
 * still reaches the bell before the account menu.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const header = readFileSync(resolve(__dirname, '../../../app/components/nav/AppHeader.vue'), 'utf8')
const template = header.slice(header.indexOf('<template>'))

describe('AppHeader controls', () => {
  it('has no theme toggle', () => {
    expect(template).not.toMatch(/dark-toggle|Toggle theme/i)
    // The moon glyph's path, in case it comes back under another name.
    expect(template).not.toContain('M21 12.79A9 9 0 1 1 11.21 3')
  })

  it('keeps the inbox bell before the account menu', () => {
    const bell = template.indexOf('data-testid="inbox-bell"')
    const menu = template.indexOf('data-testid="user-menu"')
    expect(bell).toBeGreaterThan(-1)
    expect(menu).toBeGreaterThan(bell)
  })
})
