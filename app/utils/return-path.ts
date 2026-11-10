/*
 * Where the sign-in page sends someone once they are signed in (#541).
 *
 * The global auth middleware sends a signed-out visitor to
 * `/login?next=<the page they asked for>`. `next` arrives in a URL anyone can
 * write, so it is only followed when it is a path on this site; anything else
 * returns null and the caller lands on Home.
 *
 * The server checks it again: the Microsoft button hands it to the OIDC
 * module as `callbackRedirectUrl`, whose own sanitiser
 * (tests/unit/server/oidc-callback-redirect.test.ts) refuses the same
 * cross-origin shapes. This client check exists so the page never offers a
 * return it would not honour, and so the demo sign-in path, which navigates
 * on the client, is held to the same rule.
 */

const ORIGIN = 'https://return-path.invalid'

/**
 * `next` if it is a same-site path to return to, else null.
 *
 * Refused: anything not starting with a single `/` (absolute URLs,
 * protocol-relative `//host`), any backslash (browsers read `/\host` as
 * `//host`), control characters, and paths that would loop back into sign-in
 * itself (`/login`, `/auth/...`).
 */
export function safeReturnPath(next: unknown): string | null {
  if (typeof next !== 'string' || next === '') return null
  if (!next.startsWith('/') || next.startsWith('//')) return null
  if (next.includes('\\')) return null
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return null
  }
  let url: URL
  try {
    url = new URL(next, ORIGIN)
  } catch {
    return null
  }
  if (url.origin !== ORIGIN) return null
  if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return null
  if (url.pathname.startsWith('/auth/')) return null
  const path = url.pathname + url.search + url.hash
  // Normalising can turn a refused shape back into one (`/x/..//host`
  // serialises as `//host`), so the result is checked again.
  if (path.startsWith('//') || path.includes('\\')) return null
  return path
}

/**
 * Whether there is a page to return to that is not Home. `/` is followed (a
 * visitor who opened Home goes back to Home, not to a role's landing page),
 * but says nothing: sign-in lands there anyway.
 */
export function isPageToReturnTo(path: string | null): path is string {
  return path !== null && path !== '/'
}

/**
 * The return path with the fragment the browser still holds. The middleware
 * builds `next` on the server, which never sees a fragment, but a browser
 * keeps the fragment across the redirect to /login: so `/projects/X#manage`
 * (the inbox's budget request link) arrives as `/login?next=/projects/X#manage`.
 * Only a plain anchor is carried, and only when `next` has none of its own.
 */
export function withBrowserHash(path: string | null, hash: string): string | null {
  if (path === null || path.includes('#')) return path
  if (!/^#[A-Za-z0-9_-]{1,64}$/.test(hash)) return path
  return safeReturnPath(path + hash)
}

/**
 * The Microsoft sign-in link. With a return path it carries it as the OIDC
 * module's `callbackRedirectUrl`: login.get stores that in the OIDC session and
 * the callback redirects there (server/api/v1/oauth/authorize.get.ts uses the
 * same parameter). It is honoured only because the entra provider config pins
 * no callbackRedirectUrl of its own.
 */
export function entraLoginHref(returnPath: string | null): string {
  return isPageToReturnTo(returnPath)
    ? `/auth/entra/login?callbackRedirectUrl=${encodeURIComponent(returnPath)}`
    : '/auth/entra/login'
}
