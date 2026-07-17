<script setup lang="ts">
/*
 * admin layout — the persistent shell for /admin/**. Adds what the flat default
 * layout lacked: a task-oriented sidebar for lateral movement (no more
 * re-descending from the hub) and linked breadcrumbs for back-navigation.
 *
 * Responsive: the sidebar is a persistent rail at lg+, and collapses to a
 * focus-trapped drawer (hamburger) below lg. a11y: a skip-link jumps past the
 * sidebar to the main content; the drawer reuses the shared modal a11y contract
 * (Esc-to-close, focus-trap, focus-restore).
 */
import { ref, watch } from 'vue'
import { useAdminNav } from '../composables/useAdminNav'
import { useModalA11y } from '../composables/useModalA11y'

const { breadcrumbs, drawerOpen } = useAdminNav()

const drawerEl = ref<HTMLElement | null>(null)
function closeDrawer() {
  drawerOpen.value = false
}
useModalA11y({
  isOpen: () => drawerOpen.value,
  dialogEl: drawerEl,
  onClose: closeDrawer,
})

// Scroll-lock the page behind the drawer so the aria-modal contract holds (the
// background is also made `inert` in the template). Client-only; restored on
// close/unmount. The background inert-ing keeps AT/keyboard out of content
// behind the modal drawer.
watch(drawerOpen, (open) => {
  if (!import.meta.client) return
  document.body.style.overflow = open ? 'hidden' : ''
})
</script>

<template>
  <div class="min-h-screen flex flex-col bg-paper">
    <a
      href="#admin-main"
      class="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-md focus:bg-brand-harmony focus:text-white focus:font-semibold"
    >Skip to content</a>

    <NavAppHeader :inert="drawerOpen || undefined" />

    <div class="flex flex-1 w-full" :inert="drawerOpen || undefined">
      <!-- Persistent desktop rail -->
      <aside
        class="hidden lg:block w-60 shrink-0 border-r border-calm-2 bg-paper"
      >
        <div class="sticky top-0 max-h-screen overflow-y-auto px-3 py-6">
          <AdminSidebar />
        </div>
      </aside>

      <!-- Main column -->
      <div class="flex-1 min-w-0 flex flex-col">
        <!-- Mobile bar: hamburger + breadcrumb -->
        <div
          class="lg:hidden flex items-center gap-3 px-6 py-3 border-b border-calm-2"
        >
          <button
            type="button"
            class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-calm-2 text-sm font-semibold text-carbon-2 hover:text-carbon focus-visible:outline-2 focus-visible:outline-brand-harmony"
            :aria-expanded="drawerOpen"
            aria-controls="admin-drawer"
            data-testid="admin-drawer-open"
            @click="drawerOpen = true"
          >
            <AdminNavIcon name="list" />
            Menu
          </button>
          <UiBreadcrumb :crumbs="breadcrumbs" />
        </div>

        <!-- Desktop breadcrumb bar -->
        <div class="hidden lg:block">
          <div class="max-w-[1600px] mx-auto px-10 pt-6">
            <UiBreadcrumb :crumbs="breadcrumbs" />
          </div>
        </div>

        <main id="admin-main" class="flex-1">
          <slot />
        </main>
      </div>
    </div>

    <!-- Mobile drawer -->
    <Transition name="admin-drawer">
      <div
        v-if="drawerOpen"
        class="lg:hidden fixed inset-0 z-40"
        data-testid="admin-drawer"
      >
        <div
          class="absolute inset-0 bg-carbon/40"
          aria-hidden="true"
          @click="closeDrawer"
        />
        <div
          id="admin-drawer"
          ref="drawerEl"
          role="dialog"
          aria-modal="true"
          aria-label="Admin navigation"
          class="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-paper shadow-xl overflow-y-auto px-3 py-5"
        >
          <div class="flex items-center justify-between px-3 mb-4">
            <span class="text-[10.5px] font-bold uppercase tracking-[1.2px] text-carbon-3">Admin menu</span>
            <button
              type="button"
              class="p-1.5 rounded-md text-carbon-2 hover:text-carbon hover:bg-calm-1 focus-visible:outline-2 focus-visible:outline-brand-harmony"
              aria-label="Close admin menu"
              data-testid="admin-drawer-close"
              @click="closeDrawer"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
          <AdminSidebar @navigate="closeDrawer" />
        </div>
      </div>
    </Transition>

    <NavAppFooter :inert="drawerOpen || undefined" />
  </div>
</template>

<style scoped>
.admin-drawer-enter-active,
.admin-drawer-leave-active {
  transition: opacity 0.18s ease;
}
.admin-drawer-enter-from,
.admin-drawer-leave-to {
  opacity: 0;
}
</style>
