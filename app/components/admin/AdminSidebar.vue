<script setup lang="ts">
/*
 * AdminSidebar — the persistent admin navigation. Task-oriented groups from
 * shared/nav/admin-nav; role-filtered + active-marked by useAdminNav.
 *
 * a11y: a single <nav aria-label="Admin"><ul> per group with native links, so
 * tab order and screen-reader semantics come for free. The active item carries
 * aria-current="page". Locked items render as aria-disabled spans (not links)
 * with a visible lock + text hint — never colour/opacity alone.
 *
 * Used both as the persistent desktop rail and inside the mobile drawer; the
 * `onNavigate` emit lets the drawer close on selection.
 */
import { computed } from 'vue'
import { useAdminNav } from '../../composables/useAdminNav'

defineEmits<{ navigate: [] }>()
const { groups } = useAdminNav()

// "Roles & terms" is a pinned link outside the grouped IA; mark it active on
// its own route.
const route = useRoute()
const isHelpActive = computed(() => route.path === '/admin/help')

// One source for the nav-link styling so the pinned link can't drift from the
// grouped items.
const LINK_BASE =
  'flex items-center gap-2.5 px-3 py-2 rounded-lg text-carbon-2 no-underline transition-colors hover:bg-calm-1 hover:text-carbon focus-visible:outline-2 focus-visible:outline-brand-harmony focus-visible:outline-offset-1'
const LINK_ACTIVE =
  'bg-brand-harmony/10 text-brand-harmony font-semibold hover:bg-brand-harmony/10 hover:text-brand-harmony'
function linkClass(active: boolean) {
  return [LINK_BASE, active ? LINK_ACTIVE : '']
}
</script>

<template>
  <nav aria-label="Admin" class="text-sm" data-testid="admin-sidebar">
    <div v-for="(group, gi) in groups" :key="gi" class="mb-5 last:mb-0">
      <p
        v-if="group.label"
        class="px-3 mb-1 text-[10.5px] font-bold uppercase tracking-[1.2px] text-carbon-3"
      >
        {{ group.label }}
      </p>
      <ul class="list-none m-0 p-0 flex flex-col gap-0.5">
        <li v-for="item in group.items" :key="item.to">
          <NuxtLink
            v-if="!item.locked"
            :to="item.to"
            :aria-current="item.active ? 'page' : undefined"
            :data-testid="`admin-nav-${item.testid}`"
            :class="linkClass(item.active)"
            @click="$emit('navigate')"
          >
            <AdminNavIcon :name="item.icon" />
            <span>{{ item.label }}</span>
          </NuxtLink>
          <span
            v-else
            aria-disabled="true"
            :title="item.lockHint ?? undefined"
            :data-testid="`admin-nav-${item.testid}-locked`"
            class="flex items-center gap-2.5 px-3 py-2 rounded-lg text-carbon-3/70 cursor-not-allowed"
          >
            <AdminNavIcon :name="item.icon" />
            <span>{{ item.label }}</span>
            <AdminNavIcon name="shield" class="ml-auto opacity-60" />
            <span class="sr-only">{{ item.lockHint }}</span>
          </span>
        </li>
      </ul>
    </div>

    <div class="mt-6 pt-4 border-t border-calm-2">
      <NuxtLink
        to="/admin/help"
        :aria-current="isHelpActive ? 'page' : undefined"
        data-testid="admin-nav-help"
        :class="linkClass(isHelpActive)"
        @click="$emit('navigate')"
      >
        <AdminNavIcon name="help" />
        <span>Roles &amp; terms</span>
      </NuxtLink>
    </div>
  </nav>
</template>
