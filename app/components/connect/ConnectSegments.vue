<script setup lang="ts">
/* One connect-guide paragraph: plain text mixed with <code> and <strong>, without v-html. */
import type { Paragraph, Segment } from './connect-guides'

defineProps<{ segs: Paragraph }>()

function isCode(seg: Segment): seg is { code: string } {
  return typeof seg === 'object' && 'code' in seg
}
function isStrong(seg: Segment): seg is { strong: string } {
  return typeof seg === 'object' && 'strong' in seg
}
</script>

<template>
  <template v-for="(seg, i) in segs" :key="i"
    ><code v-if="isCode(seg)" class="text-[11px] bg-calm/40 px-1 rounded">{{ seg.code }}</code
    ><strong v-else-if="isStrong(seg)">{{ seg.strong }}</strong
    ><template v-else>{{ seg }}</template></template
  >
</template>
