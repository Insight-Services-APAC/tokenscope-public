/*
 * The governance cutover badge reads from one label map (#545): every status
 * has a label in words, and the map's statuses are exactly the server's
 * CutoverStatus union, so a new status cannot reach the page as a raw key.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CUTOVER_STATUSES, CUTOVER_STATUS_LABELS, cutoverStatusLabel } from '../../../shared/governance/cutover-status'

describe('cutover status labels', () => {
  it.each(CUTOVER_STATUSES.map((s) => [s]))('%s has a label in words', (status) => {
    const label = CUTOVER_STATUS_LABELS[status]
    expect(label).toBeTruthy()
    expect(label).not.toMatch(/[_-]/)
    expect(cutoverStatusLabel(status)).toBe(label)
  })

  it('covers exactly the server CutoverStatus union', () => {
    const src = readFileSync(resolve(__dirname, '../../../server/governance/cutover.ts'), 'utf8')
    const union = /export type CutoverStatus = ([^\n]+)/.exec(src)?.[1] ?? ''
    const serverStatuses = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(serverStatuses.length).toBeGreaterThan(0)
    expect([...CUTOVER_STATUSES].sort()).toEqual(serverStatuses)
  })

  it('an unknown status says so instead of printing the key', () => {
    expect(cutoverStatusLabel('half_done')).toBe('Unknown')
    expect(cutoverStatusLabel(null)).toBe('Unknown')
  })
})
