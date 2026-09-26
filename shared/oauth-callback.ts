/*
 * Client-side guards for the OAuth consent page's callback URL. The server has
 * already matched redirect_uri against the registered client; these are
 * defence-in-depth so the page never opens a javascript:/data:/file: URL.
 */
const LOOPBACK_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|::1)$/

function parse(url: string, base?: string): URL | null {
  try {
    return new URL(url, base)
  } catch {
    return null
  }
}

function isLoopbackHttp(parsed: URL): boolean {
  return parsed.protocol === 'http:' && LOOPBACK_HOST.test(parsed.hostname.replace(/^\[|\]$/g, ''))
}

/** `https:` or loopback `http:` — the only callbacks the page may open. */
export function isAllowedCallbackScheme(url: string, base?: string): boolean {
  const parsed = parse(url, base)
  return !!parsed && (parsed.protocol === 'https:' || isLoopbackHttp(parsed))
}

/** RFC 8252 §7.3 loopback redirect — delivered by top-level navigation. */
export function isLoopbackCallback(url: string, base?: string): boolean {
  const parsed = parse(url, base)
  return !!parsed && isLoopbackHttp(parsed)
}
