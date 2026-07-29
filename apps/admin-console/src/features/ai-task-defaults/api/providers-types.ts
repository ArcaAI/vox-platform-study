/**
 * Wire types for the tenant BYO cloud-credential lane.
 * Hand-declared to mirror the gateway DTOs (BFF boundary — no server import).
 * Source: apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts
 *         packages/applications/src/services/ai-provider-connection/dto/
 */

/**
 * LLM providers a tenant may hold its own connection row for. Mirrors
 * `CLOUD_BYO_PROVIDERS.llm` in @arcaai/applications — anything else is a
 * self-host engine whose endpoint is platform infrastructure (tenant write →
 * 403). `openai` / `anthropic` / `vertex` were added by TASK-572.
 */
export const CLOUD_BYO_PROVIDERS = ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'] as const;
export type CloudByoProvider = (typeof CLOUD_BYO_PROVIDERS)[number];

/**
 * GET admin/providers/llm/:provider — the MASKED row. There is deliberately no
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

/** PUT admin/providers/llm/:provider body. `apiKey` is write-only. */
export interface UpsertProviderConnectionRequest {
  apiKey?: string;
  baseUrl?: string | null;
  region?: string | null;
  apiVersion?: string | null;
  deploymentName?: string | null;
  /**
   * Provider-specific extras. Vertex stores its GCP `project` here (its
   * `location` reuses the `region` column); azure/bedrock/openai/anthropic leave
   * it null.
   */
  extraJson?: Record<string, unknown> | null;
  enabled?: boolean;
  /** OCC token from the read ETag; 0 creates. */
  expectedVersion: number;
}
