/**
 * Wire types for the self-hosted inference-engine screens (LM Studio, vLLM).
 *
 * Every shape here is a hand-declared mirror of a gateway DTO — the BFF
 * boundary means no server import. Sources:
 *   - `apps/api/src/modules/ai-model/ai-model-discovery.service.ts` (DiscoveryResponse)
 *   - `apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts`
 *   - `apps/api/src/modules/storage/storage.controller.ts`
 *
 * The discovery shapes are DUPLICATED from `features/ai-models/api/types.ts`
 * rather than imported: rule 13 §Structure says features never import each
 * other, and this feature needs the same read for a different purpose (one
 * engine's operational state, not the registry merge). Kept to the fields these
 * screens actually render, so the copy has little surface to drift on. The
 * registry remains the authoritative editor — these screens never write a model
 * row.
 */

/** The two self-hosted engines that have a screen. Spelled exactly as the gateway/TEXT registry keys. */
export type InferenceEngineProvider = 'lm-studio' | 'vllm';

export type DiscoveryEntryStatus = 'registered' | 'discovered' | 'registered-missing-on-server';
export type DiscoveryLoadState = 'loaded' | 'not-loaded' | 'unknown';
export type DiscoveryProbeStatus = 'ok' | 'timeout' | 'error' | 'skipped';
/** Which tier of the tenant → SYSTEM cascade supplied the probed endpoint. */
export type DiscoveryConnectionSource = 'tenant' | 'system';

export interface DiscoveryEntry {
  provider: string;
  modelName: string;
  status: DiscoveryEntryStatus;
  loadState: DiscoveryLoadState;
  registeredModel?: { id: string; slug: string; resourceStatus: string };
  /** Engine-native metadata — quantization, max_context_length, … Open by design. */
  engineMeta?: Record<string, unknown>;
}

export interface DiscoveryProbe {
  provider: string;
  probeStatus: DiscoveryProbeStatus;
  latencyMs?: number;
  error?: string;
  connectionSource?: DiscoveryConnectionSource;
}

export interface DiscoveryResponse {
  entries: DiscoveryEntry[];
  probes: DiscoveryProbe[];
  probedAt: string;
}

/**
 * GET admin/providers/llm/:provider — the MASKED connection row. `version: 0`
 * is the gateway's "no row yet" placeholder, which for a self-hosted engine is
 * the NORMAL state: a keyless row injects on neither tier, so most deployments
 * have no row at all and the engine is reached at the service default.
 */
export interface EngineConnection {
  tenantId: string;
  service: string;
  provider: string;
  baseUrl: string | null;
  hasKey: boolean;
  enabled: boolean;
  version: number;
  updatedAt?: string;
}

/** GET storage/buckets/:name/files — plain array, `prefix` is the only server-side filter. */
export interface EngineArtifact {
  key: string;
  size: number;
  lastModified?: string;
}
