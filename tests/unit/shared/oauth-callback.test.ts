import { describe, it, expect } from 'vitest'
import { isAllowedCallbackScheme, isLoopbackCallback } from '../../../shared/oauth-callback'

describe('oauth callback guards', () => {
  it.each([
    'http://127.0.0.1:53682/?code=a',
    'http://127.1.2.3/cb',
    'http://localhost:8080/cb',
    'http://[::1]:9000/cb',
  ])('loopback http is allowed and loopback: %s', (url) => {
    expect(isAllowedCallbackScheme(url)).toBe(true)
    expect(isLoopbackCallback(url)).toBe(true)
  })

  it('https is allowed but is not a loopback callback', () => {
    expect(isAllowedCallbackScheme('https://client.example/cb')).toBe(true)
    expect(isLoopbackCallback('https://client.example/cb')).toBe(false)
    expect(isLoopbackCallback('https://127.0.0.1/cb')).toBe(false)
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'http://example.com/cb',
    'http://127.0.0.1.evil.example/cb',
    'http://localhost.evil.example/cb',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isAllowedCallbackScheme(url)).toBe(false)
    expect(isLoopbackCallback(url)).toBe(false)
  })
})
