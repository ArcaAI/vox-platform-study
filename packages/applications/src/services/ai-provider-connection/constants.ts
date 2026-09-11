import { ModelTaskType, SYSTEM_TENANT_ID } from '@arcaai/domains';

/**
 * Provider-connection governance vocabulary (UNIFIED plane —, C5).
 *
 * The connection plane is keyed by (tenant, SERVICE, provider). `service` is the
 * capability discriminator; `provider` is capability-scoped (the same name can
 * mean different providers under different services — `azure` = Azure OpenAI
 * under `llm`, Azure Speech under `stt`).
 *
 * Extension recipe: a new serving provider becomes tenant-BYO-eligible ONLY by
 * being listed under its service below — the default is SYSTEM-only.
 */

/**
 * The capability a connection row serves. Validated string, no Prisma enum.
 *
 * C.1 — the first three are INFERENCE capabilities; the last three
 * are the non-inference integrations that previously had NOWHERE to live.
 * Because `service` was a closed `{llm,stt,tts}` set, a tenant secret that was
 * not one of ~11 vendor LLM/STT/TTS slots could not be stored at all: a Qdrant
 * API key, a TEI reranker or embeddings endpoint had to stay an environment
 * variable, which is what blocked the harness and stt migrations.
 *
 * WHY WIDEN THIS COLUMN rather than add a sibling store: D-2 — "never invent a
 * third home". A sibling table would have to re-implement all seven hops of the
 * BYO credential contract (Vault-Transit at rest, the two-tier tenant → SYSTEM
 * cascade, the three `enabled` states, derived funding, minimal-exposure
 * injection, `SecretStr` transport, fail-closed consumption). Widening reuses
 * every one of them, and reuses the OCC/ETag route, the masked read DTO, the
 * repository and the audit `ResourceType` unchanged. `service` is already a
 * plain `TEXT` column with no database CHECK constraint, so this costs NO DDL.
 *
 * `model-registry` is the SEVENTH, and it is not an inference
 * capability at all: it is the plane that authenticates the fetch of MODEL
 * WEIGHTS. Two credentials had nowhere else to live —
 *
 *   `HUGGINGFACE_TOKEN` -> `model-registry:huggingface`. HF is a model HUB that
 *     authenticates with a bearer token, not object storage. Forcing it into
 *     `TenantStorageConfig` was rejected: that table carries a `TenantBucket`
 *     FK, so a token stored there would surface model weights in the tenant's
 *     own bucket listing — a browsing surface for something that is not the
 *     tenant's data.
 *   `STT_MODEL_S3_ACCESS_KEY` / `_SECRET_KEY` -> `model-registry:s3`, where
 *     `baseUrl` is the endpoint, `encryptedApiKey` is the SECRET key, and
 *     `extraJson.accessKeyId` is the non-secret principal id. Splitting a
 *     two-part credential that way has precedent: `ServiceAccount.clientId`
 *     sits in plaintext beside a Vault-referenced secret.
 *
 * WHOSE credential is used is not a question on this plane: owner ruling
 * 2026-08-24 made `model-registry` PLATFORM-MANAGED (see `CLOUD_BYO_PROVIDERS`
 * below), so only the SYSTEM rows exist and every fetch, for every tenant,
 * spends the platform credential. One tenant therefore cannot cause another's
 * token to be spent — there are no tenant tokens here — and a shared in-process
 * weight cache is safe by construction rather than by convention.
 */
export type ProviderService = 'llm' | 'stt' | 'tts' | 'embeddings' | 'rerank' | 'vector' | 'model-registry';

/** Every service, for iteration/validation (the route's `:service` guard reads this). */
export const PROVIDER_SERVICES = ['llm', 'stt', 'tts', 'embeddings', 'rerank', 'vector', 'model-registry'] as const;

/**
 * C5 — the per-service governance map. A TENANT may hold its own connection row
 * (bring-your-own cloud credentials) only for a provider listed under its
 * service; everything else is a self-host engine whose endpoint is platform
 * infrastructure, so its connection is SYSTEM-tenant-only.
 *
 * Attempting a tenant row for a non-listed (service, provider) is a PRIVILEGE
 * boundary on the caller's own tenant — 403, NOT the 404-over-403 cross-tenant
 * posture. Same reasoning as `SUPER_ADMIN_ONLY_TASK_PREFIXES` in
 * `ai-task-default`.
 *
 * All five LLM entries are LIVE: `apps/text` registers the Azure OpenAI,
 * Bedrock, OpenAI, Anthropic and Vertex adapters (`text/main.py`), so a tenant
 * key for any of them is served today. (An earlier note here claimed Anthropic
 * and Vertex were not yet functional — stale, corrected by TASK-862.)
 * Sarvam is deliberately NOT an `llm` provider: its adapter is translation-only
 * and no catalogue model exists for it (TASK-862 D-4).
 */
export const CLOUD_BYO_PROVIDERS: Record<ProviderService, readonly string[]> = {
  llm: ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
  // `azure-foundry` is separate from `azure-speech` on purpose (TASK-880): a Foundry resource IS an
  // Azure Speech resource, but the two engines have different data-residency postures, and one
  // credential gating both meant a tenant could not enable Speech without also enabling a PREVIEW
  // service for its PHI.
  stt: ['azure-speech', 'azure-foundry', 'sarvam', 'openai'],
  tts: ['azure', 'sarvam'],
  // C.1 — the integration capabilities. Each list is EVIDENCE-BASED,
  // not aspirational: a provider is listed only where a tenant can genuinely
  // hold its own vendor account today.
  //   `embeddings` — the same Azure/OpenAI accounts that already back `llm`.
  //   `rerank` — DELIBERATELY EMPTY. The only reranker is the self-hosted TEI
  //                  service, which is platform INFRASTRUCTURE; there is no cloud
  //                  rerank adapter for a tenant to bring a key to. A tenant row
  //                  is therefore a 403 and only the SYSTEM row serves. This list
  //                  is the extension point when that changes.
  //   `vector` — Qdrant Cloud is a real per-tenant subscription, so a tenant
  //                  may point the plane at its own cluster with its own key.
  embeddings: ['azure', 'openai'],
  rerank: [],
  vector: ['qdrant'],
  // `model-registry` — DELIBERATELY EMPTY (owner ruling 2026-08-24).
  //
  // An earlier round listed `['huggingface', 's3']` on the reasoning that a
  // tenant bringing its own gated model must bring the org token that reaches
  // it. The owner ruled otherwise: the built-in inference solutions — LM Studio,
  // Ollama, Transformers + HuggingFace, llama.cpp and (future) vLLM — are
  // PLATFORM-MANAGED, and only a platform super admin sets the HuggingFace
  // token or chooses the provider/model behind an inference task. Those live on
  // the SYSTEM tenant and serve every other tenant as the default/fallback.
  //
  // So a tenant row here is a 403 and only the SYSTEM row serves — the same
  // shape as `rerank` above, and for the same reason: the capability is platform
  // INFRASTRUCTURE, not a per-tenant vendor account. This list stays as the
  // extension point if that ruling is ever revisited.
  'model-registry': [],
};

/**
 * TASK-879 — SYSTEM-ONLY serving providers: the platform's OWN engines, which have a connection
 * row so that "does this deployment run that engine, and where does it live" is a super-admin
 * write with an audit trail rather than a boot flag in a ConfigMap.
 *
 * They are the complement of `CLOUD_BYO_PROVIDERS`, not an addition to it: a tenant row here is a
 * 403 (a self-hosted engine has no vendor account for a tenant to bring), so only the SYSTEM row
 * exists and it serves every tenant — the same shape `rerank` and `model-registry` already have.
 *
 * `tts` is the first service to declare its own: `tts.{kokoro,parler,indicf5}.enabled` were
 * platform settings keys whose whole content was "may this engine serve", which is exactly what a
 * connection row's three-state `enabled` says. Listing an engine here does NOT widen what a tenant
 * may write; it gives the PLATFORM a row to write.
 *
 * A service with no entry declares no self-host serving engine — deliberately empty rather than
 * aspirational, so the list stays evidence about what exists.
 */
export const PLATFORM_SELF_HOST_PROVIDERS: Readonly<Partial<Record<ProviderService, readonly string[]>>> = Object.freeze({
  tts: Object.freeze(['kokoro', 'indic_parler', 'indic_f5'] as const),
  // TASK-952 D-1c — `tei-embed` is the platform's OWN dense-embeddings server
  // (HuggingFace text-embeddings-inference; `hope-tei-embed` in
  // `infrastructure/docker/docker-compose.dev.yml`, and the one embedding
  // provider `apps/text` registers). It is listed here rather than added to
  // `CLOUD_BYO_PROVIDERS.embeddings` because the two lists answer different
  // questions and this one has only one honest answer: a self-hosted server has
  // no vendor account for a tenant to bring, so a tenant row is a 403 and only
  // the SYSTEM row serves.
  //
  // WHY THE PLATFORM TIER NEEDED ITS OWN PROVIDER ID AT ALL. The platform's
  // embeddings default used to have to be an `embeddings:openai` SYSTEM row —
  // a CLOUD pair, so R6 (`mayConsumePlatformDefault`) governs it, and
  // `featurePlatformDefaultCredential` is granted on no plan. Every tenant's
  // resolve therefore came back `entitlementSuppressed`, the harness projected
  // that to `denied`, and retrieval degraded to empty context for everyone. The
  // entitlement gate governs platform SPEND ON A VENDOR ACCOUNT; the platform's
  // own server is not that, so it belongs on a pair the gate does not touch.
  // `embeddings:{azure,openai}` stay exactly as they were — the tenant-BYO lane.
  embeddings: Object.freeze(['tei-embed'] as const),
});

/** Whether `(service, provider)` names one of the platform's own self-hosted serving engines. */
export function isPlatformSelfHostProvider(service: ProviderService, provider: string): boolean {
  return (PLATFORM_SELF_HOST_PROVIDERS[service] ?? []).includes(provider);
}

/** The union of every cloud BYO provider name across all services. */
export type CloudByoProvider = (typeof CLOUD_BYO_PROVIDERS)[ProviderService][number];

/**
 * The three-state meaning of a connection row's `enabled` flag.
 *
 * ONE wording, referenced by the request DTO, the response DTO and the
 * controller's Swagger annotations, so the semantics cannot drift between the
 * surfaces an operator actually reads. The console's helper text mirrors it.
 */
export const CONNECTION_ENABLED_SEMANTICS =
  'Three states, per (service, provider): NO ROW = no opinion, so the platform-provided credential may serve ' +
  'this provider (subject to the tenant holding the platform-default entitlement). ENABLED with a key = your own ' +
  'credential serves it. DISABLED = a VETO: this provider is blocked for your tenant entirely, INCLUDING the ' +
  'platform-provided key, and the call fails rather than falling through to another provider. Disabling is how a ' +
  'tenant refuses a shared vendor account; deleting the row instead returns it to "no opinion".';

/**
 * Whether a tenant may hold its own connection row for `(service, provider)`.
 *
 * The 1-arg form is a `@deprecated` transition shim that assumes `service='llm'`
 * so the `text-proxy.controller` keeps compiling until it
 * repoints to the service-first form; do not use it in new code.
 */
export function isCloudByoProvider(service: ProviderService, provider: string): boolean;
/** @deprecated 1-arg form assumes `service='llm'`; kept for the text-proxy transition (removes it). */
export function isCloudByoProvider(provider: string): boolean;
export function isCloudByoProvider(a: string, b?: string): boolean {
  const service = (b === undefined ? 'llm' : a) as ProviderService;
  const provider = b === undefined ? a : b;
  return (CLOUD_BYO_PROVIDERS[service] ?? []).includes(provider);
}

// ===========================================================================
// TASK-890 §3.7 — the provider CLASS table
// ===========================================================================

/**
 * Providers that SERVE weights themselves: an engine process the platform runs
 * which hosts its own model store. Available whenever their (SYSTEM) connection
 * row is ENABLED — there is no credential to bring and no bucket to stage.
 *
 * Moved here from `agent.service.ts` (TASK-890 L1) because three surfaces read
 * it now — the tenant catalogue, the agent publish gate and the BYO model
 * declaration — and a predicate that decides "is this model usable" belongs with
 * the connection vocabulary it is derived from, not inside one consumer.
 *
 * `lmstudio` is the alias the seeded rows still carry beside `lm-studio`; both
 * are kept deliberately (TASK-890 §3.11 "kept deliberately").
 */
export const ENGINE_SERVED_PROVIDERS: ReadonlySet<string> = new Set(['lm-studio', 'lmstudio', 'ollama', 'vllm', 'llama-cpp']);

/**
 * The SENTINEL provider meaning "one of the platform's OWN services loads these
 * weights from the models bucket" (`apps/stt`, `apps/nlp`, `apps/tts`) —
 * 23 of the 33 seeded rows carry it (§2.7 #13). It is deliberately in NEITHER
 * `ENGINE_SERVED_PROVIDERS` nor `CLOUD_BYO_PROVIDERS`: it is neither an engine
 * with its own store nor a vendor account, so its usability is the MEASURED
 * `AiModel.availability`, never a connection.
 */
export const PLATFORM_SELF_HOST_MODEL_PROVIDER = 'built-in';

/** The one non-BYO group id in the tenant catalogue (OD-L: "Hope provider", exactly one entry). */
export const PROVIDER_GROUP_HOPE = 'hope';

/**
 * Which HALF of the tenant catalogue a provider entry belongs to (§3.7).
 * A DTO label only: `AiModel.provider` keeps the engine/vendor id that routing
 * and the usage ledger are keyed on — `hope` is never a provider id.
 */
export type ProviderGroup = 'byo' | typeof PROVIDER_GROUP_HOPE;

/**
 * How a model row is SERVED, which is what decides whether it is usable and how
 * its readiness is measured (§3.7 class table):
 *
 *   `cloud-byo`          the tenant's own vendor account (its own `AiModel` row)
 *   `cloud-platform`     the platform's vendor account, subject to the cascade + entitlement
 *   `engine-served`      an engine the platform runs which hosts its own weights
 *   `platform-self-host` weights the platform's own services load from the bucket
 */
export type ProviderClass = 'cloud-byo' | 'cloud-platform' | 'engine-served' | 'platform-self-host';

/**
 * `AiModel.taskType` → the connection SERVICE that governs it, or `null` when no
 * connection plane governs that task at all (the NLP classification family is
 * served by `apps/nlp` from the bucket, with no vendor account and no engine).
 *
 * Declared as a total map over the enum so a new task type is a COMPILE error
 * here rather than a silently unclassified catalogue row.
 */
export const MODEL_TASK_TYPE_SERVICE: Readonly<Record<ModelTaskType, ProviderService | null>> = Object.freeze(
  Object.values(ModelTaskType).reduce(
    (acc, taskType) => {
      acc[taskType] = acc[taskType] ?? null;
      return acc;
    },
    {
      [ModelTaskType.TEXT_GENERATION]: 'llm',
      [ModelTaskType.TEXT2TEXT_GENERATION]: 'llm',
      [ModelTaskType.SUMMARIZATION]: 'llm',
      [ModelTaskType.TRANSLATION]: 'llm',
      // The guardrail screen IS an LLM (§2.7 #13 — the Hub tags it text-generation).
      [ModelTaskType.GUARDRAIL]: 'llm',
      [ModelTaskType.FEATURE_EXTRACTION]: 'embeddings',
      [ModelTaskType.SENTENCE_SIMILARITY]: 'embeddings',
      [ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION]: 'stt',
      [ModelTaskType.VOICE_ACTIVITY_DETECTION]: 'stt',
      [ModelTaskType.SPEAKER_DIARIZATION]: 'stt',
      [ModelTaskType.SPEAKER_EMBEDDING]: 'stt',
      [ModelTaskType.AUDIO_CLASSIFICATION]: 'stt',
      [ModelTaskType.AUDIO_TO_AUDIO]: 'stt',
      [ModelTaskType.TEXT_TO_SPEECH]: 'tts',
      [ModelTaskType.TEXT_TO_AUDIO]: 'tts',
    } as Record<ModelTaskType, ProviderService | null>,
  ),
);

/**
 * The class of ONE catalogue row (§3.7). `null` = the row names no provider this
 * platform can serve: hidden from tenants, counted for a super admin
 * (`unassignedProviderCount`) so an unassigned row is visible to the person who
 * can fix it rather than silently absent for everyone.
 *
 * Order matters. A TENANT-owned row is `cloud-byo` whatever its provider says —
 * the tenant plane owns no engines and stages no weights, so its rows can only
 * ever be its own vendor account (§2.7 #9: a tenant `AiModel` row IS the BYO
 * declaration). Only SYSTEM rows reach the three platform classes.
 */
export function providerClassOf(
  service: ProviderService | null,
  provider: string | null | undefined,
  row: { tenantId: string },
): ProviderClass | null {
  if (row.tenantId !== SYSTEM_TENANT_ID) return 'cloud-byo';
  if (!provider) return null;
  if (provider === PLATFORM_SELF_HOST_MODEL_PROVIDER) return 'platform-self-host';
  if (service && isPlatformSelfHostProvider(service, provider)) return 'platform-self-host';
  if (ENGINE_SERVED_PROVIDERS.has(provider)) return 'engine-served';
  if (service && isCloudByoProvider(service, provider)) return 'cloud-platform';
  return null;
}
