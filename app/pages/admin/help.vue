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
import { nextTick, onMounted, ref, watch } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { roleDisplay } = useAdminAccess()

// Grouped for scannability. `id` matches the AdminHelpLink `anchor` prop: the
// ids are an interface (the "?" links across admin point at them) and stay.
const roles = [
  { id: 'platform-admin', term: 'Admin', body: 'The one admin role. Administers every region: passes every check, and sees every region\'s data.' },
  { id: 'manager-role', term: 'Manager (role)', body: 'The role for a team or practice lead. Distinct from a project manager assignment and from the Entra manager chain (below).' },
  { id: 'developer', term: 'Developer', body: 'The default role. May also own a Business Unit: that is a relationship, not a role (see Business Unit owner).' },
]

/*
 * #636: the three retired roles sit in a closed fold at the end of Roles, one
 * sentence each. A link to one of their anchors opens the fold and scrolls to
 * the entry, so no "?" link lands on nothing.
 */
const retiredRoles = [
  { id: 'region-admin', term: 'Region admin', body: 'No longer given. People who still hold it administer one region.' },
  { id: 'global-finance', term: 'Global finance', body: 'Retired on 5 Sep 2026. Company-wide report access is now given per person under Report access.' },
  { id: 'finance-retired', term: 'Finance', body: 'Never assigned. You may still see the value in old audit rows.' },
]
const retiredIds = new Set(retiredRoles.map((r) => r.id))
const retiredOpen = ref(false)
const route = useRoute()
async function openForHash(hash: string | undefined) {
  const id = (hash ?? '').replace(/^#/, '')
  if (!retiredIds.has(id)) return
  retiredOpen.value = true
  await nextTick()
  document.getElementById(id)?.scrollIntoView({ block: 'start' })
}
onMounted(() => openForHash(route.hash))
watch(() => route.hash, (h) => openForHash(h))

const ownership = [
  { id: 'cost-centre-owner', term: 'Business Unit owner', body: 'A person who can SEE a Business Unit’s spend and budget (the P&L view). Assigned per Business Unit on a region’s page ("Owners"). It is a relationship, not a role — a plain Developer can be a Business Unit owner. It does not change what they can administer.' },
  { id: 'region-leader', term: 'Region leader', body: 'A placement ANCHOR for a region (e.g. a Region SVP or a shared-function head). Region leaders are used to DERIVE which Business Unit an otherwise-unplaced teammate rolls up to — via the Entra manager chain. They are not a role and confer no admin rights. Managed per region ("Region leaders").' },
  { id: 'project-manager', term: 'Project manager (PM)', body: 'A per-project assignment (the "PM" badge on a project’s members) — may manage that project’s budget and membership. Distinct from the Manager role and the manager chain, and from the Project managers list (below).' },
  { id: 'project-managers-list', term: 'Project managers list', body: 'An org-wide list kept by an Admin (Admin → Project managers). People on it create projects in any region without sending a request, unless a detection-threshold setting limits them to their own region. Being on the list is not a role and does not make someone the PM of any project.' },
  { id: 'manager-chain', term: 'Manager chain', body: 'The Entra "manager of manager of…" walk. Used only to derive placement (which Business Unit a teammate belongs to) when it is not set directly. It is directory data, not a TokenScope role or assignment.' },
]

const structure = [
  { id: 'org-unit', term: 'Org unit', body: 'Any node in a region’s organisation tree.' },
  { id: 'cost-owning-unit', term: 'Business Unit', body: 'An org unit marked as a P&L node — the thing spend actually bills to. Projects bill to the NEAREST Business Unit above them. Marked "Business Unit" on the tree. It is not a finance code: a Business Unit can optionally carry its directory cost-centre code as a tag.' },
  { id: 'unit-levels', term: 'Unit types (bu / practice / team)', body: 'Each org unit has a type that names its level, from broad (bu) to narrow (team). The type is only a label: what makes a unit carry spend is being marked as a Business Unit, and a practice can be one too. Units that are not roll up to the nearest Business Unit above them.' },
  { id: 'unassigned', term: 'Unassigned vs Unplaced', body: '"Unassigned (global)" is the org-wide fallback for spend with no home. "Unplaced (per-region)" is a region’s holding area for teammates not yet placed in its tree. They are different scopes.' },
]

const emission = [
  { id: 'device', term: 'Device (instance)', body: 'A device/enrolment that emits usage — the "Devices" page. In the data model this is an INSTANCE (the unspoofable teammate binding); "device" is the friendly name. Effectively per-host.' },
  { id: 'connection', term: 'Connection (grant)', body: 'An authorised client connection for a teammate — the "Connections" page. Revoking one logs that client out (and stops its emission if it is an emit grant).' },
  { id: 'session', term: 'Session', body: 'One Claude Code run. The user-facing unit for "Recent sessions" and retroactive project assignment.' },
]
</script>

<template>
  <div class="max-w-[1000px] mx-auto px-10 py-8 pb-20" data-testid="admin-help" data-admin-page="/admin/help">
    <UiPageHead
      eyebrow="Reference"
      title="Roles & terms"
      :sub="`One page for the words the admin area reuses. Your role: ${roleDisplay}.`"
    />

    <p class="text-sm text-carbon-2 mb-8 leading-relaxed">
      Several admin terms look alike but mean different things: an
      <strong>owner</strong> is not a <strong>leader</strong>, and “manager”
      has three senses. This is the canonical reference; the “?” links across
      the admin area point here.
    </p>

    <section aria-labelledby="h-roles" class="mb-10">
      <h2 id="h-roles" class="text-lg font-bold text-carbon mb-1">Roles</h2>
      <p class="text-sm text-carbon-3 mb-4">Who can administer what. One role per teammate.</p>
      <dl class="grid gap-3">
        <div v-for="r in roles" :id="r.id" :key="r.id" class="p-4 rounded-lg border border-calm-2 scroll-mt-24" :data-testid="`term-${r.id}`">
          <dt class="text-sm font-bold text-carbon mb-1">{{ r.term }}</dt>
          <dd class="text-sm text-carbon-2 leading-relaxed m-0">{{ r.body }}</dd>
        </div>
      </dl>
      <details
        class="mt-3 rounded-lg border border-calm-2 group"
        :open="retiredOpen"
        data-testid="retired-roles"
        @toggle="retiredOpen = ($event.target as HTMLDetailsElement).open"
      >
        <summary class="cursor-pointer px-4 py-3 text-sm font-bold text-carbon-2 hover:text-brand-harmony">
          Retired roles ({{ retiredRoles.length }})
        </summary>
        <dl class="grid gap-2 px-4 pb-4">
          <div v-for="r in retiredRoles" :id="r.id" :key="r.id" class="scroll-mt-24" :data-testid="`term-${r.id}`">
            <dt class="text-sm font-bold text-carbon">{{ r.term }}</dt>
            <dd class="text-sm text-carbon-2 leading-relaxed m-0">{{ r.body }}</dd>
          </div>
        </dl>
      </details>
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
