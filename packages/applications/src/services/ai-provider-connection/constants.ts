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
 * TASK-799 P1-C.1 — the first three are INFERENCE capabilities; the last three
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
 */
export type ProviderService = 'llm' | 'stt' | 'tts' | 'embeddings' | 'rerank' | 'vector';

/** Every service, for iteration/validation (the route's `:service` guard reads this). */
export const PROVIDER_SERVICES = ['llm', 'stt', 'tts', 'embeddings', 'rerank', 'vector'] as const;

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
 * NOTE: the three new LLM entries (`openai`, `anthropic`, `vertex`) are frozen
 * here at unification time but only become functional when that lands their
 * TEXT adapters + seed rows.
 */
export const CLOUD_BYO_PROVIDERS: Record<ProviderService, readonly string[]> = {
  llm: ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
  stt: ['azure-speech', 'sarvam', 'openai'],
  tts: ['azure', 'sarvam'],
  // TASK-799 P1-C.1 — the integration capabilities. Each list is EVIDENCE-BASED,
  // not aspirational: a provider is listed only where a tenant can genuinely
  // hold its own vendor account today.
  //   `embeddings` — the same Azure/OpenAI accounts that already back `llm`.
  //   `rerank`     — DELIBERATELY EMPTY. The only reranker is the self-hosted TEI
  //                  service, which is platform INFRASTRUCTURE; there is no cloud
  //                  rerank adapter for a tenant to bring a key to. A tenant row
  //                  is therefore a 403 and only the SYSTEM row serves. This list
  //                  is the extension point when that changes.
  //   `vector`     — Qdrant Cloud is a real per-tenant subscription, so a tenant
  //                  may point the plane at its own cluster with its own key.
  embeddings: ['azure', 'openai'],
  rerank: [],
  vector: ['qdrant'],
};

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
