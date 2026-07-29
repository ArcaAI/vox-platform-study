/**
 * Provider-connection governance vocabulary (UNIFIED plane — TASK-569, C5).
 *
 * The connection plane is keyed by (tenant, SERVICE, provider). `service` is the
 * capability discriminator; `provider` is capability-scoped (the same name can
 * mean different providers under different services — `azure` = Azure OpenAI
 * under `llm`, Azure Speech under `stt`).
 *
 * Extension recipe: a new serving provider becomes tenant-BYO-eligible ONLY by
 * being listed under its service below — the default is SYSTEM-only.
 */

/** The capability a connection row serves. Validated string, no Prisma enum. */
export type ProviderService = 'llm' | 'stt' | 'tts';

/** All three services, for iteration/validation. */
export const PROVIDER_SERVICES = ['llm', 'stt', 'tts'] as const;

/**
 * C5 — the per-service governance map. A TENANT may hold its own connection row
 * (bring-your-own cloud credentials) only for a provider listed under its
 * service; everything else is a self-host engine whose endpoint is platform
 * infrastructure, so its connection is SYSTEM-tenant-only.
 *
 * Attempting a tenant row for a non-listed (service, provider) is a PRIVILEGE
 * boundary on the caller's own tenant — 403, NOT the 404-over-403 cross-tenant
 * posture. Same reasoning as `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` in
 * `ai-task-default`.
 *
 * NOTE: the three new LLM entries (`openai`, `anthropic`, `vertex`) are frozen
 * here at unification time but only become functional when TASK-572 lands their
 * SMR adapters + seed rows.
 */
export const CLOUD_BYO_PROVIDERS: Record<ProviderService, readonly string[]> = {
  llm: ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
  stt: ['azure-speech', 'sarvam', 'openai'],
  tts: ['azure', 'sarvam'],
};

/** The union of every cloud BYO provider name across all services. */
export type CloudByoProvider = (typeof CLOUD_BYO_PROVIDERS)[ProviderService][number];

/**
 * Whether a tenant may hold its own connection row for `(service, provider)`.
 *
 * The 1-arg form is a `@deprecated` transition shim that assumes `service='llm'`
 * so the (TASK-572-owned) `smr-proxy.controller` keeps compiling until it
 * repoints to the service-first form; do not use it in new code.
 */
export function isCloudByoProvider(service: ProviderService, provider: string): boolean;
/** @deprecated 1-arg form assumes `service='llm'`; kept for the smr-proxy transition (TASK-572 removes it). */
export function isCloudByoProvider(provider: string): boolean;
export function isCloudByoProvider(a: string, b?: string): boolean {
  const service = (b === undefined ? 'llm' : a) as ProviderService;
  const provider = b === undefined ? a : b;
  return (CLOUD_BYO_PROVIDERS[service] ?? []).includes(provider);
}
