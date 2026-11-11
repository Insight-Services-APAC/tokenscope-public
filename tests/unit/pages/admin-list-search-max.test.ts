/*
 * The admin search boxes (Projects, Devices) cannot hold a search their route
 * refuses (PR 590 review). The route answers an over-long `q` with a 400, and
 * the page's error state replaces the whole table, search box included, so an
 * over-long paste would strand the page with no way to shorten it. Both sides
 * read one constant.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ADMIN_LIST_SEARCH_MAX } from '../../../shared/schemas/admin-list-search'

const root = resolve(__dirname, '../../..')
const read = (f: string) => readFileSync(resolve(root, f), 'utf8')

describe('admin list search length', () => {
  it('is 120', () => {
    expect(ADMIN_LIST_SEARCH_MAX).toBe(120)
  })

  it.each([
    ['app/pages/admin/projects/index.vue', 'server/api/v1/admin/projects.get.ts', 'admin-projects-search'],
    ['app/pages/admin/instances.vue', 'server/api/v1/admin/instances.get.ts', 'admin-instances-search'],
  ])('%s limits its search box to what %s accepts', (page, route, testid) => {
    const src = read(page)
    const input = src.slice(src.lastIndexOf('<input', src.indexOf(`data-testid="${testid}"`)), src.indexOf(`data-testid="${testid}"`))
    expect(input).toContain(':maxlength="ADMIN_LIST_SEARCH_MAX"')
    expect(read(route)).toMatch(/q: z\.string\(\)\.trim\(\)\.max\(ADMIN_LIST_SEARCH_MAX\)/)
  })
})
