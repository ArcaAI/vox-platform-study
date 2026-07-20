/**
 * TASK-526 — wire types for the tenant BYO cloud-credential lane.
 * Hand-declared to mirror the gateway DTOs (BFF boundary — no server import).
 * Source: apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts
 *         packages/applications/src/services/ai-provider-connection/dto/
 */

/**
 * Providers a tenant may hold its own connection row for. Mirrors
 * `CLOUD_BYO_PROVIDERS` in @arcaai/applications — anything else is a self-host
 * engine whose endpoint is platform infrastructure (tenant write → 403).
 */
export const CLOUD_BYO_PROVIDERS = ['azure', 'bedrock'] as const;
export type CloudByoProvider = (typeof CLOUD_BYO_PROVIDERS)[number];

/**
 * GET admin/ai-providers/:provider — the MASKED row. There is deliberately no
 * key field and no reveal route: presence is `hasKey` + `keyVersion` only.
 */
export interface ProviderConnection {
  tenantId: string;
  provider: string;
  baseUrl: string | null;
  region: string | null;
  apiVersion: string | null;
  deploymentName: string | null;
  hasKey: boolean;
  keyVersion: number | null;
  enabled: boolean;
  extraJson: Record<string, unknown> | null;
  /** OCC token; 0 = the "no row yet" placeholder. */
  version: number;
  updatedAt?: string;
}

/** PUT admin/ai-providers/:provider body. `apiKey` is write-only. */
export interface UpsertProviderConnectionRequest {
  apiKey?: string;
  baseUrl?: string | null;
  region?: string | null;
  apiVersion?: string | null;
  deploymentName?: string | null;
  enabled?: boolean;
  /** OCC token from the read ETag; 0 creates. */
  expectedVersion: number;
}
