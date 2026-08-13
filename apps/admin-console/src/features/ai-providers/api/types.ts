/**
 * Wire types for the unified tenant BYO cloud-credential lane (C1/C2/C3,
 * ). Hand-declared to mirror the gateway DTO (BFF boundary — no
 * server import).
 * Source: apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts
 *         packages/applications/src/services/ai-provider-connection/dto/
 *         packages/applications/src/services/ai-provider-connection/constants.ts (C5)
 */

/** The capability a connection row serves (unified plane, C1/C2). */
export type ProviderService = 'llm' | 'stt' | 'tts';

export const PROVIDER_SERVICES: readonly ProviderService[] = ['llm', 'stt', 'tts'];

/**
 * C5 — providers a tenant may hold its own connection row for, per service.
 * Mirrors `CLOUD_BYO_PROVIDERS` in `@arcaai/applications`
 * (`packages/applications/src/services/ai-provider-connection/constants.ts`);
 * anything else is platform infrastructure (a tenant write is a 403 privilege
 * boundary on the caller's own tenant, not the 404-over-403 cross-tenant
 * posture).
 */
export const CLOUD_BYO_PROVIDERS: Record<ProviderService, readonly string[]> = {
  llm: ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
  stt: ['azure-speech', 'sarvam', 'openai'],
  tts: ['azure', 'sarvam'],
};

/**
 * GET admin/providers/:service/:provider — the MASKED row. There is
 * deliberately no key field and no reveal route: presence of key material is
 * reported as `hasKey` + `keyVersion` only.
 */
export interface ProviderConnection {
  tenantId: string;
  service: ProviderService;
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

/** PUT admin/providers/:service/:provider body. `apiKey` is write-only. */
export interface UpsertProviderConnectionRequest {
  apiKey?: string;
  baseUrl?: string | null;
  region?: string | null;
  apiVersion?: string | null;
  deploymentName?: string | null;
  /** Provider-specific extras that have no dedicated column (e.g. an STT model override, a Vertex GCP project). */
  extraJson?: Record<string, unknown> | null;
  enabled?: boolean;
  /** OCC token from the read ETag; 0 creates. */
  expectedVersion: number;
}
