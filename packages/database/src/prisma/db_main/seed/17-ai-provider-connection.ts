import type { CorePrismaClient } from '../../../client';
import { AI_MODEL_PROVIDERS } from './ai-models/shared';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { encryptSeedSecret, isSeedSecretEncryptionAvailable } from './phi-encryption';

/**
 * AiProviderConnection Seed (config-plane core)
 *
 * Seeds one SYSTEM-tenant (`00000000-…`) row per canonical serving provider —
 * the platform-default catalog entry recording WHERE a provider lives and (once
 * an admin sets one) HOW to authenticate to it.
 *
 * SEED-AUTHORITATIVE Day-1 posture. The SYSTEM rows — not env
 * are the authoritative default source. Two classes of row:
 *
 *   - BUILT-IN-LOCAL llm engines (`ollama`, `lm-studio`, `built-in`, `vllm`,
 *     `llama-cpp`) seed `enabled: true`, so `resolveConnection('llm', …)` returns
 *     the SYSTEM row Day-1 and env is a pure fallback. Their `baseUrl` is the
 *     platform-run engine's connection identity (env-tier per
 *     `09-infrastructure-devops.md`), carried here as the DECLARED source of
 *     truth — not a placeholder.
 *   - CLOUD-BYO providers (llm `azure`/`bedrock`/`openai`/`anthropic`/`vertex`,
 *     plus all stt/tts cloud rows) stay `enabled: false`: a cloud
 *     provider needs a tenant-supplied key, so an enabled-but-keyless cloud row
 *     must never serve. A tenant enables one by bringing its own credential.
 *
 * KEY MATERIAL — narrowed by Round 4 lane B. No VENDOR credential is
 * ever seeded, and no ciphertext is ever committed to source. But a self-hosted
 * engine row now seeds the non-secret placeholder `not-needed`
 * (`SELF_HOST_PLACEHOLDER_API_KEY`), encrypted at seed time through the same
 * Vault-Transit key the runtime writes with. See "Why a keyless row is not
 * enough" below — without it the row is resolvable but never DELIVERED, and
 * `apps/text` answers 503 for every self-hosted engine.
 *
 * CREATE-ONLY: an existing (tenantId, service, provider) row is NEVER
 * overwritten — the connection is admin-tunable at runtime and a re-seed must
 * not clobber an admin's endpoint or key.
 *
 * UNIFIED PLANE: rows now carry a `service` discriminator. The `llm`
 * service seeds every canonical serving provider (AI_MODEL_PROVIDERS + the new
 * cloud providers anthropic/vertex); `stt` and `tts` seed only their CLOUD
 * providers (self-host STT/TTS engines are not credential-bearing here).
 */

/**
 * Where LM Studio actually listens, for the environment being seeded.
 *
 * The default is the k3s Service name, which is the truth in the cluster and a
 * dead name anywhere else: on a laptop the services run natively and
 * `hope-lmstudio` does not resolve, so `apps/text` answers every generate with
 * a connection error and every LLM-dependent e2e test skips. That was the
 * standing state of the test stack until TASK-869.
 *
 * This is a SEED-TIME input, not runtime config: the row it writes stays the
 * `db-config` source of truth an admin edits afterwards, and the seed is
 * create-only, so an existing endpoint is never clobbered. Same shape as
 * `platformStorageEndpoint()` / `process.env.MINIO_ENDPOINT` in `05b`/`05c`.
 */
function lmStudioBaseUrl(): string {
  return (process.env.SEED_LMSTUDIO_BASE_URL ?? '').trim() || 'http://hope-lmstudio:1234/v1';
}

/**
 * ## Why a keyless row is not enough ( Round 4, lane B)
 *
 * There are TWO ways a connection row reaches a consumer, and they have
 * different requirements. Seeding a row for the wrong one produces a seed that
 * looks correct and silently does nothing.
 *
 * | Path | Who reads it | Keyless row? |
 * |---|---|---|
 * | `provider_overrides` FOLD — `AiProviderConnectionService.resolveTenantCloudOverrides` → `TextRequestEnrichmentService.applyTenantProviderOverrides` → the forwarded request body | `apps/text` (`core/connection.py`), `apps/tts`, the STT config service | **Dropped.** The fold skips `!row.enabled \|\| !row.encryptedApiKey` on BOTH tiers — that guard is what stops a SYSTEM row's `baseUrl` being mistaken for a credential |
 * | `resolveConnection(service, provider, tenantId)` — a direct TypeScript call | nothing in production today | Fine — it returns the row, credential or not |
 *
 * `apps/text` is on the FOLD path: `require_connection()` looks up
 * `provider_overrides[request.provider]` and raises
 * `ProviderConnectionMissingError` → 503 when it is absent, with no env fallback
 * (Phase 2 removed the `TEXT_<PROVIDER>_BASE_URL` plane). So the self-hosted
 * engines it registers — `lm-studio`, `ollama`, `vllm`, `llama-cpp` — must carry
 * key material even though their engines require no auth. The placeholder is
 * literally the value `providers/openai_compat.py` substitutes when the field is
 * empty (`api_key=connection.api_key.get_secret_value() or "not-needed"`).
 *
 * NOT seeded, deliberately: `rerank:tei` and `vector:qdrant`. Their only
 * consumer is `apps/harness`'s retrieval stack, which has NO delivery path for a
 * connection row — it holds no DB handle (so `resolveConnection` is
 * unreachable), it runs inside a Temporal activity (so there is no gateway
 * request to inject into), and `EffectiveConfigResponse` carries no
 * `connections` block. That assessment is recorded at
 * `apps/harness/src/harness/core/config.py` "Why the endpoints below are still
 * env, and stay env", which keeps them env-tier transport addresses. Seeding
 * them here would be the exact silent no-op this section exists to prevent.
 * `embeddings:tei-embed` is the same story on the other side: `apps/text`'s TEI
 * embedding provider IS on the fold path, but no gateway route proxies
 * `POST /embeddings`, so nothing would ever build the override to deliver.
 */

/**
 * The non-secret stand-in a keyless self-hosted engine accepts as an API key.
 *
 * It is NOT a credential and must never be treated as one: it exists only so the
 * override fold has key material to carry, because the fold is the delivery
 * channel and it drops keyless rows by design.
 */
export const SELF_HOST_PLACEHOLDER_API_KEY = 'not-needed';

/**
 * Connections to endpoints the PLATFORM runs itself, as `service:provider` pairs.
 *
 * lane B.2 widened this concept out of the old
 * `service === 'llm' && provider in [...]` form, which conflated "built-in local
 * LLM engine" with "platform-run self-host integration" and so would have
 * misclassified the first `rerank:tei` / `vector:qdrant` row as a cloud row.
 *
 * `vector:qdrant` is the case that proves the two questions are different:
 * `qdrant` IS cloud-BYO eligible (`CLOUD_BYO_PROVIDERS.vector`, so a tenant may
 * point at its own Qdrant Cloud), yet the SYSTEM row is the platform's own
 * cluster. "May a TENANT own a row here?" and "is the PLATFORM's row self-host?"
 * have different answers, so neither can be derived from the other.
 *
 * Pairs with no seeded row today are listed anyway — the list is a CLASSIFIER,
 * not an inventory, and pre-classifying them is what lets a future lane seed one
 * without editing a test.
 */
export const PLATFORM_SELF_HOST_CONNECTIONS = [
  'llm:ollama',
  'llm:lm-studio',
  'llm:built-in',
  'llm:vllm',
  'llm:llama-cpp',
  // Not seeded (see the delivery-path table above) — classified for the lane
  // that eventually gets a delivery path for them.
  'rerank:tei',
  'vector:qdrant',
  'embeddings:tei-embed',
] as const;

/** Whether `(service, provider)` names an endpoint the platform runs itself. */
export const isPlatformSelfHostConnection = (c: { service: string; provider: string }): boolean =>
  (PLATFORM_SELF_HOST_CONNECTIONS as readonly string[]).includes(`${c.service}:${c.provider}`);

/**
 * TASK-879 — the platform's IN-PROCESS engines, as `service:provider` pairs.
 *
 * A third class, and it is not a hair-split. `PLATFORM_SELF_HOST_CONNECTIONS` above names
 * ENDPOINTS the platform runs (an Ollama server, a Qdrant cluster): they have a `baseUrl`, they
 * are reached over the network, and they carry the non-secret `not-needed` placeholder purely so
 * the `provider_overrides` fold — which drops keyless rows — has something to carry. The three
 * engines below run INSIDE `apps/tts`. They have no endpoint, no credential and nothing to
 * inject, so they must never take the placeholder: an entry in the fold would hand the router a
 * per-tenant "override" for an engine that has no override path.
 *
 * Their row exists for exactly ONE fact — MAY this engine serve — which is what
 * `tts.{kokoro,parler,indicf5}.enabled` used to hold in the settings registry, and which the
 * three-state `enabled` says natively. That makes turning an engine on a super-admin write with
 * an audit trail instead of a ConfigMap edit in another repository.
 */
export const PLATFORM_INPROCESS_ENGINE_CONNECTIONS = ['tts:kokoro', 'tts:indic_parler', 'tts:indic_f5'] as const;

/** Whether `(service, provider)` names an engine that runs inside a HOPE service process. */
export const isPlatformInProcessEngineConnection = (c: { service: string; provider: string }): boolean =>
  (PLATFORM_INPROCESS_ENGINE_CONNECTIONS as readonly string[]).includes(`${c.service}:${c.provider}`);

/**
 * lane F — the ONE write this create-only phase makes to an existing row.
 *
 * True only when the seed carries the non-secret self-host placeholder AND the
 * stored row has no key material whatsoever. Rows created before the placeholder
 * existed are keyless, and a keyless row is dropped from the `provider_overrides`
 * fold on BOTH tiers (see this file's delivery-path header) — so the provider
 * silently serves nothing and a re-seed's create-only skip never repairs it.
 *
 * This cannot clobber anything an administrator owns: it writes only where
 * nothing is written, only the constant `'not-needed'`, and only for endpoints
 * the platform itself runs. A CLOUD row's keylessness is a real state (the key
 * is the tenant's to supply), which is why `apiKeyPlaintext === null` returns
 * false rather than being treated as a gap.
 */
export const needsSelfHostKeyBackfill = (
  seedRow: { service: string; provider: string; apiKeyPlaintext: string | null },
  existing: { encryptedApiKey: Uint8Array | null },
): boolean => seedRow.apiKeyPlaintext !== null && isPlatformSelfHostConnection(seedRow) && (existing.encryptedApiKey?.length ?? 0) === 0;

/**
 * The capability discriminator vocabulary a seed row may carry.
 *
 * MIRRORS `@arcaai/applications`
 * `services/ai-provider-connection/constants.ts#PROVIDER_SERVICES`, which is the
 * SOURCE OF TRUTH — it types `ProviderService`, backs the route's `:service`
 * guard and keys `CLOUD_BYO_PROVIDERS`.
 *
 * It is mirrored rather than imported because it CANNOT be imported:
 * `@arcaai/applications` depends on `@arcaai/database`, so importing it here
 * would be a package cycle, and a relative import across the boundary is
 * rejected by this package's `rootDir` (TS6059). The mirror is held in lock-step
 * by `tests/contracts/provider-connection-services.contract.test.ts` — the same
 * mechanism `AI_MODEL_PROVIDERS` and the `ResourceType` enum use for exactly
 * this problem. Widen BOTH lists together, or that contract test fails.
 *
 * The first three are the INFERENCE capabilities; the next three are the
 * non-inference integrations P1-C added so a Qdrant key, a TEI reranker or an
 * embeddings credential has somewhere to live other than an environment
 * variable.
 *
 * `model-registry` is the seventh and serves none of those: it is
 * the plane that authenticates the fetch of MODEL WEIGHTS, and it is where the
 * last two env-resident credentials moved — `HUGGINGFACE_TOKEN` and the
 * `STT_MODEL_S3_*` pair.
 */
export const SEEDABLE_PROVIDER_SERVICES = ['llm', 'stt', 'tts', 'embeddings', 'rerank', 'vector', 'model-registry'] as const;

/** The capability a seeded connection row serves. */
export type SeedableProviderService = (typeof SEEDABLE_PROVIDER_SERVICES)[number];

export interface AiProviderConnectionSeed {
  id: string;
  tenantId: string;
  /**
   * Capability discriminator. Typed against the vocabulary rather than `string`,
   * so a Phase 2 row with a typo (`vectors`) is a COMPILE error instead of a row
   * that silently resolves for nobody.
   */
  service: SeedableProviderService;
  provider: string;
  baseUrl: string | null;
  region: string | null;
  apiVersion: string | null;
  deploymentName: string | null;
  /**
   * Ciphertext is NEVER a literal in this file — it is produced at seed time from
   * `apiKeyPlaintext`. The field stays on the shape so the static tests can keep
   * asserting that no committed row carries key bytes.
   */
  encryptedApiKey: Uint8Array | null;
  keyVersion: number | null;
  /**
   * Per-request timeout ceiling, seconds. `null` = no opinion (the consuming service's own
   * default applies). TASK-879 moved `tts.sarvam.timeoutS` here: a vendor's response budget is a
   * property of the CONNECTION to that vendor, not a service-wide setting key.
   */
  timeoutS?: number | null;
  /**
   * Plaintext to encrypt into `encryptedApiKey` at seed time, or `null` for a
   * genuinely keyless row.
   *
   * The ONLY legal non-null value is `SELF_HOST_PLACEHOLDER_API_KEY` — a vendor
   * credential in a seed would arm the platform-default cascade for every
   * entitled tenant without an admin ever deciding to (see the cloud-BYO tests).
   */
  apiKeyPlaintext: string | null;
  enabled: boolean;
  /**
   * TASK-932 D-7 — provider-specific extras with no dedicated column. The only
   * seeded value today is the weight store's `inheritsPlatformStorage` marker,
   * which is what makes an enabled-and-keyless `model-registry:s3` row resolve
   * to the PLATFORM'S OWN object storage instead of reading as "unconfigured".
   */
  extraJson?: Record<string, boolean | number | string> | null;
  metaData: { placeholder?: boolean; note?: string } | null;
}

/**
 * Deterministic ids — fresh `87000000-…` block (unused by any other seed).
 * Order mirrors `AI_MODEL_PROVIDERS` so the seed-shape test can compare sets.
 */
export const SYSTEM_AI_PROVIDER_CONNECTIONS: AiProviderConnectionSeed[] = [
  {
    // Local/self-host Ollama engine.
    //
    // The provider is selectable but the platform seeds NO Ollama model
    // (owner decision 2026-08-17): this row is the endpoint a
    // tenant inherits or overrides, not a model choice. The tenant supplies
    // the model.
    id: '87000000-0000-0000-0000-000000000001',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: SELF_HOST_PLACEHOLDER_API_KEY,
    enabled: true,
    metaData: { note: 'Ollama endpoint; admin-tunable on this row (db-config tier — there is no env var behind it).' },
  },
  {
    // LM Studio — the platform's default local OpenAI-compatible engine, and
    // since a CONTAINERISED service rather than a developer's desktop
    // app. The address is therefore the k3s Service name, matching every other
    // platform-run self-host engine below (`hope-vllm`, `hope-llama-cpp`) —
    // `http://localhost:1234/v1` described one workstation and could never be
    // right for a cluster.
    //
    // LM Studio has NO headless authentication of any kind: its `/v1` surface
    // accepts any bearer token, including none. `apiKeyPlaintext` is therefore
    // the non-secret `not-needed` PLACEHOLDER (see "Why a keyless row is not
    // enough"), never a credential — the engine's protection is network
    // reachability, not authentication.
    //
    // CREATE-ONLY (see the header): a developer running LM Studio natively keeps
    // whatever endpoint their existing row already carries, and points a fresh
    // dev database at the desktop app by editing the row — the admin action this
    // table exists for — rather than by the seed guessing which host it is on.
    id: '87000000-0000-0000-0000-000000000002',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'lm-studio',
    baseUrl: lmStudioBaseUrl(),
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: SELF_HOST_PLACEHOLDER_API_KEY,
    enabled: true,
    metaData: { note: 'LM Studio k3s Service; admin-tunable on this row (db-config tier — there is no env var behind it).' },
  },
  {
    // Azure OpenAI — endpoint/apiVersion/deployment are per-deployment and
    // blank in `.env.production`; a super admin fills them in.
    id: '87000000-0000-0000-0000-000000000003',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'azure',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },
  {
    // AWS Bedrock — region is deployment-specific; no placeholder invented.
    id: '87000000-0000-0000-0000-000000000004',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'bedrock',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },
  {
    // `built-in` = in-process/bundled models (no remote endpoint at all).
    id: '87000000-0000-0000-0000-000000000005',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'built-in',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: true,
    metaData: null,
  },
  {
    // OpenAI (cloud) — speech-to-text and OpenAI-compatible LLM
    // endpoints. baseUrl blank; a super admin fills it in. NOTE: the public
    // API is not PHI-safe — point at an Azure OpenAI / VPC host before enabling
    // for patient data.
    id: '87000000-0000-0000-0000-000000000009',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'openai',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },
  {
    // vLLM production self-host engine.
    id: '87000000-0000-0000-0000-000000000007',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'vllm',
    baseUrl: 'http://hope-vllm:8000/v1',
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: SELF_HOST_PLACEHOLDER_API_KEY,
    enabled: true,
    metaData: { note: 'vLLM k3s Service; admin-tunable on this row (db-config tier — there is no env var behind it).' },
  },
  {
    // llama.cpp production self-host engine.
    id: '87000000-0000-0000-0000-000000000008',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'llama-cpp',
    baseUrl: 'http://hope-llama-cpp:8080',
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: SELF_HOST_PLACEHOLDER_API_KEY,
    enabled: true,
    metaData: { note: 'llama.cpp k3s Service; admin-tunable on this row (db-config tier — there is no env var behind it).' },
  },

  // ── New LLM cloud providers (freeze; functional in) ──────
  {
    // Anthropic Messages API (cloud). Catalog-only until lands the TEXT
    // adapter. NOTE: the public API is not PHI-safe — route via a compliant
    // endpoint before enabling for patient data.
    id: '87000000-0000-0000-0000-00000000000a',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'anthropic',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },
  {
    // Google Vertex AI (cloud). Catalog-only until lands the TEXT
    // adapter. NOTE: the public API is not PHI-safe — use a compliant project.
    id: '87000000-0000-0000-0000-00000000000b',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'vertex',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },

  // ── STT cloud providers (unified from TenantSttProviderCredential) ─────────
  {
    // Azure Speech / Azure AI Foundry (cloud ASR).
    id: '87000000-0000-0000-0000-0000000000c1',
    tenantId: SYSTEM_TENANT_ID,
    service: 'stt',
    provider: 'azure-speech',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },
  {
    // Azure AI Foundry (MAI-Transcribe) — a SEPARATE row from `azure-speech` since TASK-880.
    // `enabled: false` is the PREVIEW VETO that replaced the platform kill-switch
    // `stt.azureFoundry.enabled`: no entry is folded into `provider_overrides`, so
    // `azure_foundry_loader` refuses to load. A tenant that has signed off on data residency
    // brings its own credential and enables it — per tenant, which a platform boolean could
    // never express. `baseUrl` is the resource endpoint (`https://<res>.cognitiveservices.azure.com`),
    // left null: it is per-deployment and no placeholder is invented.
    id: '87000000-0000-0000-0000-0000000000c4',
    tenantId: SYSTEM_TENANT_ID,
    service: 'stt',
    provider: 'azure-foundry',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },
  {
    // Sarvam ASR (cloud). NOTE: the public API is not PHI-safe.
    id: '87000000-0000-0000-0000-0000000000c2',
    tenantId: SYSTEM_TENANT_ID,
    service: 'stt',
    provider: 'sarvam',
    // `stt.sarvam.baseUrl`'s value (TASK-880): a platform admin who adds a key gets a working row.
    baseUrl: 'https://api.sarvam.ai',
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },
  {
    // OpenAI transcription (cloud). NOTE: the public API is not PHI-safe.
    id: '87000000-0000-0000-0000-0000000000c3',
    tenantId: SYSTEM_TENANT_ID,
    service: 'stt',
    provider: 'openai',
    // `stt.openai.baseUrl`'s value (TASK-880): a platform admin who adds a key gets a working row.
    baseUrl: 'https://api.openai.com/v1',
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },

  // ── TTS cloud providers (unified from TenantTtsProviderCredential) ─────────
  {
    // Azure Speech (cloud TTS). `region` carries what `tts.azure.region` used to: an Azure Speech
    // request is ADDRESSED per region, so it is part of the endpoint — and for a service that
    // synthesises clinical text it is a DATA-RESIDENCY decision, which belongs on the row a
    // super admin edits with an audit trail rather than in an env file.
    id: '87000000-0000-0000-0000-0000000000d1',
    tenantId: SYSTEM_TENANT_ID,
    service: 'tts',
    provider: 'azure',
    baseUrl: null,
    region: 'eastus',
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },
  {
    // Sarvam TTS (cloud). NOTE: the PUBLIC API is not PHI-safe (no BAA, 30-day retention, not
    // India-resident) — point `baseUrl` at the enterprise VPC or on-prem host before enabling it
    // for patient data. `baseUrl` / `timeoutS` carry what `tts.sarvam.baseUrl` /
    // `tts.sarvam.timeoutS` used to; the MODEL id moved to the `sarvam-bulbul` registry row
    // (`sourceUri: 'bulbul:v3'`), because which model answers is a property of the model, not of
    // the connection to the vendor.
    id: '87000000-0000-0000-0000-0000000000d2',
    tenantId: SYSTEM_TENANT_ID,
    service: 'tts',
    provider: 'sarvam',
    baseUrl: 'https://api.sarvam.ai',
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    timeoutS: 30,
    metaData: null,
  },

  // ── TTS in-process engines — the rows that replaced the five `*_ENABLED` flags ─────────────
  //
  // Keyless and endpoint-less on purpose: these engines run inside `apps/tts`, so there is
  // nothing to authenticate to and nothing to inject (see PLATFORM_INPROCESS_ENGINE_CONNECTIONS).
  // The row's whole content is the three-state `enabled`, which the gateway resolves per request
  // into the spec's `connection` block: no enabled row at either tier ⇒ the runtime walks past
  // that candidate, which is exactly what `tts.<engine>.enabled: false` used to mean.
  {
    // Kokoro (English) — the ONE engine seeded ON, and the reason is a real outage: the SYSTEM
    // TTS agent binds it, kokoro ships in the DEFAULT image, and it is what lets a KEYLESS
    // deployment reach `/health/ready` at all. `hope-tts` once answered 503 forever, so its
    // Service carried no endpoints and `TTS_URL` resolved to nothing.
    id: '87000000-0000-0000-0000-0000000000d3',
    tenantId: SYSTEM_TENANT_ID,
    service: 'tts',
    provider: 'kokoro',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: true,
    metaData: null,
  },
  {
    // AI4Bharat Indic Parler (Malayalam). OFF: the weights are large and the `[indic-parler]`
    // image extra is not installed everywhere, so enable it only where the engine is present.
    id: '87000000-0000-0000-0000-0000000000d4',
    tenantId: SYSTEM_TENANT_ID,
    service: 'tts',
    provider: 'indic_parler',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },
  {
    // IndicF5 voice clone — LICENCE-GATED, and this row is the gate. Production and commercial
    // enablement are NO-GO pending licence review: the released weights are a fine-tune of the
    // CC-BY-NC SWivid F5-TTS base, and the MIT tag cannot override NonCommercial. That used to be
    // enforced by a code comment, then by a locked settings row; it is now a SUPER_ADMIN write on
    // a connection row, audited like every other one.
    id: '87000000-0000-0000-0000-0000000000d5',
    tenantId: SYSTEM_TENANT_ID,
    service: 'tts',
    provider: 'indic_f5',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },

  // ── model-registry: the weight-fetch plane ─────────────────────
  //
  // Both rows are seeded BLANK, and no VENDOR credential is ever seeded: a super
  // admin pastes a token through the console and the row becomes live at that
  // moment — no redeploy, no env var, no secret in this file. Seeding a real
  // token here would arm the platform-default cascade for every entitled tenant
  // without an administrator ever deciding to.
  //
  // TASK-932 R-11/D-7 changed the ENABLED state, and only that. Both rows now
  // seed ENABLED, because on a PLATFORM-MANAGED plane "blank" is a configured
  // state rather than an absence:
  //   * `s3` carries `inheritsPlatformStorage`, and resolves to the platform's
  //     own object storage (the SYSTEM `TenantStorageConfig` cascade) — which is
  //     where `hope-models` actually lives. Seeded DISABLED, the console
  //     rendered the platform's own weight store as "no key · Disabled for this
  //     tenant": tenant wording on a platform row, about the thing every model
  //     fetch depends on.
  //   * `huggingface` blank means an ANONYMOUS pull, which is the correct
  //     resolved state for a public repo (`apps/stt`'s `absent` outcome). A
  //     token is what upgrades that to a gated repo.
  // Disabling either row is still the platform's own veto, and still means
  // "fail closed"; it is simply no longer the shipped state.
  //
  // These two rows are the ONLY ones that can exist on this plane: owner ruling
  // 2026-08-24 made `model-registry` platform-managed, so `CLOUD_BYO_PROVIDERS`
  // lists no tenant-writable provider under it and a tenant row is a 403. Every
  // weight fetch, for every tenant, spends the credential configured here.
  {
    // HuggingFace Hub. `extraJson.model` names the repo explicitly (there is no
    // discovery here); the token is what distinguishes an entitled pull of a
    // gated repo from an anonymous one. Replaces the `HUGGINGFACE_TOKEN` env var.
    id: '87000000-0000-0000-0000-0000000000e1',
    tenantId: SYSTEM_TENANT_ID,
    service: 'model-registry',
    provider: 'huggingface',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: true,
    metaData: { note: 'Platform HuggingFace Hub token. Blank until a super admin supplies one; anonymous pulls still work for public repos.' },
  },
  {
    // MinIO/S3 weights bucket. The credential is a PAIR: the secret half is the
    // encrypted key, and the non-secret principal id rides in
    // `extraJson.accessKeyId` — the `ServiceAccount.clientId` precedent.
    // Replaces the `STT_MODEL_S3_ACCESS_KEY` / `_SECRET_KEY` env vars.
    id: '87000000-0000-0000-0000-0000000000e2',
    tenantId: SYSTEM_TENANT_ID,
    service: 'model-registry',
    provider: 's3',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: true,
    extraJson: { inheritsPlatformStorage: true },
    metaData: {
      note:
        'Platform model-weights object store. Blank + inheritsPlatformStorage = the platform storage credentials serve it ' +
        '(TASK-932 D-7). To point it elsewhere, set baseUrl = endpoint, accessKeyId in extraJson and paste the secret key.',
    },
  },
];

/**
 * Compile-time guard: the LLM service must cover every canonical serving
 * provider. Scoped to `service === 'llm'` under the unified plane
 * the STT/TTS catalog rows are cloud-only and additive. Kept as a type-level
 * assertion so adding a provider to `AI_MODEL_PROVIDERS` without an `llm` seed
 * row fails the build, not just the test.
 */
const _llmProviderCoverage: Record<(typeof AI_MODEL_PROVIDERS)[number], true> = Object.fromEntries(
  SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => c.service === 'llm').map((c) => [c.provider, true]),
) as Record<(typeof AI_MODEL_PROVIDERS)[number], true>;
void _llmProviderCoverage;

export const seedAiProviderConnection = async (client: CorePrismaClient): Promise<{ success: true; created: number; skipped: number }> => {
  console.log('Seeding SYSTEM AiProviderConnection rows ...');

  // A row that declares key material and cannot get it seeds keyless — and a
  // keyless row is DROPPED by the override fold, so `apps/text` will answer 503
  // for every self-hosted engine. That is the correct outcome (the runtime
  // resolver is equally inert without Vault: no SecretsService means no
  // overrides at all), but it must be VISIBLE rather than discovered as a 503.
  const canEncrypt = isSeedSecretEncryptionAvailable();
  if (!canEncrypt) {
    console.warn(
      '  SECRETS_PROVIDER != vault — self-hosted engine rows will seed WITHOUT key material. ' +
        'The provider_overrides fold drops keyless rows, so apps/text will 503 until Vault is configured and the seed re-run.',
    );
  }

  let created = 0;
  let skipped = 0;
  let backfilled = 0;
  for (const row of SYSTEM_AI_PROVIDER_CONNECTIONS) {
    const existing = await client.aiProviderConnection.findFirst({
      where: { tenantId: row.tenantId, service: row.service, provider: row.provider },
    });

    if (existing) {
      // CREATE-ONLY — never clobber an admin-configured endpoint or key. The
      // single exception is repairing a self-host row that has NO key at all:
      // such a row is dropped from `provider_overrides` and therefore serves
      // nothing, and the value written is the non-secret placeholder, so there
      // is nothing an admin could have chosen that this overwrites.
      if (needsSelfHostKeyBackfill(row, existing)) {
        const backfill = row.apiKeyPlaintext ? await encryptSeedSecret(row.apiKeyPlaintext) : null;
        if (backfill) {
          await client.aiProviderConnection.update({
            where: { id: existing.id },
            data: { encryptedApiKey: Uint8Array.from(backfill.ciphertext), keyVersion: backfill.keyVersion },
          });
          console.log(`  AiProviderConnection "${row.service}:${row.provider}" exists but was KEYLESS — backfilled the self-host placeholder`);
          backfilled += 1;
          continue;
        }
        console.warn(
          `  ⚠️  AiProviderConnection "${row.service}:${row.provider}" is KEYLESS and could not be repaired ` +
            '(Vault Transit unavailable, so the placeholder could not be encrypted). It will not appear in provider_overrides.',
        );
      }
      console.log(`  AiProviderConnection "${row.service}:${row.provider}" exists — KEPT AS IS, not updated from the seed`);
      skipped += 1;
      continue;
    }

    // Encrypt the (non-secret) placeholder through the SAME Vault-Transit key the
    // runtime writes with, so `toOverrideEntry`'s decrypt round-trips. `null`
    // when Vault is absent — the row is then created keyless, as before.
    const key = row.apiKeyPlaintext ? await encryptSeedSecret(row.apiKeyPlaintext) : null;

    console.log(
      `  Creating AiProviderConnection "${row.service}:${row.provider}" ` +
        `(${row.enabled ? 'enabled' : 'disabled'}${key ? ', keyed' : ''})`,
    );
    await client.aiProviderConnection.create({
      data: {
        id: row.id,
        tenantId: row.tenantId,
        service: row.service,
        provider: row.provider,
        baseUrl: row.baseUrl,
        region: row.region,
        apiVersion: row.apiVersion,
        deploymentName: row.deploymentName,
        enabled: row.enabled,
        ...(row.timeoutS !== undefined && row.timeoutS !== null ? { timeoutS: row.timeoutS } : {}),
        ...(row.extraJson ? { extraJson: row.extraJson } : {}),
        // Conditional spread, not `?? undefined` — the repo compiles
        // with `exactOptionalPropertyTypes`, so an explicit `undefined`
        // is not assignable to Prisma's JSON input type.
        ...(row.metaData ? { metaData: row.metaData } : {}),
        ...(key
          ? {
              // `Uint8Array.from`, not the Buffer itself: Prisma's `Bytes` input is
              // `Uint8Array<ArrayBuffer>` and Node's Buffer widens to `ArrayBufferLike`,
              // which `exactOptionalPropertyTypes` rejects.
              encryptedApiKey: Uint8Array.from(key.ciphertext),
              keyVersion: key.keyVersion,
            }
          : {}),
        createdBy: SYSTEM_USER_ID,
      },
    });
    created += 1;
  }

  console.log(`Seeded AiProviderConnection: ${created} created, ${backfilled} key-backfilled, ${skipped} skipped`);
  if (skipped > 0) {
    console.warn(
      `⚠️  ${skipped} AiProviderConnection row(s) already existed and were NOT UPDATED — baseUrl, region, enabled and any ` +
        'vendor key were left exactly as stored. This phase is create-only by design: a re-seed must never clobber a ' +
        "tenant's BYO credential or an admin's endpoint. If you expected the seed to change one, it did not — edit it " +
        'through the admin API, or delete the row first and re-seed.',
    );
  }
  return { success: true, created, skipped };
};
