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

export interface ProviderMeta {
  id: string;
  label: string;
  fields: readonly ProviderField[];
  /** Overrides for the secret input (Vertex uploads a service-account JSON, not a key). */
  keyLabel?: string;
  keyPlaceholder?: string;
}

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

/** STT tab — mirrors `CLOUD_BYO_PROVIDERS.stt`. */
const STT_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'azure-speech',
    label: 'Azure Speech',
    fields: [
      { name: 'region', label: 'Region', placeholder: 'eastus' },
      { name: 'baseUrl', label: 'Custom endpoint (optional)', placeholder: 'https://<region>.api.cognitive.microsoft.com' },
      { name: 'model', label: 'Model (optional)', placeholder: 'mai-transcribe-1.5', store: 'extra' },
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
    fields: [
      { name: 'baseUrl', label: 'Endpoint (Foundry resource)', placeholder: 'https://<resource>.cognitiveservices.azure.com' },
      { name: 'model', label: 'Model (optional)', placeholder: 'mai-transcribe-1.5', store: 'extra' },
    ],
  },
  {
    id: 'sarvam',
    label: 'Sarvam',
    fields: [{ name: 'model', label: 'Model (optional)', placeholder: 'saaras:v4', store: 'extra' }],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    fields: [
      { name: 'baseUrl', label: 'Base URL (optional)', placeholder: 'https://api.openai.com/v1' },
      { name: 'model', label: 'Model (optional)', placeholder: 'gpt-4o-transcribe', store: 'extra' },
    ],
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
    keyLabel: 'Access token',
    keyPlaceholder: 'hf_…',
    fields: [{ name: 'model', label: 'Model id (org/repo)', placeholder: 'openai/whisper-large-v3', store: 'extra' }],
  },
  {
    id: 's3',
    label: 'S3 / MinIO weight store',
    // An S3 credential is a PAIR: the SECRET half is the encrypted key, and the
    // non-secret principal id rides in extras (the ServiceAccount.clientId
    // precedent). Neither half alone can sign a request.
    keyLabel: 'Secret access key',
    keyPlaceholder: 'S3 secret access key',
    fields: [
      { name: 'baseUrl', label: 'Endpoint', placeholder: 'https://s3.us-east-1.amazonaws.com' },
      { name: 'accessKeyId', label: 'Access key id', placeholder: 'AKIA…', store: 'extra' },
    ],
  },
];

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
