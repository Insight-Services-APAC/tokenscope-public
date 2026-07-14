/*
 * TokenScope MCP server — read-only tools over the developer's own attribution
 * data, authenticated by the OAuth 2.1 access token (scope `tokenscope.read`).
 *
 * Shape ported from the a sibling project MCP server (server/utils/mcp.ts +
 * server/api/mcp/[...].ts): a fresh `McpServer` per request, Streamable HTTP
 * transport, tools registered with raw-zod shapes, caller identity threaded
 * through `extra.authInfo.extra`. TokenScope differences:
 *
 *   - Auth is the OAuth bearer (server/auth/oauth-bearer.ts), already validated
 *     by the endpoint BEFORE the request reaches a tool. We pack the resolved
 *     `BearerTeammate` into authInfo so tools never re-parse the header.
 *   - Every tool runs its query inside `withRlsContext` built from the bearer
 *     teammate, reusing the exact same SQL as the REST `/me/*` endpoints
 *     (server/utils/me-queries.ts). No Redis, no session cookie.
 *
 * Tools are READ-ONLY this slice. Scope is enforced at the endpoint (a missing
 * `tokenscope.read` → 403 before any tool runs); the per-tool guard here is a
 * defence-in-depth re-check so a future multi-scope token can't reach a tool it
 * lacks the scope for.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import consola from 'consola'
import type { BearerTeammate } from '../auth/oauth-bearer'
import { getDb } from '../db'
import { withRlsContext, type RlsContext } from '../db/rls'
import { getMyUsage, getMyProjects, getActivityTypes, resolveRepoProject } from './me-queries'
import { tagSessionTx } from './tag-session'
import {
  loadProvisioningTeammate,
  locateOrCreateInstance,
  revokePriorHandoffsForInstance,
  mintEmitHandoff,
  EMIT_HANDOFF_TTL_MS,
  type EmitTool,
} from '../auth/emit-provision'
import { recordAuditEvent } from '../db/audit'
import { z } from 'zod'
import { SKILL_SETUP, SKILL_TAG, SKILL_PROJECT, SKILL_USAGE } from './skill-prompts.gen'

const logger = consola.withTag('mcp')

export const MCP_READ_SCOPE = 'tokenscope.read'
/** The write scope for the agentic tag tool (granted alongside read at enrol). */
export const MCP_TAG_SCOPE = 'tokenscope.tag'

type Db = PostgresJsDatabase<Record<string, unknown>>

/** Whether the bearer's granted scope set includes `scope` (defence in depth). */
function hasScope(teammate: BearerTeammate, scope: string): boolean {
  const granted = teammate.scope ? teammate.scope.split(' ').filter(Boolean) : []
  return granted.includes(scope)
}

/**
 * Map the bearer teammate to an RLS context. `platform-admin` maps to the
 * region-unbounded `global-finops` scope at the RLS layer (same convention as
 * server/db/request-rls.ts). The four GUCs the policies read are region / org
 * path / role / teammate-id — we resolve the org-unit path here because the
 * bearer carries region + teammate but not the ltree path.
 */
async function rlsContextFor(db: Db, teammate: BearerTeammate): Promise<RlsContext> {
  const rows = await db.execute<{ path: string | null }>(sql`
    SELECT ou.path::text AS path
      FROM teammate tm
      LEFT JOIN org_unit ou ON ou.id = tm.org_unit_id
     WHERE tm.id = ${teammate.teammateId}::uuid
     LIMIT 1
  `)
  // Fail CLOSED on a missing org path (CORE-2): '' is the universal ltree
  // ancestor, so `cou.path <@ ''::ltree` would be TRUE for every row and the
  // manager-scope predicates would become unbounded. Mirrors the cookie path
  // (jit-teammate.ts loadTeammateByOid), which throws for the same condition.
  const orgPath = [...rows][0]?.path
  if (!orgPath) {
    throw new Error(
      `Teammate ${teammate.teammateId} has no org_unit path — refusing to build an RLS context`,
    )
  }
  const role = (teammate.role === 'platform-admin' ? 'global-finops' : teammate.role) as
    RlsContext['userRole']
  return {
    userRegionId: teammate.regionId,
    userOrgPath: orgPath,
    userRole: role,
    userTeammateId: teammate.teammateId,
  }
}

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: true }

function jsonResult(value: unknown): ToolText {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function scopeError(scope: string): ToolText {
  const hint =
    scope === MCP_TAG_SCOPE
      ? ` Reconnect the TokenScope MCP and approve the tagging permission (re-run the tokenscope-setup prompt, or reconnect via /mcp).`
      : ''
  return {
    content: [
      { type: 'text' as const, text: `Insufficient scope. This tool requires '${scope}'.${hint}` },
    ],
    isError: true,
  }
}

/** Extract the authenticated bearer teammate the endpoint packed into authInfo. */
function getTeammate(authInfo: AuthInfo | undefined): BearerTeammate | undefined {
  return (authInfo?.extra?.teammate as BearerTeammate) ?? undefined
}

/**
 * Create and configure the TokenScope MCP server. A fresh instance is built per
 * request (McpServer.connect() binds a transport and throws on a second call;
 * tool registration is cheap, no I/O).
 *
 * @param dbOverride test-only handle so the integration harness can drive tools
 *                   against its testcontainers DB without DATABASE_URL/getDb().
 */
export function createMcpServer(dbOverride?: Db): McpServer {
  const db = dbOverride ?? (getDb() as unknown as Db)

  const server = new McpServer(
    { name: 'tokenscope', version: '1.0.0' },
    { capabilities: { tools: {}, prompts: {} } },
  )

  /** Run a query body inside the caller's RLS context, with scope + error guards. */
  async function withTeammate(
    authInfo: AuthInfo | undefined,
    toolName: string,
    body: (tx: Db, teammate: BearerTeammate) => Promise<ToolText>,
  ): Promise<ToolText> {
    const teammate = getTeammate(authInfo)
    if (!teammate) {
      return {
        content: [{ type: 'text' as const, text: 'Not authenticated.' }],
        isError: true,
      }
    }
    if (!hasScope(teammate, MCP_READ_SCOPE)) return scopeError(MCP_READ_SCOPE)
    try {
      const ctx = await rlsContextFor(db, teammate)
      return await withRlsContext(db, ctx, async (tx) => body(tx as unknown as Db, teammate))
    } catch (err) {
      logger.error(`${toolName} failed`, {
        teammateId: teammate.teammateId,
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        content: [
          { type: 'text' as const, text: `${toolName} failed. Check server logs for details.` },
        ],
        isError: true,
      }
    }
  }

  // ── list_my_projects ───────────────────────────────────────────────────
  server.tool(
    'list_my_projects',
    'List the TokenScope BUDGETS you can attribute spend to (your current memberships) — projects of any type (billable / pursuit / internal). Returns each budget id, code, and display name; use the id with tag_session.',
    {},
    async (_args, extra) =>
      withTeammate(extra.authInfo, 'list_my_projects', async (tx, teammate) => {
        const projects = await getMyProjects(tx, teammate.teammateId)
        return jsonResult({ projects })
      }),
  )

  // ── list_activity_types ────────────────────────────────────────────────
  server.tool(
    'list_activity_types',
    'List the activity tags you can apply when tagging a session (the hybrid activity vocabulary for your region). Your own previously-used tags come first, then standard suggestions. This is a suggestion list, not a strict allow-list — the value stored on an assignment is free-form.',
    {},
    async (_args, extra) =>
      withTeammate(extra.authInfo, 'list_activity_types', async (tx, teammate) => {
        const activity_types = await getActivityTypes(tx, teammate.regionId, teammate.teammateId)
        return jsonResult({ activity_types })
      }),
  )

  // ── my_usage ───────────────────────────────────────────────────────────
  server.tool(
    'my_usage',
    'Show your current-month-to-date TokenScope usage: per-budget spend (USD), tokens, allocation/budget, and an additive-quota summary (base allowance + budget allocations). Same data as the /me/usage dashboard card.',
    {},
    async (_args, extra) =>
      withTeammate(extra.authInfo, 'my_usage', async (tx, teammate) => {
        const usage = await getMyUsage(tx, teammate.teammateId)
        return jsonResult(usage)
      }),
  )

  // ── tag_session (WRITE — requires tokenscope.tag) ──────────────────────────
  server.tool(
    'tag_session',
    'Tag (categorise) one of YOUR Claude conversations: assign it to a BUDGET (a project of any type — billable / pursuit / internal) and/or set an ACTIVITY label. project_id null = move OFF budget (unallocated); activity null = clear it; omit a field to leave it unchanged. This is TAGGING (categorisation), NOT budget allocation (which is admin-only). Get budget ids from list_my_projects and activity suggestions from list_activity_types. Requires the tokenscope.tag scope.',
    {
      session_id: z
        .string()
        .min(1)
        .max(256)
        .describe("The conversation id (Claude's session.id), as shown by my_usage / the dashboard."),
      project_id: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe('Budget (project) id to assign to; null = move off budget; omit = leave unchanged. Must be a budget you are a member of.'),
      activity: z
        .union([z.string().trim().min(1).max(64), z.null()])
        .optional()
        .describe('Activity label to set; null = clear; omit = leave unchanged.'),
    },
    async (args, extra) => {
      const teammate = getTeammate(extra.authInfo)
      if (!teammate) {
        return { content: [{ type: 'text' as const, text: 'Not authenticated.' }], isError: true }
      }
      if (!hasScope(teammate, MCP_TAG_SCOPE)) return scopeError(MCP_TAG_SCOPE)
      if (args.project_id === undefined && args.activity === undefined) {
        return {
          content: [{ type: 'text' as const, text: 'Provide project_id and/or activity (null to clear).' }],
          isError: true,
        }
      }
      try {
        // Plain transaction with explicit teammate filters (NOT the read tools'
        // RLS context) — identical semantics to the web POST /assign path.
        const result = await db.transaction((tx) =>
          tagSessionTx(
            tx as unknown as Db,
            teammate.teammateId,
            args.session_id,
            {
              setProject: args.project_id !== undefined,
              projectVal: args.project_id ?? null,
              setActivity: args.activity !== undefined,
              activityVal: args.activity ?? null,
            },
            { actorSystem: 'mcp-tag-session' },
          ),
        )
        return jsonResult(result)
      } catch (err) {
        const e = err as { statusCode?: number; statusMessage?: string; data?: { detail?: string } }
        // Map the shared logic's createError (403 ownership/membership, 404, 409
        // ended-budget) to a clean tool error; never leak internals.
        if (e?.statusCode) {
          return {
            content: [{ type: 'text' as const, text: e.data?.detail ?? e.statusMessage ?? 'Tag failed.' }],
            isError: true,
          }
        }
        logger.error('tag_session failed', {
          teammateId: teammate.teammateId,
          error: err instanceof Error ? err.message : String(err),
          cause: (err as { cause?: { message?: string } })?.cause?.message,
        })
        return {
          content: [{ type: 'text' as const, text: 'tag_session failed. Check server logs for details.' }],
          isError: true,
        }
      }
    },
  )

  // ── resolve_repo_project (READ — requires tokenscope.read) ─────────────────
  server.tool(
    'resolve_repo_project',
    "Resolve a repo's .tokenscope reference — a project CODE or its CODE_HASH (never a filesystem path; the server does not persist repo paths or cwd) — to a TokenScope BUDGET you are a member of. Returns the budget's id, code, display_name, and type when it maps to one of your memberships, or resolved:false when it doesn't (unknown code OR a real project you're not assigned to — both collapse to 'not yours', no existence oracle). Used by the project / tag skills to confirm a repo's .tokenscope code is a real, attributable budget before acting on it.",
    {
      code: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .optional()
        .describe("The project code (the slug stored in a repo's .tokenscope file)."),
      code_hash: z
        .string()
        .trim()
        .regex(/^[0-9a-f]{64}$/i, 'code_hash must be a 64-char hex sha256')
        .optional()
        .describe('The project code_hash (sha256 hex), if you have it instead of the code.'),
    },
    async (args, extra) =>
      withTeammate(extra.authInfo, 'resolve_repo_project', async (tx, teammate) => {
        if (!args.code && !args.code_hash) {
          return {
            content: [
              { type: 'text' as const, text: 'Provide a project code or code_hash to resolve.' },
            ],
            isError: true,
          }
        }
        const project = await resolveRepoProject(tx, teammate.teammateId, {
          code: args.code,
          codeHash: args.code_hash,
        })
        if (!project) {
          // No existence oracle: unknown code and not-a-member both return the
          // same negative shape, so a non-member can't probe which codes exist.
          return jsonResult({
            resolved: false,
            note: "No budget you're a member of matches that code — pick from list_my_projects.",
          })
        }
        return jsonResult({ resolved: true, project })
      }),
  )

  // ── provision_emit (READ-scoped — the ONE sanctioned read→emit crossing) ───
  // ADR-0005 E1: a read-scoped token minting emit-provisioning material is the
  // single audited crossing of the read/emit wall (device setup, not data
  // access). An EMIT-only bearer is REJECTED here (withTeammate gates on
  // tokenscope.read) — a leaked emit credential therefore cannot bootstrap
  // another emit credential. CRUCIALLY this tool returns ONLY a short-TTL one-time
  // handoff code + redeem URL — NEVER the durable emit refresh token, so the
  // broadly-readable secret never enters the LLM's context (handoff is redeemed
  // process→process by the local helper).
  server.tool(
    'provision_emit',
    "Provision THIS device to emit TokenScope telemetry (turn on token attribution). One read-scoped call locates-or-creates your device's instance attestation and returns a SHORT-LIVED (~5 min), single-use handoff code plus a redeem URL — it does NOT return the durable emit credential (that secret is redeemed process-to-process by the local emit-redeem helper, never through this chat). Pass your existing tokenscope.instance_id (read from ~/.claude/settings.json's OTEL_RESOURCE_ATTRIBUTES) so re-running rotates the existing device instead of minting a new one; omit it for a fresh device. After calling, run the local redeem helper with the returned handoff_code to finish setup.",
    {
      instance_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Your existing device id (tokenscope.instance_id from ~/.claude/settings.json), for idempotency; omit for a fresh device.",
        ),
      tool: z
        .enum(['claude-code', 'copilot-cli'] satisfies [EmitTool, EmitTool])
        .default('claude-code')
        .describe(
          "The emit tool: 'claude-code' (default) or 'copilot-cli'. Determines the OTel bundle shape returned by the redeem endpoint.",
        ),
    },
    async (args, extra) =>
      withTeammate(extra.authInfo, 'provision_emit', async (_tx, teammate) => {
        // Writes run against the un-RLS-wrapped db handle (like tag_session) — a
        // self-scoped device provision, not a region-filtered read.
        const tm = await loadProvisioningTeammate(db, teammate.teammateId)
        if (!tm) {
          return {
            content: [{ type: 'text' as const, text: 'Your teammate record was not found.' }],
            isError: true,
          }
        }
        const emitTool: EmitTool = args.tool ?? 'claude-code'
        // Locate-or-create the attestation (idempotent per instance), then rotate
        // out any still-redeemable handoff for it and mint a fresh one — in ONE
        // transaction serialized per instance via pg_advisory_xact_lock (AUTH-2,
        // the exact pattern of issueInstanceEmitCredentialTx). Without the lock,
        // two concurrent provisions interleave revoke→mint and leave TWO
        // redeemable codes; without the transaction, an audit failure after the
        // mint orphans a redeemable code never shown to the caller.
        const { instanceId, reused } = await locateOrCreateInstance(db, tm, args.instance_id, emitTool)
        const handoff = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${instanceId}))`)
          await revokePriorHandoffsForInstance(tx as unknown as Db, instanceId)
          const minted = await mintEmitHandoff(tx as unknown as Db, teammate.teammateId, instanceId)
          // Audit the crossing (ADR-0005 E1 — read→emit provisioning). No secret
          // in the payload (only the instance id + whether it was reused). A
          // throwing recordAuditEvent rolls the fresh handoff back (correct: no
          // unaudited redeemable code may exist).
          await recordAuditEvent(tx as never, {
            eventType: 'emit-handoff-minted',
            actorTeammateId: teammate.teammateId,
            actorSystem: 'mcp-provision-emit',
            subjectKind: 'instance',
            subjectId: instanceId,
            payload: { instance_reused: reused, tool: emitTool },
          })
          return minted
        })

        // Server-relative redeem path — the local helper composes it against its
        // own configured API base (the same base it reaches the MCP server on), so
        // there is no Front-Door host to bake/break here (cf. getPublicRequestURL).
        const redeemUrl = '/api/v1/setup/redeem'

        // The local redeem helper is tool-specific. Name a command the agent can
        // run AS-IS in an ad-hoc shell, so the durable emit credential is redeemed
        // process→server by the helper and written to disk directly (never the
        // chat). Traps this must avoid (all caught in review):
        //   - $CLAUDE_PLUGIN_ROOT is NOT set in an ordinary Bash tool call (only in
        //     plugin hook/command execution), so we cannot bake it. Claude's plugin
        //     lives under a versioned cache dir, so we locate it by glob and pick
        //     the highest installed version (sort -V). Copilot installs to a fixed
        //     versionless path, where a missing file makes `node` error loudly.
        //   - the handoff code is base64url and can begin with '-', so it is passed
        //     via --handoff-code (a bare positional would be mis-parsed as a flag),
        //     and as an sh positional ($1) so it is never re-split or re-globbed.
        //   - the Claude locator runs inside `sh -c` (deterministic glob semantics
        //     regardless of the agent's interactive shell) and FAILS LOUDLY if the
        //     script isn't found — otherwise an empty glob would make `node ""`
        //     exit 0 with no output, falsely reporting success while burning the
        //     one-time handoff.
        const redeemCommand =
          emitTool === 'copilot-cli'
            ? `node "$HOME/.copilot/plugins/tokenscope/scripts/copilot-redeem.mjs" --handoff-code "${handoff.code}"`
            : `sh -c 's=$(ls -d "$HOME"/.claude/plugins/cache/*/tokenscope/*/scripts/claude-redeem.mjs 2>/dev/null | sort -V | tail -n1); ` +
              `[ -n "$s" ] || { echo "tokenscope: claude-redeem.mjs not found under ~/.claude/plugins/cache - install/enable the tokenscope plugin, then retry." >&2; exit 1; }; ` +
              `exec node "$s" --handoff-code "$1"' tokenscope-redeem "${handoff.code}"`
        return jsonResult({
          instance_id: instanceId,
          handoff_code: handoff.code,
          redeem_url: redeemUrl,
          expires_in: Math.floor(EMIT_HANDOFF_TTL_MS / 1000),
          tool: emitTool,
          redeem_command: redeemCommand,
          note: `Run the local emit-redeem helper to finish provisioning — execute redeem_command in a shell (process→server, NOT through this chat). It redeems the handoff and writes the credential to disk itself. The durable emit credential is NOT returned here and must never be requested through this chat.`,
        })
      }),
  )

  // ── MCP Prompts (Skills) ───────────────────────────────────────────────────
  // Skill constants live at module scope (below createMcpServer, see EOF), with
  // their source-of-truth in docs/skills/tokenscope/{name}.md — keep in sync.
  // Each prompt returns static workflow instructions telling the agent which
  // TokenScope MCP tools to call, in what order, and how to present results.
  // Prompts are read-only — they touch no user data and need only tokenscope.read
  // (the connection's OAuth grant); there's no per-tool scope gate to enforce
  // here because a prompt is just text. Registered with BARE names: in Claude
  // Code they surface as /mcp__tokenscope__{name}; a 'tokenscope-' prefix would
  // double the namespace (the server is already named 'tokenscope').

  /**
   * Build a single-message prompt result from skill text + an OPTIONAL user arg.
   * The arg is APPENDED after the instructions (never interpolated into them) so
   * a hostile argument can't rewrite the skill — prompt-injection-safe, mirroring
   * a sibling project. Args are length-bounded by their zod argsSchema below.
   */
  function makePromptMessages(skillText: string, argLabel?: string, argValue?: string) {
    const text = argLabel && argValue ? `${skillText}\n\n${argLabel}: ${argValue}` : skillText
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] }
  }

  server.registerPrompt(
    'tokenscope-setup',
    {
      description:
        'Connect Claude Code to TokenScope and provision emitting (one OAuth consent authenticates + provisions; the durable secret is redeemed locally, never via chat)',
    },
    async () => makePromptMessages(SKILL_SETUP),
  )

  server.registerPrompt(
    'tag',
    {
      description:
        'Tag one of your Claude sessions to a budget and/or activity (lists your budgets + activity suggestions, then tag_session)',
      argsSchema: {
        session_id: z
          .string()
          .max(500)
          .optional()
          .describe("The conversation id to tag (Claude's session.id); omit to be asked."),
      },
    },
    async (args) => makePromptMessages(SKILL_TAG, 'Session id provided', args.session_id),
  )

  server.registerPrompt(
    'project',
    {
      description:
        "Bind the current repo to a budget by writing a committed .tokenscope file (pick from your memberships — no need to know the exact slug)",
      argsSchema: {
        project: z
          .string()
          .max(500)
          .optional()
          .describe('A project code or search text to pre-match; omit to pick from a list.'),
      },
    },
    async (args) => makePromptMessages(SKILL_PROJECT, 'Project hint provided', args.project),
  )

  server.registerPrompt(
    'usage',
    {
      description: 'Show your month-to-date usage split per budget, plus unallocated and tagged spend',
    },
    async () => makePromptMessages(SKILL_USAGE),
  )

  return server
}

// MCP prompt (skill) text: see SKILL_* imports above (generated from
// docs/skills/tokenscope/*.md via scripts/sync-skill-prompts.mjs).
