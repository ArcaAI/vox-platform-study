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
  row: (service: ProviderService, provider: string, tenantId?: string) => [...providerConnectionKeys.service(service, tenantId), 'row', provider] as const,
  bindings: (tenantId: string) => [...providerConnectionKeys.tenant(tenantId), 'bindings'] as const,
  /**
   * The readiness snapshot is PLATFORM-WIDE — one observation of the engines
   * this deployment runs — so it is the one key here that carries no tenant.
   */
  readiness: () => [...providerConnectionKeys.root, 'readiness'] as const,
};
