/**
 * Wire types for the unified tenant BYO cloud-credential lane (C1/C2/C3,
 * ). Hand-declared to mirror the gateway DTO (BFF boundary — no
 * server import).
 * Source: apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts
 *         packages/applications/src/services/ai-provider-connection/dto/
 *         packages/applications/src/services/ai-provider-connection/constants.ts (C5)
 */

/**
 * The capability a connection row serves (unified plane, C1/C2).
 *
 * Both the type and the list now come from `./services`, where they are pinned
 * to the gateway's `:service` OpenAPI enum by a drift test. They used to be
 * hand-typed here as `'llm' | 'stt' | 'tts'` and went stale the moment
 * TASK-799 P1-C.1 widened the union to six — re-exported rather than moved so
 * the feature's existing `from './types'` imports keep working.
 */
export { PROVIDER_SERVICES, isProviderService, type ProviderService } from './services';
import type { ProviderService } from './services';

/**
 * C5 — providers a tenant may hold its own connection row for, per service.
 * Mirrors `CLOUD_BYO_PROVIDERS` in `@arcaai/applications`
 * (`packages/applications/src/services/ai-provider-connection/constants.ts`);
 * anything else is platform infrastructure (a tenant write is a 403 privilege
 * boundary on the caller's own tenant, not the 404-over-403 cross-tenant
 * posture).
 *
 * NOTE — unlike `PROVIDER_SERVICES` above, this map is NOT derivable from the
 * contract: `:provider` is an open string in the OpenAPI document, and no route
 * serves `CLOUD_BYO_PROVIDERS`. It is therefore the one transcription left on
 * this surface, and it is reported as such (Phase 4 E.3). `rerank` is
 * deliberately EMPTY — the only reranker is the self-hosted TEI service, which
 * is platform infrastructure, so a tenant row is a 403 and only the SYSTEM row
 * serves.
 */
export const CLOUD_BYO_PROVIDERS: Record<ProviderService, readonly string[]> = {
  llm: ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
  stt: ['azure-speech', 'sarvam', 'openai'],
  tts: ['azure', 'sarvam'],
  embeddings: ['azure', 'openai'],
  rerank: [],
  vector: ['qdrant'],
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
