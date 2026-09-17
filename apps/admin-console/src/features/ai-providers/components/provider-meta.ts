import type { ProviderService } from '../api/types';

/**
 * One editable text field on a provider card. Most map 1:1 to a connection
 * column (`store: 'column'`, the default — one of `baseUrl` | `region` |
 * `apiVersion` | `deploymentName`); a field with `store: 'extra'` writes into
 * `extraJson[name]` instead (an STT model override, a Vertex GCP project —
 * the connection table has no dedicated column for provider-specific extras).
 */
export interface ProviderField {
  name: string;
  label: string;
  placeholder: string;
  store?: 'column' | 'extra';
}

/**
 * HOW a provider is served, which decides WHO sees its card and what the card
 * is allowed to say. Mirrors `ProviderClass` in @arcaai/applications
 * (`ai-provider-connection/constants.ts`), minus `cloud-platform` — that is not
 * a property of the PROVIDER, it is what a `cloud-byo` provider becomes when the
 * row happens to be the SYSTEM one, and the tier already tells us that.
 *
 *   `cloud-byo`     a vendor account a tenant can bring. Rendered on BOTH tiers:
 *                   the tenant's own key, or the platform default it inherits.
 *   `engine-served` an inference engine the platform RUNS. Platform tier only.
 *   `built-in`      the platform's weight-fetch plane (`model-registry`).
 *                   Platform tier only.
 */
export type ProviderCardClass = 'cloud-byo' | 'engine-served' | 'built-in';

export interface ProviderMeta {
  id: string;
  label: string;
  fields: readonly ProviderField[];
  /** Defaults to `cloud-byo` — the class every card had before TASK-932. */
  providerClass?: ProviderCardClass;
  /** Overrides for the secret input (Vertex uploads a service-account JSON, not a key). */
  keyLabel?: string;
  keyPlaceholder?: string;
  /** One line under the title, for a card whose purpose is not self-evident. */
  hint?: string;
}

/**
 * TASK-932 R-3 — the BUILT-IN inference services, and the reason this list did
 * not exist before.
 *
 * These four engines have always had SYSTEM `AiProviderConnection` rows (the
 * seed writes them, `apps/text` resolves its base URL from them, and a deleted
 * row is a 503) — but no card, because `PROVIDERS_BY_SERVICE` mirrored
 * `CLOUD_BYO_PROVIDERS`, which lists exactly what a TENANT may bring. So the
 * endpoints an operator most needs to change were writable over HTTP and
 * unreachable from the console: to point LM Studio at a laptop you re-seeded the
 * database. They are PLATFORM-TIER ONLY (the gateway 403s a tenant write and
 * 404s a tenant read), which is why they live in their own list rather than
 * being folded into the service map above.
 *
 * `built-in` (in-process, no endpoint) is deliberately absent: it has a
 * connection row for classification purposes, and no address to configure.
 */
const BUILT_IN_ENGINE_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'lm-studio',
    label: 'LM Studio',
    providerClass: 'engine-served',
    hint: 'OpenAI-compatible local server. Running it on your workstation? Point this at http://localhost:1234/v1.',
    keyLabel: 'API key (optional)',
    keyPlaceholder: 'LM Studio accepts any token — leave blank',
    fields: [{ name: 'baseUrl', label: 'Endpoint', placeholder: 'http://hope-lmstudio:1234/v1' }],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    providerClass: 'engine-served',
    hint: 'Runs beside the node rather than as a cluster service.',
    keyLabel: 'API key (optional)',
    keyPlaceholder: 'Ollama needs none — leave blank',
    fields: [{ name: 'baseUrl', label: 'Endpoint', placeholder: 'http://localhost:11434' }],
  },
  {
    id: 'vllm',
    label: 'vLLM',
    providerClass: 'engine-served',
    keyLabel: 'API key (optional)',
    keyPlaceholder: 'Leave blank unless the server enforces one',
    fields: [{ name: 'baseUrl', label: 'Endpoint', placeholder: 'http://hope-vllm:8000/v1' }],
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp',
    providerClass: 'engine-served',
    hint: 'Serves ONE model chosen at load time, so the weights must be named as well as the endpoint.',
    keyLabel: 'API key (optional)',
    keyPlaceholder: 'Leave blank unless the server enforces one',
    fields: [
      { name: 'baseUrl', label: 'Endpoint', placeholder: 'http://hope-llama-cpp:8080' },
      { name: 'modelPath', label: 'Model path or URL', placeholder: '/models/…  or  s3://hope-models/…', store: 'extra' },
    ],
  },
];

/**
 * TASK-952 D-1c — the PLATFORM's own dense-embeddings server.
 *
 * It mirrors `PLATFORM_SELF_HOST_PROVIDERS` in @arcaai/applications, which is a
 * DIFFERENT gateway list from `ENGINE_SERVED_PROVIDERS` above: both are
 * platform-tier-only, but the engines there serve LLM completions and this one
 * serves embeddings, and the two are governed by separate constants. Hence its
 * own list rather than an entry in `BUILT_IN_ENGINE_PROVIDERS`.
 *
 * Both fields are REQUIRED by `PROVIDER_REQUIREMENTS['embeddings:tei-embed']`,
 * and the model one is load-bearing: the harness retired its hardcoded
 * `text-embedding-bge-m3` default, so this row is the only place the platform's
 * embeddings model id lives. Blank it and retrieval degrades to empty context.
 *
 * The three `tts` in-process engines are the other `PLATFORM_SELF_HOST_PROVIDERS`
 * entries and deliberately have NO card — they run inside `apps/tts` with no
 * endpoint and no credential, so there is nothing on a card to configure (the
 * same reason `built-in` has none).
 */
const BUILT_IN_EMBEDDINGS_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'tei-embed',
    label: 'TEI embeddings',
    providerClass: 'engine-served',
    hint: 'The platform’s own dense-embeddings server (HuggingFace text-embeddings-inference). It serves ONE model, so name it here — the harness has no default.',
    keyLabel: 'API key (optional)',
    keyPlaceholder: 'TEI needs none — leave blank',
    fields: [
      { name: 'baseUrl', label: 'Endpoint', placeholder: 'http://localhost:8871/v1' },
      { name: 'model', label: 'Model id', placeholder: 'BAAI/bge-m3', store: 'extra' },
    ],
  },
];

/** LLM tab — mirrors `CLOUD_BYO_PROVIDERS.llm`. */
const LLM_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'azure',
    label: 'Azure OpenAI',
    fields: [
      { name: 'baseUrl', label: 'Endpoint', placeholder: 'https://<resource>.openai.azure.com' },
      { name: 'apiVersion', label: 'API version', placeholder: '2024-10-21' },
      { name: 'deploymentName', label: 'Deployment name', placeholder: 'gpt-4o-mini' },
    ],
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    fields: [{ name: 'region', label: 'Region', placeholder: 'us-east-1' }],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    fields: [{ name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1' }],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    fields: [{ name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.anthropic.com' }],
  },
  {
    id: 'vertex',
    label: 'Google Vertex AI',
    keyLabel: 'Service account JSON',
    keyPlaceholder: 'Paste the service-account key JSON',
    fields: [
      { name: 'project', label: 'Project', placeholder: 'my-gcp-project', store: 'extra' },
      { name: 'region', label: 'Location', placeholder: 'us-central1' },
    ],
  },
];

/**
 * STT tab — mirrors `CLOUD_BYO_PROVIDERS.stt`.
 *
 * TASK-952 D-1: none of these four cards offers a `model` extras field any
 * more. Azure Speech and Azure Foundry never read one at all —
 * `azure_foundry_loader.py:105` resolves the model from the bound `AiModel`
 * row's `source_uri` and fails closed by design, so the field was a pin with
 * nowhere to land. Sarvam and OpenAI DID read theirs
 * (`sarvam_loader.py:80`, `openai_loader.py:76`:
 * `override.get('model') or model_name`), but as an OVERRIDE-WINS global pin
 * that silently overrode whatever model the agent had bound — model identity
 * is `AiModel`, declared against the connection and bound to an agent by FK
 * (`connection-models-editor.tsx`, TASK-890 §3.1), not a value to re-type
 * into a text box here. The `extraJson.model` column and the gateway API are
 * unchanged and still accept the key; only this console stops offering the
 * pin.
 *
 * TASK-983 R2 corrects what that left behind. Removing Sarvam's only field made
 * its card `fields: []`, and the card then had nowhere to type the ONE value the
 * runtime cannot start without: TASK-880 deleted the `stt.sarvam.baseUrl` /
 * `stt.openai.baseUrl` platform settings and moved the endpoint onto the
 * connection ROW, where `sarvam_loader.py` and `openai_loader.py` both refuse to
 * load without it. So every CLOUD card here declares `baseUrl`, and none of them
 * calls it optional — `PROVIDER_REQUIREMENTS` refuses an enabled row without one.
 * (`azure-speech` is the exception that proves it: Speech is addressed by REGION,
 * and its endpoint really is an optional override.)
 */
const STT_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'azure-speech',
    label: 'Azure Speech',
    fields: [
      { name: 'region', label: 'Region', placeholder: 'eastus' },
      { name: 'baseUrl', label: 'Custom endpoint (optional)', placeholder: 'https://<region>.api.cognitive.microsoft.com' },
    ],
  },
  {
    // SEPARATE from `azure-speech` on purpose (TASK-880): a Foundry resource IS
    // an Azure Speech resource, but the two have different data-residency
    // postures, and one credential gating both meant a tenant could not enable
    // Speech without also enabling a PREVIEW service for its PHI. The gateway
    // has always accepted this row; it had no card until now.
    id: 'azure-foundry',
    label: 'Azure AI Foundry',
    fields: [{ name: 'baseUrl', label: 'Endpoint (Foundry resource)', placeholder: 'https://<resource>.cognitiveservices.azure.com' }],
  },
  {
    id: 'sarvam',
    label: 'Sarvam',
    hint: 'The public api.sarvam.ai carries no BAA and is not PHI-safe — point this at your enterprise Sarvam endpoint.',
    fields: [{ name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.sarvam.ai' }],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    fields: [{ name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1' }],
  },
];

/** TTS tab — mirrors `CLOUD_BYO_PROVIDERS.tts`. */
const TTS_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'azure',
    label: 'Azure Speech',
    fields: [{ name: 'region', label: 'Region', placeholder: 'eastus' }],
  },
  {
    id: 'sarvam',
    label: 'Sarvam',
    fields: [{ name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.sarvam.ai' }],
  },
];

/**
 * Embeddings tab — mirrors `CLOUD_BYO_PROVIDERS.embeddings`. The same Azure /
 * OpenAI accounts that already back `llm`, but a SEPARATE connection row:
 * `provider` is capability-scoped, so a tenant may bring one vendor for
 * generation and another (or none) for embeddings.
 */
const EMBEDDINGS_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'azure',
    label: 'Azure OpenAI',
    fields: [
      { name: 'baseUrl', label: 'Endpoint', placeholder: 'https://<resource>.openai.azure.com' },
      { name: 'apiVersion', label: 'API version', placeholder: '2024-10-21' },
      { name: 'deploymentName', label: 'Deployment name', placeholder: 'text-embedding-3-large' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    fields: [
      { name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1' },
      { name: 'model', label: 'Model (optional)', placeholder: 'text-embedding-3-small', store: 'extra' },
    ],
  },
];

/**
 * Rerank tab — DELIBERATELY EMPTY, mirroring `CLOUD_BYO_PROVIDERS.rerank`.
 *
 * The only reranker is the self-hosted TEI service, which is platform
 * INFRASTRUCTURE: there is no cloud rerank adapter for a tenant to bring a key
 * to, so a tenant row is refused 403 and only the SYSTEM connection serves. The
 * tab still exists rather than being hidden — the capability is real, and an
 * admin looking for it deserves the reason instead of a missing tab.
 */
const RERANK_PROVIDERS: readonly ProviderMeta[] = [];

/**
 * Vector tab — mirrors `CLOUD_BYO_PROVIDERS.vector`. Qdrant Cloud is a genuine
 * per-tenant subscription, so a tenant may point the plane at its own cluster.
 */
const VECTOR_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'qdrant',
    label: 'Qdrant Cloud',
    keyLabel: 'API key',
    keyPlaceholder: 'Qdrant Cloud API key',
    fields: [
      { name: 'baseUrl', label: 'Cluster URL', placeholder: 'https://<cluster>.qdrant.io:6333' },
      { name: 'collection', label: 'Collection prefix (optional)', placeholder: 'hope', store: 'extra' },
    ],
  },
];

/**
 * Model-registry tab — the weight-FETCH plane, not an inference capability.
 * Both entries are SYSTEM-only (`CLOUD_BYO_PROVIDERS['model-registry']` is
 * empty), so these cards are reachable by a platform super admin and 403 for a
 * tenant admin — the same shape as `rerank`. Field lists mirror
 * `PROVIDER_REQUIREMENTS['model-registry:*']` in @arcaai/applications.
 */
const MODEL_REGISTRY_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'huggingface',
    label: 'Hugging Face Hub',
    providerClass: 'built-in',
    hint: 'Blank pulls public repos anonymously. A token is what reaches a gated repo.',
    keyLabel: 'Access token',
    keyPlaceholder: 'hf_…',
    fields: [{ name: 'model', label: 'Model id (org/repo)', placeholder: 'openai/whisper-large-v3', store: 'extra' }],
  },
  {
    id: 's3',
    label: 'S3 / MinIO weight store',
    providerClass: 'built-in',
    hint: 'Left blank, this is the platform’s own object storage — the endpoint and key pair come from the platform storage configuration.',
    // An S3 credential is a PAIR: the SECRET half is the encrypted key, and the
    // non-secret principal id rides in extras (the ServiceAccount.clientId
    // precedent). Neither half alone can sign a request.
    keyLabel: 'Secret access key',
    keyPlaceholder: 'Leave blank to use the platform storage credentials',
    fields: [
      { name: 'baseUrl', label: 'Endpoint', placeholder: 'Leave blank for the platform’s own storage' },
      { name: 'accessKeyId', label: 'Access key id', placeholder: 'Leave blank for the platform’s own storage', store: 'extra' },
    ],
  },
];

/**
 * The PLATFORM-managed engine cards, per service (TASK-932). Rendered only on
 * the platform tier; a service with no entry runs no engine of its own.
 */
export const BUILT_IN_PROVIDERS_BY_SERVICE: Partial<Record<ProviderService, readonly ProviderMeta[]>> = {
  llm: BUILT_IN_ENGINE_PROVIDERS,
  embeddings: BUILT_IN_EMBEDDINGS_PROVIDERS,
};

/** Per-service provider metadata, keyed to drive each tab's credential grid. */
export const PROVIDERS_BY_SERVICE: Record<ProviderService, readonly ProviderMeta[]> = {
  llm: LLM_PROVIDERS,
  stt: STT_PROVIDERS,
  tts: TTS_PROVIDERS,
  embeddings: EMBEDDINGS_PROVIDERS,
  rerank: RERANK_PROVIDERS,
  vector: VECTOR_PROVIDERS,
  'model-registry': MODEL_REGISTRY_PROVIDERS,
};

/** The class of one card, with the historical default applied. */
export function classOf(meta: ProviderMeta): ProviderCardClass {
  return meta.providerClass ?? 'cloud-byo';
}

/**
 * The CLOUD VENDOR cards for one service — the ones that mean "a tenant's own
 * account" on the tenant tier and "the platform default a tenant inherits" on
 * the platform tier. The same list either way; only the wording differs, which
 * is `ProviderCredentialCard`'s job, not this one's.
 *
 * The platform-managed cards (the built-in engines, the two model-registry
 * rows) are deliberately NOT here: they belong to their own sections on the
 * platform screen, and a customer tenant may not see them at all — the gateway
 * now 404s a tenant read of one (TASK-932 R-12), so listing them under a tenant
 * tab would render two cards whose every request fails.
 */
export function cloudProvidersFor(service: ProviderService): readonly ProviderMeta[] {
  return PROVIDERS_BY_SERVICE[service].filter((meta) => classOf(meta) === 'cloud-byo');
}

/** Services with at least one cloud vendor card — the rest get no tab at all. */
export function cloudConfigurableServices(services: readonly ProviderService[]): readonly ProviderService[] {
  return services.filter((service) => cloudProvidersFor(service).length > 0);
}

/**
 * The built-in inference engines the PLATFORM runs, for the `llm` service.
 *
 * Kept as the `llm`-only list because that is what it mirrors on the gateway
 * (`ENGINE_SERVED_PROVIDERS`). Render from `BUILT_IN_PROVIDER_ENTRIES` below,
 * not from this — a card has to be written against its OWN service, and this one
 * was previously rendered under a hardcoded `service="llm"`.
 */
export const BUILT_IN_ENGINE_CARDS: readonly ProviderMeta[] = BUILT_IN_ENGINE_PROVIDERS;

/**
 * Every platform-managed inference card, PAIRED WITH ITS SERVICE (TASK-952 D-1c).
 *
 * The platform screen used to map `BUILT_IN_ENGINE_CARDS` under a literal
 * `service="llm"`, which silently made "platform-managed" and "an LLM engine"
 * the same thing. They are not: `embeddings:tei-embed` is platform-managed too,
 * and writing it to `llm:tei-embed` would create a row nothing resolves.
 */
export const BUILT_IN_PROVIDER_ENTRIES: readonly { service: ProviderService; meta: ProviderMeta }[] = (
  Object.entries(BUILT_IN_PROVIDERS_BY_SERVICE) as [ProviderService, readonly ProviderMeta[]][]
).flatMap(([service, metas]) => metas.map((meta) => ({ service, meta })));

/** The built-in weight-fetch plane (`model-registry`), platform tier only. */
export const MODEL_REGISTRY_CARDS: readonly ProviderMeta[] = MODEL_REGISTRY_PROVIDERS;
