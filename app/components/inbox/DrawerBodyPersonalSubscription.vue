<script setup lang="ts">
const props = defineProps<{
  body: Record<string, unknown>
}>()

function text(key: string): string | null {
  const value = props.body[key]
  return typeof value === 'string' ? value : null
}

function number(key: string): number | null {
  const value = props.body[key]
  return typeof value === 'number' ? value : null
}

const tool = text('tool')
const signalMonth = text('signalMonth')
const usageUsd = number('usageUsd')
const days = number('days')
const actionHref = text('actionHref') ?? '/account#personal-subscription'
</script>

<template>
  <section class="space-y-5">
    <div>
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Uncorroborated usage
      </div>
      <p class="text-sm text-carbon-2 leading-relaxed">
        TokenScope saw
        <strong v-if="usageUsd !== null">${{ usageUsd.toFixed(2) }}</strong>
        <span v-else>material usage</span>
        from <code v-if="tool" class="bg-calm/40 px-1 rounded">{{ tool }}</code>
        <span v-if="signalMonth"> during {{ signalMonth }}</span>
        <span v-if="days !== null"> across {{ days }} settled day{{ days === 1 ? '' : 's' }}</span>,
        but no Insight provider usage matched it.
      </p>
    </div>

    <div>
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Is this personally funded?
      </div>
      <p class="text-sm text-carbon-2 leading-relaxed">
        If you pay for this tool yourself, declare the exact subscription in your account.
        The usage stays visible but is excluded from chargeback. If it is Insight-funded,
        do not declare it; dismiss this prompt and ask an admin to check provider coverage.
        TokenScope never classifies it automatically.
      </p>
      <UiButton
        :to="actionHref"
        kind="primary"
        size="sm"
        class="mt-3"
        data-testid="personal-subscription-prompt-action"
      >
        Review personal subscriptions →
      </UiButton>
    </div>
  </section>
</template>
