/*
 * GET /api/v1/meta/build — what this instance is running.
 *
 * UNAUTHENTICATED by design: its first consumer is the login page, which by
 * definition has no session, and "which build am I looking at" is the first
 * question anyone asks when a deployed environment misbehaves.
 *
 * Deliberately narrow, because unauthenticated: the app version, the SHORT
 * commit, and the deploy environment. Not the full sha, not the Container App
 * revision name (that leaks infrastructure naming), nothing DB-derived (an
 * instance's region/tenant shape is not public information).
 *
 * Read at REQUEST time, not baked into the client bundle, so the value tracks
 * the container that actually served you — including a Bicep-level
 * GIT_COMMIT_SHA override applied after the image was built.
 */
import { defineEventHandler } from 'h3'
import { useRuntimeConfig } from 'nitropack/runtime'
import { currentServerDeployEnv } from '../../../../shared/env/deploy-env'
import { shortCommit, type BuildInfo } from '../../../../shared/build-info'

export default defineEventHandler((): BuildInfo => {
  const config = useRuntimeConfig()
  return {
    environment: currentServerDeployEnv(),
    version: String(config.public.appVersion ?? ''),
    commit: shortCommit(process.env.GIT_COMMIT_SHA),
  }
})
