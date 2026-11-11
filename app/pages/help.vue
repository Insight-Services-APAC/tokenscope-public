<script setup lang="ts">
/*
 * How TokenScope works (#604): the words and "what happens when", for everyone
 * who is signed in. The text lives in shared/help/using-tokenscope.ts, which the
 * public wiki page mirrors; a test pins that the two agree.
 *
 * Each entry has an anchor, so a link can point at one term. Admin roles and
 * terms stay on /admin/help.
 */
import { HELP_TERMS, HELP_WHAT_HAPPENS } from '#shared/help/using-tokenscope'
</script>

<template>
  <div class="max-w-[1000px] mx-auto px-10 py-8 pb-20" data-testid="help-page">
    <UiPageHead
      eyebrow="Guide"
      title="How TokenScope works"
      sub="What the words mean, and what happens when."
    />

    <section aria-labelledby="h-words" class="mb-10">
      <h2 id="h-words" class="text-lg font-bold text-carbon mb-3">The words</h2>
      <dl class="grid gap-3">
        <div
          v-for="t in HELP_TERMS"
          :id="t.id"
          :key="t.id"
          class="p-4 rounded-lg border border-calm-2 scroll-mt-24"
          :data-testid="`help-term-${t.id}`"
        >
          <dt class="text-sm font-bold text-carbon mb-1">{{ t.term }}</dt>
          <dd class="text-sm text-carbon-2 leading-relaxed m-0">
            <p v-for="(b, i) in t.body" :key="i" :class="i > 0 ? 'mt-2' : ''">{{ b }}</p>
          </dd>
        </div>
      </dl>
    </section>

    <section aria-labelledby="h-what-happens">
      <h2 id="h-what-happens" class="text-lg font-bold text-carbon mb-3">What happens when</h2>
      <dl class="grid gap-3">
        <div
          v-for="t in HELP_WHAT_HAPPENS"
          :id="t.id"
          :key="t.id"
          class="p-4 rounded-lg border border-calm-2 scroll-mt-24"
          :data-testid="`help-when-${t.id}`"
        >
          <dt class="text-sm font-bold text-carbon mb-1">{{ t.term }}</dt>
          <dd class="text-sm text-carbon-2 leading-relaxed m-0">
            <p v-for="(b, i) in t.body" :key="i" :class="i > 0 ? 'mt-2' : ''">{{ b }}</p>
          </dd>
        </div>
      </dl>
    </section>
  </div>
</template>
