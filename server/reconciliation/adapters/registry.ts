/*
 * Adapter & identity-resolver registration seams — the ONLY shared edit point
 * between the two concurrent streams (Stream A = Anthropic, Stream B = GitHub).
 *
 * Phase 0 ships these EMPTY. Each stream registers its provider by adding one
 * line below when its adapter/resolver lands (a 1-line add to a known list — git
 * merges adjacent adds cleanly; no other foundation file changes). The
 * reconciliation-sync / identity-sync worker shells iterate over whatever is
 * registered, so until a stream registers, that provider is a clean no-op.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../../drizzle/schema'
import type { Adapter, ReconcileProvider } from '../types'
import type { ResolvedCredential } from '../credentials'
import { createAnthropicAdapter } from './anthropic'
import { createGithubAdapter } from './github'
import { createGithubIdentityResolver } from './github-identity'

type Db = PostgresJsDatabase<typeof schema>

/** Which Anthropic API reconciles an org (provider_org.api_kind, mig 0063).
 *  github scopes carry null (Copilot has a single billing API). */
export type AnthropicApiKind = 'enterprise-analytics' | 'claude-code-admin'

/** The credential-bound scope an adapter instance reconciles (one org or enterprise). */
export interface AdapterScope {
  /** anthropic org id | github enterprise slug. */
  externalRef: string
  credential: ResolvedCredential
  /** Anthropic only: which API reconciles this org. The anthropic adapter BRANCHES
   *  on it (mig 0063). Null for github / when unthreaded (adapter defaults to the
   *  legacy 'claude-code-admin' path). See docs/design/reconciliation-engine.md §4.1. */
  apiKind?: AnthropicApiKind | null
}

export type AdapterFactory = (db: Db, scope: AdapterScope) => Adapter

/** Seeds teammate_identity_map from a provider directory (seats + SCIM/SAML). */
export type IdentityResolver = (db: Db) => Promise<{ provider: ReconcileProvider; upserts: number }>

/*
 *   Stream A (Anthropic): registered below.
 *   Stream B adds: github: createGithubAdapter
 */
export const ADAPTER_FACTORIES: Partial<Record<ReconcileProvider, AdapterFactory>> = {
  anthropic: createAnthropicAdapter,
  github: createGithubAdapter,
}

/*
 * Phase 0: empty.
 *   Stream A adds the Anthropic resolver (actor email -> teammate)
 *   Stream B adds the GitHub resolver (seats + SCIM/SAML -> github_login -> teammate)
 */
export const IDENTITY_RESOLVERS: IdentityResolver[] = [createGithubIdentityResolver()]
