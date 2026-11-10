/*
 * What the "Spend we could not match" list calls each row's source (#545).
 * `actual_spend.source` is a key with the provider account inside it
 * (server/reconciliation/source-org-ref.ts has the convention and the
 * server's parser); the page used to print it raw. The account id stays
 * visible: it is what an admin registers or links.
 * tests/unit/shared/unmatched-source.test.ts keeps this in step with the
 * server parser.
 */

const ANTHROPIC = 'anthropic-analytics-api'
const GITHUB_SEAT = 'copilot-seat'

export function unmatchedSourceLabel(source: string): string {
  if (source === ANTHROPIC) return 'Anthropic, no organisation recorded'
  if (source.startsWith(`${ANTHROPIC}:`)) {
    const id = source.slice(ANTHROPIC.length + 1).trim()
    return id ? `Anthropic organisation ${id}` : 'Anthropic, no organisation recorded'
  }
  if (source.startsWith(`${GITHUB_SEAT}:`)) {
    const login = source.slice(GITHUB_SEAT.length + 1).trim()
    return login && login !== 'unknown'
      ? `GitHub Copilot seats, organisation ${login}`
      : 'GitHub Copilot seats, no organisation recorded'
  }
  return 'Another source'
}
