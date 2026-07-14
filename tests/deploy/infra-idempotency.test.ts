/*
 * Infra idempotency test — exercises `az deployment group what-if`
 * against a live RG and asserts that a re-apply would be a no-op
 * (except for KV-secret writes, which always show as `Modify` because
 * @secure() values can't be diffed by ARM).
 *
 * Gating: requires AZURE_RESOURCE_GROUP env var. Skips otherwise. Run
 * after a successful `infra.yml` apply; this asserts the deploy is
 * truly idempotent rather than racy.
 *
 * The `az` CLI must already be authenticated in the calling shell.
 * On GH Actions, the OIDC login step in infra.yml leaves the session
 * authenticated for subsequent steps; locally you'd `az login` first.
 */
import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'

const rg = process.env.AZURE_RESOURCE_GROUP
const skip = !rg || !process.env.RUN_DEPLOY_TESTS

describe.skipIf(skip)('infra-idempotency', () => {
  it('what-if on a freshly-applied RG reports no structural changes', () => {
    /*
     * `az deployment group what-if` returns one of:
     *   - "Resource and property changes are indicated with these symbols:"
     *     followed by a list. Filter out lines that are entirely about
     *     KV-secret value drift (ARM marks @secure() params as Modify
     *     every time because it can't tell if the value changed).
     *
     * Pass criteria: the diff has only KV-secret rows; no resource
     * additions, deletions, or non-secret property changes.
     */
    const raw = execSync(
      `az deployment group what-if --resource-group "${rg}" ` +
        `--template-file infra/main.bicep --no-pretty-print`,
      { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
    )

    // Count "Modify"/"Create"/"Delete" lines, filtering KV-secret writes.
    const lines = raw.split('\n')
    const changes = lines.filter((l) =>
      /^[~+-]\s/.test(l),
    )
    const nonSecretChanges = changes.filter(
      (l) => !/Microsoft\.KeyVault\/vaults\/secrets\//.test(l),
    )

    expect(nonSecretChanges, `non-secret changes found:\n${nonSecretChanges.join('\n')}`).toHaveLength(0)
  })
})
