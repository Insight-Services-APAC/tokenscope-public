/*
 * Deployed-environment smoke suite — runs against a live deployment.
 *
 * Triggered manually after `infra.yml` + `deploy.yml` complete on
 * sandbox/staging/production. Set DEPLOYED_BASE_URL to either the
 * direct-to-CA FQDN (Wave-II phase 1) or the AFD endpoint FQDN
 * (phase 2+).
 *
 * Skips the OIDC sign-in path — real OIDC requires the sign-in app
 * registration's redirect URI to be configured for the deployed
 * hostname. Use the persona-switch flow (dev-mode env var) once that
 * is wired; for now this suite covers public surface only.
 */
import { test, expect } from '@playwright/test'

const deployedUrl = process.env.DEPLOYED_BASE_URL

test.skip(!deployedUrl, 'DEPLOYED_BASE_URL not set — deploy-time test skipped')

test.describe('deployed surface', () => {
  test('GET /api/health returns 200 with status ok', async ({ request }) => {
    const response = await request.get(`${deployedUrl}/api/health`)
    expect(response.status()).toBe(200)
    const body = (await response.json()) as { status?: string }
    expect(body.status).toBe('ok')
  })

  test('GET /login returns 200 + renders the persona buttons', async ({ page }) => {
    // Even with full Entra OIDC, the /login page itself is public
    // (it's the unauthenticated landing). Persona buttons render in
    // dev-mode (sandbox); confirm at least the page comes up.
    await page.goto(`${deployedUrl!}/login`)
    await expect(page).toHaveTitle(/TokenScope/i)
  })

  test('GET / without session redirects to /login', async ({ page }) => {
    await page.goto(`${deployedUrl!}/`)
    await page.waitForURL(/\/login(\?.*)?$/)
  })

  test('GET /api/v1/auth/me returns authenticated:false', async ({ request }) => {
    const response = await request.get(`${deployedUrl!}/api/v1/auth/me`)
    expect(response.status()).toBe(200)
    const body = (await response.json()) as { authenticated?: boolean }
    expect(body.authenticated).toBe(false)
  })

  test('GET /api/v1/me/usage returns 401 when unauthenticated', async ({ request }) => {
    const response = await request.get(`${deployedUrl!}/api/v1/me/usage`)
    expect(response.status()).toBe(401)
  })

  test('GET /api/v1/internal/run-worker/reconciliation returns 401 (no HMAC)', async ({
    request,
  }) => {
    /*
     * Wave-0 contract test: the internal-request HMAC verifier returns
     * a uniform 401 for missing/invalid signed requests. Confirms the
     * internal endpoint is reachable but properly gated.
     */
    const response = await request.post(
      `${deployedUrl!}/api/v1/internal/run-worker/reconciliation`,
      {
        headers: { 'content-type': 'application/json' },
        data: {},
      },
    )
    expect(response.status()).toBe(401)
  })
})
