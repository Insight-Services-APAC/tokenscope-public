/*
 * The role-change confirm dialog says what the new role can do (#543), for
 * every role that can be granted, and names the role with its article.
 */
import { describe, it, expect } from 'vitest'
import { ROLE_CAPABILITIES, SELECTABLE_ROLES, roleLabel, roleWithArticle } from '../../../shared/auth/roles'

describe('ROLE_CAPABILITIES', () => {
  it.each(SELECTABLE_ROLES.map((r) => [r]))('%s has a sentence that names it', (role) => {
    const text = ROLE_CAPABILITIES[role]
    expect(text).toBeTruthy()
    expect(text).toContain(roleLabel(role))
  })
})

describe('roleWithArticle', () => {
  it('uses an before a vowel and a otherwise', () => {
    expect(roleWithArticle('platform-admin')).toBe('an Admin')
    expect(roleWithArticle('developer')).toBe('a Developer')
    expect(roleWithArticle('manager')).toBe('a Manager')
  })
})
