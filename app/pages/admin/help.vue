<script setup lang="ts">
/*
 * Admin → Roles & terms — the who's-who glossary. The admin area uses several
 * near-identical words (owner, leader, manager) for genuinely different things;
 * this page is the single plain-language reference. Inline "?" help-links
 * across the admin area deep-link into these anchors.
 *
 * Content is sourced from AGENTS.md §Domain model + docs/design/admin-ia.md —
 * keep them in sync.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

const { roleDisplay } = useAdminAccess()

// Grouped for scannability. `id` matches the AdminHelpLink `anchor` prop.
const roles = [
  { id: 'region-admin', term: 'Region admin', enum: 'admin', body: 'Administers ONE region — its teammates, Business Units, projects and connectors. Region-scoped: cannot see or change other regions.' },
  { id: 'global-finance', term: 'Global finance', enum: 'global-finops', body: 'Cross-region finance super-role — sees every region and the finance rollups. This is the role behind the "Finance" persona.' },
  { id: 'platform-admin', term: 'Platform admin', enum: 'platform-admin', body: 'Cross-region super-admin. Satisfies every gate; unbounded data scope. Can rename regions and manage devices across regions.' },
  { id: 'manager-role', term: 'Manager (role)', enum: 'manager', body: 'The RBAC role for a team/practice lead. Distinct from a project manager assignment and from the Entra manager chain (below).' },
  { id: 'developer', term: 'Developer', enum: 'developer', body: 'The default role. May also hold Business Unit ownership — that is a relationship, not a role (see Business Unit owner).' },
  { id: 'finance-retired', term: 'Finance (retired)', enum: 'finance', body: 'A RETIRED role that is never assigned to anyone. It is kept in the enum only so historical data still parses. You may still see the raw value "finance" in old logs, audit rows or API payloads — it is NOT the same as Global finance. It is never offered when assigning a role.' },
]

const ownership = [
  { id: 'cost-centre-owner', term: 'Business Unit owner', body: 'A person who can SEE a cost-owning unit’s spend and budget (the P&L view). Assigned per Business Unit on a region’s page ("Owners"). It is a relationship, not a role — a plain Developer can be a Business Unit owner. It does not change what they can administer.' },
  { id: 'region-leader', term: 'Region leader', body: 'A placement ANCHOR for a region (e.g. a Region SVP or a shared-function head). Region leaders are used to DERIVE which Business Unit an otherwise-unplaced teammate rolls up to — via the Entra manager chain. They are not a role and confer no admin rights. Managed per region ("Region leaders").' },
  { id: 'project-manager', term: 'Project manager (PM)', body: 'A per-project assignment (the "PM" badge on a project’s members) — may manage that project’s budget and membership. Distinct from the Manager role and the manager chain.' },
  { id: 'manager-chain', term: 'Manager chain', body: 'The Entra "manager of manager of…" walk. Used only to derive placement (which Business Unit a teammate belongs to) when it is not set directly. It is directory data, not a TokenScope role or assignment.' },
]

const structure = [
  { id: 'org-unit', term: 'Org unit', body: 'Any node in a region’s organisation tree.' },
  { id: 'cost-owning-unit', term: 'Cost-owning unit (CoU)', body: 'An org unit flagged as a P&L node — the thing spend actually bills to. Projects bill to the NEAREST cost-owning unit above them. Marked "Cost-owning" on the tree.' },
  { id: 'unit-levels', term: 'Business unit / Practice / Team', body: 'Friendly names for the levels of the org tree, from broad (business unit) to narrow (team).' },
  { id: 'unassigned', term: 'Unassigned vs Unplaced', body: '"Unassigned (global)" is the org-wide fallback for spend with no home. "Unplaced (per-region)" is a region’s holding area for teammates not yet placed in its tree. They are different scopes.' },
]

const emission = [
  { id: 'device', term: 'Device (instance)', body: 'A device/enrolment that emits usage — the "Devices" page. In the data model this is an INSTANCE (the unspoofable teammate binding); "device" is the friendly name. Effectively per-host.' },
  { id: 'connection', term: 'Connection (grant)', body: 'An authorised client connection for a teammate — the "Connections" page. Revoking one logs that client out (and stops its emission if it is an emit grant).' },
  { id: 'session', term: 'Session', body: 'One Claude Code run = one conversation. The user-facing unit for "Recent sessions" and retroactive project assignment.' },
]
</script>

<template>
  <div class="max-w-[1000px] mx-auto px-10 py-8 pb-20" data-testid="admin-help" data-admin-page="/admin/help">
    <UiPageHead
      eyebrow="Reference"
      title="Roles & terms"
      :sub="`One page for the words the admin area reuses. You're signed in as a ${roleDisplay}.`"
    />

    <p class="text-sm text-carbon-2 mb-8 leading-relaxed">
      Several admin terms look alike but mean different things — an
      <strong>owner</strong> is not a <strong>leader</strong>, and “manager”
      has three senses. This is the canonical reference; the “?” links across
      the admin area point here.
    </p>

    <section aria-labelledby="h-roles" class="mb-10">
      <h2 id="h-roles" class="text-lg font-bold text-carbon mb-1">Roles</h2>
      <p class="text-sm text-carbon-3 mb-4">Who can administer what. One role per teammate.</p>
      <dl class="grid gap-3">
        <div v-for="r in roles" :id="r.id" :key="r.id" class="p-4 rounded-lg border border-calm-2 scroll-mt-24" :data-testid="`term-${r.id}`">
          <dt class="flex items-center gap-2 mb-1">
            <span class="text-sm font-bold text-carbon">{{ r.term }}</span>
            <code class="text-[10px] px-1.5 py-0.5 rounded bg-calm-1 text-carbon-3">{{ r.enum }}</code>
          </dt>
          <dd class="text-sm text-carbon-2 leading-relaxed m-0">{{ r.body }}</dd>
        </div>
      </dl>
    </section>

    <section aria-labelledby="h-ownership" class="mb-10">
      <h2 id="h-ownership" class="text-lg font-bold text-carbon mb-1">Ownership, leadership & the “manager” senses</h2>
      <p class="text-sm text-carbon-3 mb-4">These are relationships and assignments — NOT roles. This is the cluster people most often confuse.</p>
      <dl class="grid gap-3">
        <div v-for="o in ownership" :id="o.id" :key="o.id" class="p-4 rounded-lg border border-calm-2 scroll-mt-24" :data-testid="`term-${o.id}`">
          <dt class="text-sm font-bold text-carbon mb-1">{{ o.term }}</dt>
          <dd class="text-sm text-carbon-2 leading-relaxed m-0">{{ o.body }}</dd>
        </div>
      </dl>
    </section>

    <section aria-labelledby="h-structure" class="mb-10">
      <h2 id="h-structure" class="text-lg font-bold text-carbon mb-1">Org structure</h2>
      <p class="text-sm text-carbon-3 mb-4">How a region is shaped and where spend bills.</p>
      <dl class="grid gap-3">
        <div v-for="s in structure" :id="s.id" :key="s.id" class="p-4 rounded-lg border border-calm-2 scroll-mt-24" :data-testid="`term-${s.id}`">
          <dt class="text-sm font-bold text-carbon mb-1">{{ s.term }}</dt>
          <dd class="text-sm text-carbon-2 leading-relaxed m-0">{{ s.body }}</dd>
        </div>
      </dl>
    </section>

    <section aria-labelledby="h-emission" class="mb-4">
      <h2 id="h-emission" class="text-lg font-bold text-carbon mb-1">Emission &amp; the friendly names</h2>
      <p class="text-sm text-carbon-3 mb-4">The UI uses plain words for two data-model terms.</p>
      <dl class="grid gap-3">
        <div v-for="e in emission" :id="e.id" :key="e.id" class="p-4 rounded-lg border border-calm-2 scroll-mt-24" :data-testid="`term-${e.id}`">
          <dt class="text-sm font-bold text-carbon mb-1">{{ e.term }}</dt>
          <dd class="text-sm text-carbon-2 leading-relaxed m-0">{{ e.body }}</dd>
        </div>
      </dl>
    </section>
  </div>
</template>
