/*
 * GitHub Copilot identity resolver (Stream B) — the directory-sync writer.
 *
 * Runs daily (identity-sync worker). Per reconciled GitHub enterprise it sweeps the
 * Copilot seat roster (login -> license-org), reads each org's SAML externalIdentities
 * (login -> SSO email), resolves the SSO email to a TokenScope teammate, and UPSERTS
 * teammate_identity_map on the widened key (system, COALESCE(enterprise_slug,''),
 * lower(identifier)). It is the ONLY writer allowed to upsert that key — the human
 * self-service POST keeps its throw-on-collision (anti-claim-jacking, §7.3 R3 M-3) and
 * sits in a different lane (enterprise_slug NULL), so directory-sync never clobbers it.
 *
 * Identity is directory-sourced end to end: GitHub seats + SAML, then Entra. The
 * Copilot OTel span's salted pseudo.id is never reversed (§14).
 *
 * ADR-0010 rule 1 (the bill is proof the user exists): a login WITH a SAML email that
 * doesn't resolve to a teammate is now bill-driven PROVISIONED here (region-floored to
 * the license-org, D4) so its seat cost reaches showback — it is NOT dropped. Only a
 * login with NO SAML email (or a provisioning failure) is carried forward to the next
 * run. The earlier "carried forward, never dropped" wording hid a real drop of the
 * seat's cost; provisioning closes it.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../../drizzle/schema'
import { recordAuditEvent } from '../../db/audit'
import { resolveEnterpriseCredential, type ResolvedCredential } from '../credentials'
import { provisionAndPlace } from '../placement-service'
import { makePlacementStore } from '../placement-store'
import { regionForLicenseOrg } from '../org-region'
import type { IdentityResolver } from './registry'
import { GithubCopilotClient } from './github-client'
import { GithubAppAuth } from './github-app-auth'

type Db = PostgresJsDatabase<typeof schema>

/* ADR-0010 rule 1 + D4: provision a teammate for a Copilot seat-holder who has a SAML
 * email (provider-attested) but isn't a teammate yet — homed to the license-org's region
 * floor. The bill is proof they exist, so they are provisioned, NOT dropped (the old
 * `carriedNoTeammate` skip lost their seat cost entirely). Injectable so unit tests don't
 * touch Graph/placement. Returns the new teammate id, or null if provisioning is
 * unavailable/failed (→ carried forward as before). */
export type SeatHolderProvisioner = (args: {
  email: string
  fallbackRegionId: string | null
}) => Promise<string | null>

/*
 * The read surfaces the resolver needs — stubbable in tests. BOTH modes bridge identity
 * PER-ORG via SAML `externalIdentities` (listSamlIdentities): they differ only in how the
 * seat roster (which logins to bind) is fetched —
 *   - PAT mode: listSeats (ONE enterprise call, seat.organization = license org),
 *   - App mode: listOrgCopilotSeats per license org (the enterprise seats endpoint is App-
 *     blocked; org seats + org externalIdentities are read with each org's installation token).
 * All are listed so a single stub can satisfy either path; the resolver only calls the
 * methods for the path it took (chosen by credential.kind).
 */
export type GithubDirectoryClient = Pick<
  GithubCopilotClient,
  'listSeats' | 'listSamlIdentities' | 'listOrgCopilotSeats'
>

export interface GithubIdentityDeps {
  /** Build the directory client for an enterprise; defaults to the live GitHub client.
   *  `credential` carries the resolved kind/appId/value so clientFor can pick PAT vs App.
   *  (Back-compat: the legacy 2-arg form (slug, pat) is still accepted; see the default.) */
  clientFor?: (enterpriseSlug: string, credential: ResolvedCredential) => GithubDirectoryClient
  /** Injected clock for deterministic verified_at / last_sync_at. */
  now?: () => Date
  /*
   * Optional Entra canonicaliser: SSO nameId (a UPN) -> teammate primary email, used
   * only when a direct teammate.email match misses and Graph is wired
   * (NUXT_GRAPH_DIRECTORY_MODE='graph'). Injectable so tests never touch Graph.
   */
  graphCanonicalEmail?: (ssoEmail: string) => Promise<string | null>
  /*
   * ADR-0010 rule 1 + D4: bill-driven provisioner for a seat-holder with a SAML email
   * but no teammate. Defaults to provisionAndPlace + the SQL placement store; injected
   * in tests. Set to a no-op returning null to disable provisioning (carry-forward).
   */
  provisionSeatHolder?: SeatHolderProvisioner
}

interface SyncCounts {
  upserts: number
  carriedNoEmail: number
  carriedNoTeammate: number
  /** Seat-holders bill-driven-provisioned this run (ADR-0010 rule 1 — were dropped before). */
  provisioned: number
  orgsBridged: number
  orgsUnavailable: number
}

async function resolveTeammateId(
  db: Db,
  ssoEmail: string,
  graphCanonicalEmail: GithubIdentityDeps['graphCanonicalEmail'],
): Promise<string | null> {
  // MONEY-PATH GUARD (PR #87 FIX 1): teammate.email is a PARTIAL unique index
  // (mig 0057, WHERE NOT provisional) — a real teammate and provisional shadow(s)
  // can share an email. Identity binding feeds chargeback, so it MUST resolve the
  // REAL teammate, never a provisional shadow: filter `NOT provisional` (unique by
  // the partial index; ORDER BY id is a deterministic tiebreak).
  const direct = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM teammate
     WHERE lower(email) = lower(${ssoEmail}) AND NOT provisional
     ORDER BY id LIMIT 1
  `)
  if (direct[0]) return direct[0].id

  // Fallback: the SSO nameId may be a UPN that differs from the teammate's primary
  // mail. Canonicalise via Entra (when wired) and retry once on the canonical email.
  if (graphCanonicalEmail) {
    const canonical = await graphCanonicalEmail(ssoEmail)
    if (canonical && canonical.toLowerCase() !== ssoEmail.toLowerCase()) {
      const viaGraph = await db.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM teammate
         WHERE lower(email) = lower(${canonical}) AND NOT provisional
         ORDER BY id LIMIT 1
      `)
      if (viaGraph[0]) return viaGraph[0].id
    }
  }
  return null
}

/*
 * The onboarded license orgs for one enterprise (App mode), from provider_org joined to its
 * enterprise (mig 0038 lane link) — the canonical org-enumeration shape used by github.ts
 * (resolveEnterpriseForOrg). App mode iterates these and reads each org's seats +
 * externalIdentities with that org's installation token. Empty ⇒ no orgs onboarded yet.
 */
async function licenseOrgsFor(db: Db, slug: string): Promise<string[]> {
  const rows = await db.execute<{ org: string }>(sql`
    SELECT po.external_org_id AS org
    FROM provider_org po
    JOIN provider_enterprise pe ON pe.id = po.provider_enterprise_id
    WHERE po.provider = 'github' AND lower(pe.external_id) = lower(${slug})
    ORDER BY po.external_org_id
  `)
  return rows.map((r) => r.org)
}

async function syncOneEnterprise(
  db: Db,
  enterpriseSlug: string,
  client: GithubDirectoryClient,
  credential: ResolvedCredential,
  nowIso: string,
  graphCanonicalEmail: GithubIdentityDeps['graphCanonicalEmail'],
  provisionSeatHolder: SeatHolderProvisioner,
): Promise<SyncCounts> {
  const counts: SyncCounts = { upserts: 0, carriedNoEmail: 0, carriedNoTeammate: 0, provisioned: 0, orgsBridged: 0, orgsUnavailable: 0 }

  // CANONICAL CASING (P1-7 / mig 0062): the enterprise key is lowercase everywhere
  // (provider_enterprise.external_id is CHECK-constrained lowercase; the reader +
  // credential resolver compare lower()=lower()). Normalise here at the write
  // boundary so the UPSERT writes enterprise_slug in the canonical case regardless
  // of the caller's casing — keeping the directory-sync writer self-consistent with
  // the unique index, the roster reader, and the credential resolver.
  const slug = enterpriseSlug.toLowerCase()

  /*
   * Two source maps, populated by EITHER path:
   *   - bindRows: the logins to bind, ORIGINAL-CASED, each with its license org. The
   *     UPSERT writes identifier/github_login in this casing (preserved per source).
   *   - emailByLogin: login (lowercased) -> SSO email, the bridge used to resolve a
   *     teammate. Lowercased because the lookup compares case-insensitively.
   *
   * BOTH modes bridge identity PER-ORG via SAML externalIdentities (login -> SSO email) —
   * SSO is configured per org (Azure AD). They differ ONLY in how the seat roster is read:
   *
   * App mode (credential.kind === 'github-app'): iterate the enterprise's onboarded license
   * orgs (provider_org) and, per org, read its Copilot SEATS (listOrgCopilotSeats) + its
   * externalIdentities (listSamlIdentities) with THAT org's installation token. The enterprise
   * consumed-licenses endpoint is App-blocked for installation tokens, so there is no single
   * enterprise identity call — the org token bridges each org exactly as PAT mode does. Each
   * org is isolated (its own try/catch → orgsUnavailable), and licenseOrg is correctly
   * populated per row (unlike the old consumed-licenses path, which wrote NULL).
   *
   * PAT (SAML) mode (default): seats (login -> license org) + per-org SAML externalIdentities.
   * UNCHANGED back-compat path.
   */
  const bindRows: { login: string; licenseOrg: string | null }[] = []
  const emailByLogin = new Map<string, string>()

  if (credential.kind === 'github-app') {
    // App mode: per-org seats + externalIdentities via each org's installation token. Enumerate
    // the onboarded license orgs from provider_org; zero orgs is a legible warn (NOT a silent
    // success and NOT a throw) — counts stay zero so the audit shows nothing bridged.
    const orgs = await licenseOrgsFor(db, slug)
    if (orgs.length === 0) {
      console.warn(`[github-identity] ${slug} App mode: no license orgs onboarded (provider_org) — nothing to bridge`)
    }
    for (const org of orgs) {
      // Isolate ONE org: a permission/SSO/egress failure on this org must not fail the whole
      // enterprise — its seats simply carry forward (counted as one unavailable bridge).
      try {
        const seats = await client.listOrgCopilotSeats(org)
        for (const s of seats) bindRows.push({ login: s.login, licenseOrg: org })
        const identities = await client.listSamlIdentities(org)
        for (const id of identities) emailByLogin.set(id.login.toLowerCase(), id.ssoEmail)
        counts.orgsBridged += 1
      } catch (err) {
        counts.orgsUnavailable += 1
        console.warn(`[github-identity] ${slug} App mode: license org bridge unavailable for an org: ${String(err)}`)
      }
    }
  } else {
    const seats = await client.listSeats()
    const seatRows = seats
      .map((s) => ({
        login: s.assignee.login,
        licenseOrg: s.organization?.login ?? null,
      }))
      .filter((s) => s.login)
    bindRows.push(...seatRows)

    // SAML is configured per ORG (Azure AD), so bridge each distinct license org once.
    const distinctOrgs = [...new Set(seatRows.map((s) => s.licenseOrg).filter((o): o is string => !!o))]
    for (const org of distinctOrgs) {
      try {
        const identities = await client.listSamlIdentities(org)
        for (const id of identities) emailByLogin.set(id.login.toLowerCase(), id.ssoEmail)
        counts.orgsBridged += 1
      } catch (err) {
        // SSO not authorised / scope missing for this org -> its seats carry forward.
        counts.orgsUnavailable += 1
        console.warn(`[github-identity] ${enterpriseSlug} SAML bridge unavailable for an org: ${String(err)}`)
      }
    }
  }

  for (const seat of bindRows) {
    const ssoEmail = emailByLogin.get(seat.login.toLowerCase())
    if (!ssoEmail) {
      counts.carriedNoEmail += 1
      continue
    }
    let teammateId = await resolveTeammateId(db, ssoEmail, graphCanonicalEmail)
    if (!teammateId) {
      // ADR-0010 rule 1 + D4: the seat-holder has a provider-attested SAML email but no
      // teammate yet — PROVISION them (the bill is proof they exist), homed to the
      // license-org's region floor. Dropping them here is exactly the gap ADR-0010 fixes:
      // their seat cost would never reach showback. A failure carries forward (next run
      // retries), never throws the whole enterprise.
      try {
        const fallbackRegionId = await regionForLicenseOrg(db, seat.licenseOrg)
        const provisionedId = await provisionSeatHolder({ email: ssoEmail, fallbackRegionId })
        if (provisionedId) {
          teammateId = provisionedId
          counts.provisioned += 1
        }
      } catch (err) {
        console.warn(`[github-identity] ${enterpriseSlug} seat provisioning failed: ${String(err)}`)
      }
    }
    if (!teammateId) {
      counts.carriedNoTeammate += 1
      continue
    }

    // Authoritative directory upsert on the widened, case-insensitive key. Cannot
    // clobber a self-service link (that row has enterprise_slug NULL -> a different
    // COALESCE('') lane). enterprise_slug is written in the canonical lowercase
    // (`slug`) so it agrees with the unique index, the roster reader, and the
    // credential resolver (P1-7 / mig 0062).
    await db.execute(sql`
      INSERT INTO teammate_identity_map (
        teammate_id, system, identifier, identifier_kind, github_login, enterprise_slug,
        license_org, sso_email, billing_relationship, source, is_pinned, is_canonical,
        verified_at, last_sync_at
      ) VALUES (
        ${teammateId}::uuid, 'github', ${seat.login}, 'username', ${seat.login}, ${slug},
        ${seat.licenseOrg}, ${ssoEmail}, 'enterprise-reconciled', 'directory-sync', false, false,
        ${nowIso}::timestamptz, ${nowIso}::timestamptz
      )
      ON CONFLICT (system, (COALESCE(enterprise_slug, '')), (lower(identifier)))
      DO UPDATE SET
        teammate_id = EXCLUDED.teammate_id,
        github_login = EXCLUDED.github_login,
        license_org = EXCLUDED.license_org,
        sso_email = EXCLUDED.sso_email,
        billing_relationship = EXCLUDED.billing_relationship,
        source = EXCLUDED.source,
        verified_at = EXCLUDED.verified_at,
        last_sync_at = EXCLUDED.last_sync_at
    `)
    counts.upserts += 1
  }

  return counts
}

/*
 * Resolve all reconciled GitHub enterprises. Self-contained per the IdentityResolver
 * contract (it gets only `db`): it looks up the enterprises + credentials itself.
 */
export async function syncGithubIdentities(
  db: Db,
  deps: GithubIdentityDeps = {},
): Promise<{ provider: 'github'; upserts: number }> {
  // Default clientFor branches on the resolved credential kind: App mode builds an
  // App-auth client (per-installation tokens); PAT mode builds the classic PAT client.
  const clientFor =
    deps.clientFor ??
    ((slug: string, credential: ResolvedCredential): GithubDirectoryClient =>
      credential.kind === 'github-app'
        ? GithubCopilotClient.withApp(slug, new GithubAppAuth(credential.appId!, credential.value))
        : GithubCopilotClient.withPat(slug, credential.value))
  const nowIso = (deps.now?.() ?? new Date()).toISOString()
  // Default bill-driven provisioner: provisionAndPlace + the SQL store, region-floored to
  // the license-org (ADR-0010 rule 1 + D4). Tests inject a fake; a null result carries forward.
  const provisionSeatHolder: SeatHolderProvisioner =
    deps.provisionSeatHolder ??
    (async ({ email, fallbackRegionId }) => {
      const outcome = await provisionAndPlace(email, {
        store: makePlacementStore(db),
        fallbackRegionId: fallbackRegionId ?? undefined,
      })
      return outcome.teammateId
    })

  const ents = await db.execute<{ id: string; external_id: string }>(sql`
    SELECT id::text AS id, external_id FROM provider_enterprise
    WHERE provider = 'github' AND reconciliation_mode = 'reconciled'
    ORDER BY external_id
  `)

  let totalUpserts = 0
  for (const ent of ents) {
    const credential = await resolveEnterpriseCredential(db, { provider: 'github', externalId: ent.external_id })
    if (!credential) {
      console.warn(`[github-identity] no credential for enterprise ${ent.external_id} — skipped`)
      continue
    }
    let counts: SyncCounts
    try {
      const client = clientFor(ent.external_id, credential)
      counts = await syncOneEnterprise(
        db,
        ent.external_id,
        client,
        credential,
        nowIso,
        deps.graphCanonicalEmail,
        provisionSeatHolder,
      )
    } catch (err) {
      // Isolate a failing enterprise so it cannot starve the others (retried daily).
      console.warn(`[github-identity] enterprise ${ent.external_id} sync failed: ${String(err)}`)
      continue
    }
    totalUpserts += counts.upserts

    // Summary audit (per-run, per-enterprise) — bulk-sync precedent (not per-row).
    // subject_id is the provider_enterprise UUID; the slug rides in context. Its own
    // catch so a transient audit-write failure cannot starve the remaining enterprises
    // (the upserts above already committed as independent statements).
    try {
      await recordAuditEvent(db, {
        eventType: 'identity-sync-github',
        actorSystem: 'worker:identity-sync',
        subjectKind: 'provider_enterprise',
        subjectId: ent.id,
        payload: { after: { ...counts }, context: { enterpriseSlug: ent.external_id } },
      })
    } catch (err) {
      console.warn(`[github-identity] audit write failed for enterprise ${ent.external_id}: ${String(err)}`)
    }
  }

  return { provider: 'github', upserts: totalUpserts }
}

/** Identity resolver registered in registry.ts (IDENTITY_RESOLVERS). */
export function createGithubIdentityResolver(deps: GithubIdentityDeps = {}): IdentityResolver {
  return (db: Db) => syncGithubIdentities(db, deps)
}
