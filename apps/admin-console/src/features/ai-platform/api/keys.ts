/**
 * Query keys for the provider-configuration plane.
 *
 * Every key carries the TENANT it was read for. That is not cosmetic: this
 * screen's tenancy control switches between the SYSTEM tier and a customer
 * tenant without navigating, so a key that omitted the tenant would serve one
 * tenant's configurations under another's heading the moment the control moved
 * — the client-side shape of the cache rule in `09-infrastructure-devops.md`
 * (`tenantId` is part of every config cache key).
 */

export const routingPolicyKeys = {
  root: ['ai-routing-policies'] as const,
  list: (tenantId: string, taskKey?: string) => [...routingPolicyKeys.root, 'list', tenantId, taskKey ?? 'all'] as const,
  detail: (tenantId: string, id: string) => [...routingPolicyKeys.root, 'detail', tenantId, id] as const,
  effective: (tenantId: string, taskKey: string) => [...routingPolicyKeys.root, 'effective', tenantId, taskKey] as const,
  export: (tenantId: string, taskKeys?: string[]) => [...routingPolicyKeys.root, 'export', tenantId, taskKeys?.join(',') ?? 'all'] as const,
};

export const modelStoreKeys = {
  root: ['ai-model-store'] as const,
  objects: (bucket: string, prefix: string) => [...modelStoreKeys.root, 'objects', bucket, prefix] as const,
  buckets: () => [...modelStoreKeys.root, 'buckets'] as const,
};
