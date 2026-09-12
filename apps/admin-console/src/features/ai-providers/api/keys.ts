import type { ProviderService } from './types';

/**
 * Query keys for the unified tenant BYO cloud-credential lane.
 *
 * Every key carries the TENANT it was read for (TASK-862): the screen's tier
 * control switches between the SYSTEM tier and the working tenant without
 * navigating, and a key that omitted the tenant would serve one tier's row under
 * the other's heading — the client-side shape of the config-cache rule in
 * `09-infrastructure-devops.md` (`tenantId` is part of every config cache key).
 */
export const providerConnectionKeys = {
  root: ['ai-providers'] as const,
  tenant: (tenantId: string | undefined) => [...providerConnectionKeys.root, tenantId ?? 'cls'] as const,
  service: (service: ProviderService, tenantId?: string) => [...providerConnectionKeys.tenant(tenantId), service] as const,
  /**
   * TASK-958 — the leaf is the connection SLUG, not the provider.
   *
   * For every row that exists today `slug === provider`, so this key's VALUES
   * are unchanged; what changes is that a tenant's second `openai` account has
   * a key of its own instead of overwriting the first one's cache entry.
   */
  row: (service: ProviderService, slug: string, tenantId?: string) => [...providerConnectionKeys.service(service, tenantId), 'row', slug] as const,
  /**
   * `GET admin/providers/:service` — every connection the tenant holds for one
   * capability. Nested under the service key so a save or a remove (which
   * invalidate it) refreshes the group a card sits in.
   */
  list: (service: ProviderService, tenantId?: string) => [...providerConnectionKeys.service(service, tenantId), 'list'] as const,
  /**
   * TASK-954 — nested under the SERVICE key on purpose: a tenant's own save or
   * remove changes the verdict (`overridden` / `vetoed` / back to `inherited`),
   * and the mutations invalidate the service key, so the read-only panel
   * refreshes with the card.
   */
  platformDefaults: (service: ProviderService, tenantId?: string) => [...providerConnectionKeys.service(service, tenantId), 'platform-defaults'] as const,
  bindings: (tenantId: string) => [...providerConnectionKeys.tenant(tenantId), 'bindings'] as const,
  /**
   * The readiness snapshot is PLATFORM-WIDE — one observation of the engines
   * this deployment runs — so it is the one key here that carries no tenant.
   */
  readiness: () => [...providerConnectionKeys.root, 'readiness'] as const,
};
