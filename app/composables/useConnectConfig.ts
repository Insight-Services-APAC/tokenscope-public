/*
 * useConnectConfig — this deployment's connect config (#415), fetched once per
 * page under a shared key so the homepage buttons, the dialog and the account
 * cards read one response. Lazy and client-only: `config` is null until it lands,
 * and `failed` says the fetch errored (the guide then says so instead of showing
 * instructions for a marketplace it could not confirm).
 */
import { computed } from 'vue'
import type { ConnectClient, ConnectConfig } from '#shared/connect'

export function useConnectConfig() {
  const { data, error } = useFetch<ConnectConfig | null>('/api/v1/connect/config', {
    key: 'connect-config',
    lazy: true,
    server: false,
    default: () => null,
  })
  // Shape-checked: anything without a client list is treated as not loaded.
  const config = computed(() => (Array.isArray(data.value?.enabledClients) ? data.value : null))
  const failed = computed(() => !!error.value)
  /** Unknown (loading / failed) counts as enabled: hiding a button on a fetch blip
   *  would be worse than showing a dialog that then explains the failure. */
  function isEnabled(client: ConnectClient): boolean {
    return !config.value || config.value.enabledClients.includes(client)
  }
  return { config, failed, isEnabled }
}
