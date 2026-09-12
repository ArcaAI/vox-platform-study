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
 * TASK-958 D-1 — a connection SLUG is what the route addresses now.
 *
 * `^[a-z0-9][a-z0-9-]{1,62}$`, verbatim from the gateway contract (§4.1). It is
 * IMMUTABLE after create — the slug is embedded in every model slug the
 * connection mints (`<connectionSlug>-<wireModelId>`) and rides the wire as
 * `connection_key` — so a client-side refusal is the last cheap place to catch
 * a typo before it becomes permanent. Renaming is what `name` is for.
 */
export const CONNECTION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function isValidConnectionSlug(value: string): boolean {
  return CONNECTION_SLUG_PATTERN.test(value);
}

/**
 * TASK-958 — the slugs a tenant may NOT name a connection (gateway 400
 * `CONNECTION_SLUG_RESERVED`), mirrored client-side.
 *
 * Two families, for two different reasons:
 *
 *  - **any known provider id, of ANY service.** That slug belongs to the
 *    provider's own DEFAULT connection (`slug === provider` is what makes every
 *    pre-958 row addressable), so a sibling claiming it would collide with the
 *    row the provider-name cascade resolves. Across services, because a slug is
 *    unique per `(tenant, service)` and an `llm` id is a perfectly plausible
 *    typo on the `stt` tab.
 *  - **`platform-defaults`**, which is a ROUTE segment on the same family
 *    (`GET :service/platform-defaults`) — a row named after it would be
 *    unaddressable by the very route that lists it.
 *
 * Mirrored rather than merely awaited because the slug is IMMUTABLE after
 * create: this is the last place a name is still free to change. It is
 * deliberately the CONSERVATIVE list (the gateway's own provider table may know
 * more names than a tenant may bring), so it can never refuse something the
 * gateway would accept — a refusal that only the gateway knows about still
 * arrives as `CONNECTION_SLUG_RESERVED` and is rendered as guidance.
 */
export const RESERVED_CONNECTION_SLUGS: ReadonlySet<string> = new Set<string>([
  ...Object.values(CLOUD_BYO_PROVIDERS).flat(),
  'platform-defaults',
]);

export function isReservedConnectionSlug(value: string): boolean {
  return RESERVED_CONNECTION_SLUGS.has(value);
}

/**
 * GET admin/providers/:service/:slug — the MASKED row. There is deliberately no
 * key field and no reveal route: presence of key material is reported as
 * `hasKey` + `keyVersion` only.
 *
 * TASK-958: `id` / `slug` / `name` / `isDefault` are the multiplicity fields.
 * They are OPTIONAL here only for the MERGE WINDOW — Lane B1 always sends them,
 * but this lane ships against the interface contract while the gateway half is
 * in flight, and a row read from a gateway that predates it must still render.
 * Never read them raw: `connectionSlugOf` / `connectionIsDefault` carry the
 * derivation (`slug ?? provider`, `isDefault ?? true`), which is exactly right
 * for every row that exists today — one row per provider, and it IS the default.
 */
export interface ProviderConnection {
  id?: string;
  tenantId: string;
  service: ProviderService;
  provider: string;
  /** Tenant-chosen connection id, unique per `(tenant, service)`. `=== provider` on every default row. */
  slug?: string;
  /** Free-text display label. Null = unnamed; the slug is then the name. */
  name?: string | null;
  /** Whether this row is the tenant's DEFAULT connection for `provider` (D-3: what a SYSTEM-catalogue model resolves through). */
  isDefault?: boolean;
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

/** The slug a row is addressed by — `provider` for every pre-TASK-958 row. */
export function connectionSlugOf(row: Pick<ProviderConnection, 'slug' | 'provider'>): string {
  return row.slug ?? row.provider;
}

/** Whether a row is its provider's default. Absent = true: a lone row always was. */
export function connectionIsDefault(row: Pick<ProviderConnection, 'isDefault'>): boolean {
  return row.isDefault ?? true;
}

/**
 * The `code` of a structured gateway refusal (`CONNECTION_IS_DEFAULT`,
 * `CONNECTION_SLUG_INVALID`, …). The gateway throws
 * `new ConflictException({ code, message, … })`, so the code rides the BODY,
 * which `GatewayError` keeps in `details`; `GatewayError.code` is Nest's own
 * error NAME ("Conflict") and is not it. Read through this, never by hand.
 */
export function gatewayErrorCode(error: unknown): string | undefined {
  const details = (error as { details?: unknown } | null)?.details;
  const code = (details as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The ceiling columns, in display order. */
export const CONNECTION_CEILINGS = [
  { name: 'maxConcurrent', label: 'Max concurrent', placeholder: 'e.g. 8', help: 'simultaneous in-flight requests' },
  { name: 'rpmLimit', label: 'Requests / min', placeholder: 'e.g. 600', help: 'vendor account RPM quota' },
  { name: 'tpmLimit', label: 'Tokens / min', placeholder: 'e.g. 200000', help: 'tokens (LLM) or characters (TTS) per minute' },
  { name: 'timeoutS', label: 'Timeout (s)', placeholder: 'e.g. 60', help: 'per-request timeout' },
] as const satisfies ReadonlyArray<{ name: keyof ProviderConnection; label: string; placeholder: string; help: string }>;

export type ConnectionCeiling = (typeof CONNECTION_CEILINGS)[number]['name'];

/**
 * PUT admin/providers/:service/:slug body. `apiKey` is write-only.
 *
 * An OMITTED field means "leave the stored value untouched", which is what makes
 * the TASK-958 flips safe to send on their own: "make this the default" carries
 * `isDefault` and nothing else, and creating a sibling carries only the three
 * facts the gateway cannot infer.
 */
export interface UpsertProviderConnectionRequest {
  /**
   * TASK-958 D-2 — the VENDOR this slug is an account of. REQUIRED by the
   * gateway whenever the slug is not itself a `CLOUD_BYO_PROVIDERS` id (it
   * defaults to the slug otherwise), and on update it must equal the row's
   * provider — a connection cannot change vendor (409 `CONNECTION_PROVIDER_IMMUTABLE`).
   */
  provider?: string;
  /** Display label. The one part of a connection's identity that IS renameable (OQ-7). */
  name?: string | null;
  /**
   * `true` flips the provider's default onto this row in ONE transaction (the
   * sibling that held it is cleared). `false` on the current default is a 400 —
   * a provider always has exactly one default; you move it, you do not clear it.
   */
  isDefault?: boolean;
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
  /**
   * TASK-958 — WHICH vendor to probe, when the row does not exist yet.
   *
   * The route reads the vendor off the stored row; on an UNSAVED connection
   * there is no row, and `:slug` is not a vendor name for a named sibling. Sent
   * only in that case — a stored row already knows what it is, and its provider
   * is immutable.
   */
  provider?: string;
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
 *
 * TENANT-TIER VOCABULARY, and only that. Every word in it ("platform default",
 * "bring your own", "disabled for this tenant") describes a tenant's relation to
 * a credential it does not own. Applied to a SYSTEM row it produced the defect
 * TASK-932 R-11 names: the platform's own weight store rendered as "no key ·
 * Disabled for this tenant" — tenant wording, on a platform row, about the thing
 * every model fetch depends on. `platformStateOf` below is the platform tier's
 * own vocabulary; neither is a substitute for the other.
 */
export type ConnectionState = 'platform-default' | 'bring-your-own' | 'disabled';

export function connectionStateOf(row: Pick<ProviderConnection, 'version' | 'hasKey' | 'enabled'>): ConnectionState {
  if (row.version === 0) return 'platform-default';
  if (!row.enabled) return 'disabled';
  return row.hasKey ? 'bring-your-own' : 'platform-default';
}

/**
 * What a PLATFORM-tier row is, in the platform's own words (TASK-932).
 *
 *   `not-configured` no row yet — nothing serves this provider.
 *   `built-in`       enabled with no credential of its own: a self-hosted engine
 *                    (which authenticates nobody) or a built-in plane running on
 *                    the platform's own credentials.
 *   `configured`     enabled with a credential an admin supplied.
 *   `off`            disabled — the PLATFORM's veto, not a tenant's.
 */
export type PlatformConnectionState = 'not-configured' | 'built-in' | 'configured' | 'off';

export function platformStateOf(row: Pick<ProviderConnection, 'version' | 'hasKey' | 'enabled'>): PlatformConnectionState {
  if (row.version === 0) return 'not-configured';
  if (!row.enabled) return 'off';
  return row.hasKey ? 'configured' : 'built-in';
}

/**
 * ── The platform fallback a TENANT inherits (TASK-954) ──────────────────────
 *
 * `GET admin/providers/:service/platform-defaults` — the SYSTEM tier's cloud
 * rows for one service, MASKED (`hasKey` only) and annotated with the cascade's
 * verdict for the scoped tenant. Read-only by construction: no route writes it
 * under a tenant scope. A hand-declared mirror of
 * `PlatformDefaultConnectionsResponse` (@arcaai/applications).
 *
 * `resolution`, in the order the cascade decides it:
 *   `overridden`     the tenant's own ENABLED, keyed row wins; the platform row is not consulted
 *   `vetoed`         the tenant DISABLED its own row — fail closed, the platform key is blocked too
 *   `not-entitled`   no `platformDefaultCredential` grant — no platform vendor account serves this tenant
 *   `not-configured` the platform row is absent or keyless — nothing to inherit
 *   `off`            the platform row is disabled — it serves nobody
 *   `inherited`      an enabled, keyed platform row the tenant has no opinion on — THIS serves the tenant
 */
export const PLATFORM_DEFAULT_RESOLUTIONS = ['inherited', 'overridden', 'vetoed', 'not-entitled', 'not-configured', 'off'] as const;
export type PlatformDefaultResolution = (typeof PLATFORM_DEFAULT_RESOLUTIONS)[number];

export interface PlatformDefaultConnection extends ProviderConnection {
  resolution: PlatformDefaultResolution;
}

export interface PlatformDefaults {
  service: ProviderService;
  /** The tenant the verdicts were computed for. */
  tenantId: string;
  /** Whether this tenant may draw on the platform's vendor accounts at all. */
  entitled: boolean;
  /** One entry per cloud BYO provider of the service, in the platform's order; a placeholder (`version: 0`) where the platform has no row. */
  connections: PlatformDefaultConnection[];
}

/**
 * ── Inference readiness, narrowed to what an ENGINE CARD renders ────────────
 *
 * A hand-declared BFF mirror of `InferenceReadinessResponse`
 * (@arcaai/applications), carrying only the `engines[]` half: this screen has no
 * use for the per-model verdicts, and copying the whole shape would invite it to
 * grow a second model catalogue. The full document lives on `/ai-services`.
 */
export interface ReadinessEngine {
  /** Canonical provider spelling (`lmstudio` folded to `lm-studio`). */
  provider: string;
  /** `unknown` = the aggregator itself did not answer — NOT a synonym for "down". */
  status: 'up' | 'down' | 'unknown';
  latencyMs: number | null;
  loadedCount: number;
  listedCount: number;
  detail: string | null;
}

export interface InferenceReadinessSnapshot {
  checkedAt: string;
  engines: ReadinessEngine[];
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
