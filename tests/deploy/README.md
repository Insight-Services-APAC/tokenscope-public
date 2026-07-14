# Deploy-time tests

These tests run AGAINST a real deployed environment (sandbox / staging
/ production) — NOT against the local dev stack. They are Wave-IV
deliverables.

Two test files:

- `against-deployed.spec.ts` — Playwright suite that hits the deployed
  FQDN (direct-to-CA in Wave-II phase 1; AFD-fronted in phase 2+) and
  exercises the same flows as the local E2E suite. Driven by
  `DEPLOYED_BASE_URL` env var.

- `infra-idempotency.test.ts` — Vitest that calls `az deployment group
  what-if` against the live RG and parses the output. Pass criteria:
  the second apply reports zero structural changes (idempotent). Calls
  out KV-secret writes which always show as `Modify` because the
  values are passed as @secure() (ARM can't diff them); these are
  filtered from the "changed" count.

Both files are GATED on opt-in env vars so the local `npm run test:*`
invocations skip them — they require Azure auth + a live RG.

Run patterns:

```
# Against sandbox after a deploy
DEPLOYED_BASE_URL="https://ca-tokenscope-sandbox-aue.<hash>.australiaeast.azurecontainerapps.io" \
  npx playwright test tests/deploy/against-deployed.spec.ts

# Idempotency check (requires az auth)
AZURE_RESOURCE_GROUP=rg-tokenscope-sandbox \
  npx vitest run tests/deploy/infra-idempotency.test.ts
```

The CI workflows don't run these automatically. The validation
playbook (`docs/development/sandbox-validation-playbook.md`) calls them
out as manual steps in each scenario.
