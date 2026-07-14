<script setup lang="ts">
/*
 * UiCodeBlock — a selectable, one-click-copy command block.
 *
 * For shell / CLI commands so dogfooders copy the exact text in one click
 * instead of hand-selecting wrapped inline <code> (where line ends are
 * unclear). Multi-line commands are preserved verbatim on copy.
 */
import { ref } from 'vue'

const props = defineProps<{ code: string }>()
const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(props.code)
  } catch {
    // Fallback for non-secure contexts / older browsers.
    const ta = document.createElement('textarea')
    ta.value = props.code
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } catch {
      /* clipboard unavailable — the text is still selectable */
    }
    document.body.removeChild(ta)
  }
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 1500)
}
</script>

<template>
  <div class="relative">
    <pre class="overflow-x-auto rounded-md bg-carbon text-white text-[12px] leading-relaxed font-mono px-3 py-2.5 pr-[68px] whitespace-pre-wrap break-words select-all"><code>{{ code }}</code></pre>
    <button
      type="button"
      class="absolute top-1.5 right-1.5 inline-flex items-center text-[11px] font-bold px-2 py-1 rounded border border-white/25 bg-white/10 text-white hover:bg-white/20 transition-colors cursor-pointer no-underline"
      :aria-label="copied ? 'Copied' : 'Copy to clipboard'"
      data-testid="codeblock-copy"
      @click="copy"
    >
      {{ copied ? 'Copied ✓' : 'Copy' }}
    </button>
  </div>
</template>
