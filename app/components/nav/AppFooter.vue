<script setup lang="ts">
// Project slogan — italic small-caps per docs/build/mvp-lite-epic.md §Deliverables.
const slogan = 'Trust the developer. Track every token. Let the budget do the teaching.'
const year = new Date().getFullYear()
</script>

<template>
  <footer class="mt-auto bg-paper border-t border-calm-2">
    <div
      class="max-w-[1600px] mx-auto px-10 py-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
    >
      <p
        data-testid="footer-slogan"
        class="font-slab italic text-[13px] text-carbon-2"
        style="font-variant-caps: all-small-caps; letter-spacing: 0.6px"
      >
        {{ slogan }}
      </p>
      <div class="text-[11px] text-carbon-3 flex items-center gap-3">
        <span>&copy; {{ year }} TokenScope</span>
      </div>
    </div>
  </footer>
</template>
