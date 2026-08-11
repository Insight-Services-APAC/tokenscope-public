<script setup lang="ts">
/*
 * UiBuildStamp — "which build am I looking at", in one line.
 *
 * Every field is fetched from /api/v1/meta/build, so nothing here is
 * hand-maintained and nothing goes stale: the version comes from package.json
 * at build, the commit from the image's baked GIT_COMMIT_SHA, the environment
 * from the running container's own classification. This replaced a typed
 * literal ("APAC · v0.1.0 · MVP-Lite first slice") that was wrong on all three
 * counts by the time anyone noticed.
 *
 * Renders NOTHING until it has something true to say — no skeleton, no
 * "unknown", no placeholder. A footnote that cannot load is a footnote nobody
 * misses; a footnote that lies costs someone an afternoon.
 *
 * NOT awaited: with `lazy + server:false` the await resolves immediately and
 * buys nothing, but it makes this an async setup component — which matters now
 * that it renders from a LAYOUT (the footer on every signed-in page), not just
 * one page. A synchronous setup keeps it out of the layout's Suspense path.
 */
import { computed } from 'vue'
import { formatBuildStamp, type BuildInfo } from '#shared/build-info'
// Imported explicitly, not auto-imported: this component is mounted outside a
// Nuxt runtime by app-footer-build-stamp.test.ts, and an auto-import would only
// resolve inside the app build.
import { useRefreshOnVisible } from '../../composables/useRefreshOnVisible'

const { data, refresh } = useFetch<BuildInfo>('/api/v1/meta/build', {
  lazy: true,
  server: false,
})

/*
 * Re-read when the tab regains focus.
 *
 * The stamp lives in a layout, so it mounts once and useFetch caches by key —
 * meaning a revision that rolls while someone has the app open would leave the
 * OLD commit on screen indefinitely. That is precisely backwards for a control
 * whose entire job is answering "did my deploy land?", and it is the state
 * someone checks in: alt-tab to the terminal, watch the deploy, come back.
 *
 * The mechanism now lives in useRefreshOnVisible, shared with the personal
 * spend surfaces (which had the same staleness bug across a month boundary).
 */
useRefreshOnVisible(refresh)

const stamp = computed(() => (data.value ? formatBuildStamp(data.value) : ''))
</script>

<template>
  <span v-if="stamp" class="font-mono" data-testid="build-stamp">{{ stamp }}</span>
</template>
