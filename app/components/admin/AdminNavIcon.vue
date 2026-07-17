<script setup lang="ts">
/*
 * AdminNavIcon — decorative inline glyphs for the admin sidebar. Purely
 * presentational (aria-hidden); the adjacent text label always carries the
 * meaning, so no icon-only affordance exists. 16px stroke icons.
 */
defineProps<{ name: string }>()

// Minimal stroke-path set keyed by AdminNavItem.icon. Unknown keys fall back
// to a neutral dot so a new item never renders blank.
const PATHS: Record<string, string> = {
  home: 'M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  people: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a4 4 0 0 1 0 7.8',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5',
  device: 'M5 3h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1M9 21h6M12 17v4',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  tree: 'M12 3v6M6 21v-4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4M4 21h4M10 21h4M16 21h4M10 9h4',
  tag: 'M20 12 12 20l-8-8V4h8zM8.5 8.5h.01',
  scale: 'M12 3v18M7 8l-4 6a4 4 0 0 0 8 0zM17 8l-4 6a4 4 0 0 0 8 0zM5 6h14',
  price: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8M7.5 7.5h.01',
  sliders: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4M14 4v4M6 10v4M12 16v4',
  pulse: 'M3 12h4l2 6 4-14 2 8h6',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  providers: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3H4zM4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M8 5h.01',
  system: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  shield: 'M12 3l8 3v6c0 5-3.4 7.7-8 9-4.6-1.3-8-4-8-9V6z',
}
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0"
  >
    <path :d="PATHS[name] ?? 'M12 12h.01'" />
  </svg>
</template>
