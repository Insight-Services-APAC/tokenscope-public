<script setup lang="ts">
/*
 * OrgTree — LTREE depth-indented tree of org units (design-notes
 * §Screen 5 Org units tab).
 *
 * Rows are passed in path-order; depth is `nlevel(path)` from the
 * server. Children are computed by parent_id and indented by depth.
 * Chevron caret toggles collapse per-node. The root node's
 * children render expanded by default; deeper nodes start collapsed.
 *
 * Node identifier surfaces: `data-testid="org-node-{code}"` is used
 * by tests (code is unique-per-region today via region-prefix in
 * the seed); `data-path` is the globally-unique LTREE path for
 * downstream selectors that need cross-region uniqueness.
 */
import { ref, computed } from 'vue'

export interface OrgNode {
  id: string
  parent_id: string | null
  path: string
  depth: number
  code: string
  display_name: string
  unit_type: string
  is_cost_owning_unit: boolean
  teammate_count: number
  project_count: number
  // J4 (mig 0048): active P&L owners of this unit (cost-owning units only).
  //
  // C8b/C8c — each owner carries whether the manager-chain walk can actually USE
  // them, straight from the walk's own condition (server/api/v1/admin/
  // org-units.get.ts):
  //   placement_status 'resolves'  → the walk places reports into this unit;
  //                    'ambiguous' → they own >1 active cost-owning unit, so the
  //                                  walk skips them and they place NOBODY;
  //                    'inert'     → they own none the walk can see (placeholder
  //                                  identity, or a non-cost-owning unit).
  //   places_count     → teammates in this unit whose recorded chain placement
  //                      names this owner. Realised reach, not a projection.
  owners: Array<{
    teammate_id: string
    display_name: string | null
    email: string
    placement_status: 'resolves' | 'ambiguous' | 'inert'
    owns_unit_count: number
    places_count: number
  }>
  // C9 — this is the region's catch-all root (`default`), and how much of what
  // is in it does not belong there. Present on that node only; null elsewhere.
  //   direct_reports     their manager IS an owner of this unit — expected.
  //   not_direct_reports their manager is NOT — they landed here because the
  //                      chain walk found no nearer owner. THE warning.
  //   manager_unknown    never looked up. Not counted as misplaced: that number
  //                      shrinks by running a placement pass, not by placing.
  is_default: boolean
  default_occupancy: {
    occupants: number
    direct_reports: number
    not_direct_reports: number
    manager_unknown: number
    warn: boolean
  } | null
}

const props = defineProps<{
  nodes: OrgNode[]
}>()

// Index children by parent_id for O(1) lookups.
const childrenByParent = computed(() => {
  const map = new Map<string | null, OrgNode[]>()
  for (const n of props.nodes) {
    const arr = map.get(n.parent_id) ?? []
    arr.push(n)
    map.set(n.parent_id, arr)
  }
  return map
})

const roots = computed<OrgNode[]>(() => childrenByParent.value.get(null) ?? [])

// Start with the root expanded; deeper nodes collapsed.
const expanded = ref(new Set<string>())
// Seed: every root expanded.
for (const r of roots.value) expanded.value.add(r.id)
// Force reactivity (Set mutation isn't tracked).
expanded.value = new Set(expanded.value)

function toggle(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
  expanded.value = new Set(expanded.value)
}

interface RenderedRow {
  node: OrgNode
  hasChildren: boolean
  isExpanded: boolean
}

const rendered = computed<RenderedRow[]>(() => {
  const out: RenderedRow[] = []
  function walk(parent: string | null) {
    const kids = childrenByParent.value.get(parent) ?? []
    for (const node of kids) {
      const kidsOfThis = childrenByParent.value.get(node.id) ?? []
      const hasChildren = kidsOfThis.length > 0
      const isExpanded = expanded.value.has(node.id)
      out.push({ node, hasChildren, isExpanded })
      if (hasChildren && isExpanded) walk(node.id)
    }
  }
  walk(null)
  return out
})
</script>

<template>
  <div data-testid="org-tree">
    <div
      v-for="r in rendered"
      :key="r.node.id"
      class="grid grid-cols-[1fr_auto] items-center gap-3 py-2 hover:bg-brand-harmony-sheer/40 rounded-md"
      :style="{ paddingLeft: `${r.node.depth * 20}px` }"
      :data-depth="r.node.depth"
      :data-testid="`org-node-${r.node.code}`"
      :data-path="r.node.path"
    >
      <div class="flex items-center gap-2 min-w-0">
        <button
          v-if="r.hasChildren"
          type="button"
          class="w-5 h-5 inline-flex items-center justify-center text-carbon-3 hover:text-brand-harmony transition-transform"
          :class="r.isExpanded ? 'rotate-90' : ''"
          :aria-label="r.isExpanded ? 'Collapse' : 'Expand'"
          :data-testid="`toggle-${r.node.code}`"
          @click="toggle(r.node.id)"
        >
          ›
        </button>
        <span v-else class="w-5 h-5 inline-block" aria-hidden="true" />
        <span class="text-sm font-bold text-carbon truncate">{{ r.node.display_name }}</span>
        <span class="text-[11px] text-carbon-3">
          {{ r.node.teammate_count }} {{ r.node.teammate_count === 1 ? 'teammate' : 'teammates' }}
          · {{ r.node.project_count }} {{ r.node.project_count === 1 ? 'project' : 'projects' }}
        </span>
      </div>
      <span class="text-[10px] text-carbon-3 font-mono">{{ r.node.code }}</span>
    </div>
  </div>
</template>
