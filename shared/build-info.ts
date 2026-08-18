/*
 * Build identity — what this running instance actually IS.
 *
 * One composer, used by every surface that shows it, because the alternative is
 * what the login page shipped with for a year: a hand-typed
 * "APAC · v0.1.0 · MVP-Lite first slice" that was wrong on all three counts —
 * dev is a global instance, the version had moved on, and the slice label
 * outlived the slice. Anything hand-maintained drifts; the fix is that no human
 * types this string.
 *
 * Each field comes from the layer that actually knows it:
 *   version     package.json, baked at build (the artefact's own identity)
 *   commit      GIT_COMMIT_SHA, baked by the Dockerfile ARG at build and
 *               overridable by the Container App env (Bicep contract)
 *   environment classified at runtime from NUXT_DEPLOY_ENV (deploy-env.ts)
 */
import type { DeployEnv } from './env/deploy-env'

export interface BuildInfo {
  environment: DeployEnv
  /** Semantic version of the app package, e.g. "1.0.0-rc.1". */
  version: string
  /** Short commit sha, or null when nothing baked one in. */
  commit: string | null
}

/** Abbreviate a commit sha for display; null-safe, and "unknown" reads as null. */
export function shortCommit(sha: string | null | undefined): string | null {
  if (!sha || sha === 'unknown') return null
  return sha.slice(0, 7)
}

/**
 * The one-line stamp shown in the UI.
 *
 * The environment is included EXCEPT on production, where "you are on
 * production" is noise on every page — while "you are on dev" is exactly the
 * thing someone needs to know before they trust what they are looking at.
 * Missing pieces are omitted rather than rendered as "unknown": a stamp that
 * says less is better than one that says something false.
 */
export function formatBuildStamp(info: BuildInfo): string {
  const parts: string[] = []
  if (info.environment !== 'production') parts.push(info.environment)
  if (info.version) parts.push(`v${info.version}`)
  if (info.commit) parts.push(info.commit)
  return parts.join(' · ')
}
