# Deploy-time tests

Maintainer tests that run **against a deployed environment**, not the local dev
stack. Neither is part of `npm run test:*` or CI: the Vitest config only includes
`tests/unit`, `tests/integration` and the `__tests__` folders, and the Playwright
config's `testDir` is `tests/e2e`.

## `against-deployed.spec.ts` (Playwright)

A public-surface smoke check of a deployed app: `/api/health`, `/login`, the
unauthenticated redirect from `/`, and 401s from `/api/v1/me/usage` and the
HMAC-gated internal worker endpoint. It does not sign in.

Point it at the address you reach the app on (the Front Door endpoint, or the
Container App FQDN when it is reachable from where you run it). Passing the test
directory as the config makes Playwright use it as the test directory; the
`against-deployed` filter keeps it from loading the Vitest file beside it:

```bash
npx playwright install chromium        # once
DEPLOYED_BASE_URL="https://<your-app-host>" \
  npx playwright test -c tests/deploy against-deployed
```

Without `DEPLOYED_BASE_URL` every test is skipped.

## `infra-idempotency.test.ts` (Vitest)

Intended to run `az deployment group what-if` against a freshly applied resource
group and assert that nothing but Key Vault secret values would change.

**Not runnable from the public tree yet.** The Vitest config does not include
`tests/deploy`, and the test calls `what-if` with the template only, without a
parameters file or the secrets the template requires, so it cannot complete as
written. To check idempotency by hand, run `what-if` yourself with the same
parameters file and environment variables you applied with (see
[docs/DEPLOY-AZURE.md](../../docs/DEPLOY-AZURE.md)):

```bash
az deployment group what-if -g <your-rg> -f infra/main.bicep \
  -p infra/parameters/<your>.bicepparam
```

The test's pass criterion is the one to apply: `Modify` rows for Key Vault
secrets are expected (their `@secure()` values cannot be compared); any other
change means the apply is not idempotent.
