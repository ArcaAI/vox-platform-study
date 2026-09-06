/**
 * Wire types for the unified tenant BYO cloud-credential lane (C1/C2/C3).
 * Hand-declared to mirror the gateway DTO (BFF boundary — no server import).
 * Source: apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts
 *         packages/applications/src/services/ai-provider-connection/dto/
 *         packages/applications/src/services/ai-provider-connection/constants.ts (C5)
 */

/**
 * The capability a connection row serves (unified plane, C1/C2).
 *
 * Both the type and the list come from `./services`, where they are pinned to
 * the gateway's `:service` OpenAPI enum by a drift test.
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
 * serves `CLOUD_BYO_PROVIDERS`. `rerank` and `model-registry` are deliberately
 * EMPTY — platform infrastructure, SYSTEM rows only.
 */
export const CLOUD_BYO_PROVIDERS: Record<ProviderService, readonly string[]> = {
  llm: ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
  stt: ['azure-speech', 'sarvam', 'openai'],
  tts: ['azure', 'sarvam'],
  embeddings: ['azure', 'openai'],
  rerank: [],
  vector: ['qdrant'],
  'model-registry': [],
};

/**
 * TASK-890 §3.7a — one model DECLARED on a connection. The slug is
 * SERVER-generated and stable; the console never invents one.
 */
export interface ConnectionModel {
  id: string;
  slug: string;
  name: string;
  wireModelId: string;
  taskType: string;
  capabilities: { supportedGenerationParams?: string[]; supportsSsml?: boolean };
}

/** One entry of `PUT admin/providers/:service/:provider/models`. */
export interface DeclaredConnectionModel {
  wireModelId: string;
  name: string;
  taskType: string;
  /** Sent ONLY to accept the `suggestedSlug` a 409 offered. */
  slug?: string;
}

export interface DeclareConnectionModelsRequest {
  models: DeclaredConnectionModel[];
}

/**
 * The services a tenant may declare models under, and the task types each
 * governs. Hand-declared at the BFF boundary, mirroring
 * `BYO_DECLARABLE_SERVICES` / `MODEL_TASK_TYPE_SERVICE` in @arcaai/applications
 * (`byo-model-declaration.ts`, `constants.ts`); nothing on the wire serves
 * them. A capability that is absent here declares no per-tenant model rows —
 * `embeddings` / `rerank` / `vector` / `model-registry` have no workload that
 * executes one, and the gateway refuses the declaration with a 400.
 */
export const MODEL_TASK_TYPES_BY_SERVICE: Partial<Record<ProviderService, readonly { value: string; label: string }[]>> = {
  llm: [
    { value: 'TEXT_GENERATION', label: 'Text generation' },
    { value: 'TEXT2TEXT_GENERATION', label: 'Text-to-text generation' },
    { value: 'SUMMARIZATION', label: 'Summarization' },
    { value: 'TRANSLATION', label: 'Translation' },
    { value: 'GUARDRAIL', label: 'Guardrail screen' },
  ],
  stt: [
    { value: 'AUTOMATIC_SPEECH_RECOGNITION', label: 'Speech recognition' },
    { value: 'SPEAKER_DIARIZATION', label: 'Speaker diarization' },
  ],
  tts: [
    { value: 'TEXT_TO_SPEECH', label: 'Text to speech' },
    { value: 'TEXT_TO_AUDIO', label: 'Text to audio' },
  ],
};

export function declarableService(service: ProviderService): boolean {
  return (MODEL_TASK_TYPES_BY_SERVICE[service]?.length ?? 0) > 0;
}

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
  /** TASK-862 — connection-level ceilings (moved from the retired runtime profiles). Null = no opinion. */
  maxConcurrent: number | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  timeoutS: number | null;
  /** OCC token; 0 = the "no row yet" placeholder. */
  version: number;
  updatedAt?: string;
  /** TASK-890 §3.7a — the models declared on this connection (single-row read only). */
  models?: ConnectionModel[];
}

/** The ceiling columns, in display order. */
export const CONNECTION_CEILINGS = [
  { name: 'maxConcurrent', label: 'Max concurrent', placeholder: 'e.g. 8', help: 'simultaneous in-flight requests' },
  { name: 'rpmLimit', label: 'Requests / min', placeholder: 'e.g. 600', help: 'vendor account RPM quota' },
  { name: 'tpmLimit', label: 'Tokens / min', placeholder: 'e.g. 200000', help: 'tokens (LLM) or characters (TTS) per minute' },
  { name: 'timeoutS', label: 'Timeout (s)', placeholder: 'e.g. 60', help: 'per-request timeout' },
] as const satisfies ReadonlyArray<{ name: keyof ProviderConnection; label: string; placeholder: string; help: string }>;

export type ConnectionCeiling = (typeof CONNECTION_CEILINGS)[number]['name'];

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
  maxConcurrent?: number | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  timeoutS?: number | null;
  /** OCC token from the read ETag; 0 creates. */
  expectedVersion: number;
}

/**
 * POST admin/providers/:service/:provider/test body — ephemeral, never
 * persisted. Every field is optional: an omitted one falls back to the STORED
 * row (tenant → SYSTEM), so a saved write-only key can be re-tested.
 */
export interface TestProviderConnectionRequest {
  apiKey?: string;
  baseUrl?: string;
  region?: string;
  apiVersion?: string;
  deploymentName?: string;
}

export interface TestProviderConnectionResult {
  ok: boolean;
  message: string;
  /** `auth` = the vendor confirmed the credential; `reachability` = only the endpoint answered. */
  probe: 'auth' | 'reachability';
  /** Which tier supplied the probed configuration. */
  source: 'request' | 'tenant' | 'platform';
  /**
   * Model / deployment ids the vendor listed during this probe (TASK-890 §3.7).
   * ABSENT — never `[]` — when the vendor exposes no listing or the probe failed.
   */
  discoveredModels?: string[];
}

/**
 * The three states of a `(service, provider)` row as the console names them —
 * the same vocabulary as `CONNECTION_ENABLED_SEMANTICS` in the gateway.
 */
export type ConnectionState = 'platform-default' | 'bring-your-own' | 'disabled';

export function connectionStateOf(row: Pick<ProviderConnection, 'version' | 'hasKey' | 'enabled'>): ConnectionState {
  if (row.version === 0) return 'platform-default';
  if (!row.enabled) return 'disabled';
  return row.hasKey ? 'bring-your-own' : 'platform-default';
}

/**
 * The subset of an `AiRoutingPolicy` row the "Used by" panel needs — a
 * read-only projection of `GET admin/routing-policies?tenantId=`. The panel
 * lists which non-agent tasks bind a configuration; Agents (TASK-863) and
 * workflow nodes join it after they land.
 */
export interface RoutingBinding {
  id: string;
  tenantId: string;
  taskKey: string;
  taskKind: string | null;
  displayName: string | null;
  providerConnectionId: string | null;
  modelId: string | null;
  modelRef: string | null;
  isDefault: boolean;
  enabled: boolean;
  status: string;
  priority: number;
}
