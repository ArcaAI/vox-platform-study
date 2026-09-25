/**
 * Decrypted cloud-ASR provider credentials, injected by the gateway into `apps/stt` (streaming
 * `provider_overrides`) or pulled by the batch worker (`GET internal/stt/provider-overrides`).
 * snake_case matches the Python wire shape. Never persisted, never logged, never returned by a
 * read API.
 *
 * Built from `AiProviderConnection` rows by `AsrAgentResolverService` (through
 * `ProviderCredentialResolver`): the tenant's own BYO row wins, the SYSTEM row serves on absence,
 * a disabled tenant row vetoes its provider.
 *
 * `funding` says WHO PAID for the entry — the caller's own row (`tenant`) or the SYSTEM-tenant
 * platform default (`platform`). It is REQUIRED because this type is built by copying fields off
 * the resolved entry, and a field this shape forgets to copy is a field that silently reverts to
 * `tenant` in `resolve_usage_attribution` — a mis-bill with no error anywhere.
 */
export type SttProviderOverrides = Record<
  string,
  {
    api_key: string;
    funding: 'tenant' | 'platform';
    region?: string;
    base_url?: string;
    endpoint?: string;
    model?: string;
    /**
     * TASK-958 — WHICH `AiProviderConnection` supplied this credential, and the tenant's own name
     * for it.
     *
     * The map is keyed by connection, not provider: a tenant may hold several accounts of one
     * vendor, so its KEY is the connection slug (the provider id for a default or platform row)
     * and `connection_id` is what `apps/stt` returns on `resolve_usage_attribution` so
     * `AiUsageEvent.connectionId` can tell two accounts apart. Optional because a sender that
     * predates them omits both.
     */
    connection_id?: string;
    connection_slug?: string;
  }
>;
