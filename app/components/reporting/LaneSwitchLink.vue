<script setup lang="ts">
/*
 * LaneSwitchLink — the I5 cross-link: a quiet footer link on USAGE-mode cards
 * that have a chargeback sibling, switching the page's primary lens to §B.
 *
 * Self-wires to useReportState() (the SOLE owner of the `?lane=` URL key),
 * exactly like LaneToggle — no prop/emit chain, and the URL round-trip keeps
 * the switch shareable. Rendered ONLY inside usage-mode cards (the chargeback
 * cards' route back is the always-visible LaneToggle in the page header).
 */
withDefaults(defineProps<{ label?: string }>(), { label: 'See the chargeback view' })

const rs = useReportState()

function switchLane() {
  rs.lane.value = 'chargeback'
}
</script>

<template>
  <button
    type="button"
    class="mt-2 text-[11px] font-semibold text-brand-harmony hover:underline"
    data-testid="lane-switch-link"
    @click="switchLane"
  >
    {{ label }} →
  </button>
</template>
