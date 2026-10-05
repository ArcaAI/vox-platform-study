import type { ProviderLocality } from '@arcaai/types';
import { ENGINE_SERVED_PROVIDERS, PLATFORM_SELF_HOST_MODEL_PROVIDER } from '../ai-provider-connection/constants';

/**
 * Vendor providers whose calls ALWAYS leave the platform. Mirrors `apps/text`'s own list (the
 * receiving half refuses a `local` stamp for any of them), and is applied here too so the gateway
 * never asks for a downgrade a row's `deploymentKind` might wrongly suggest.
 */
export const KNOWN_CLOUD_PROVIDERS: readonly string[] = Object.freeze([
  'azure',
  'azure-openai',
  'bedrock',
  'openai',
  'anthropic',
  'vertex',
  'google',
  'gemini',
  'mistral',
  'cohere',
  'groq',
  'together',
  'openrouter',
]);

const CLOUD = new Set(KNOWN_CLOUD_PROVIDERS);
const LOCAL_WITHOUT_ROW = new Set([...ENGINE_SERVED_PROVIDERS, PLATFORM_SELF_HOST_MODEL_PROVIDER]);

/**
 * The egress locality of ONE provider call, or `undefined` when the gateway cannot say.
 *
 *   1. A known cloud provider name is `cloud`, whatever the row says.
 *   2. The resolved `AiModel.deploymentKind`: `SELF_HOSTED` ⇒ `local`; `CLOUD` / `BYOK` ⇒ `cloud`.
 *   3. No row: an engine-served provider (LM Studio, Ollama, vLLM, llama.cpp) or the platform's
 *      `built-in` services ⇒ `local`.
 *   4. Otherwise `undefined` — the stamp is OMITTED and `apps/text` fails closed to `cloud`.
 */
export function providerLocality(provider: string, deploymentKind?: string | null): ProviderLocality | undefined {
  const name = provider.trim().toLowerCase();
  if (CLOUD.has(name)) return 'cloud';
  if (deploymentKind === 'SELF_HOSTED') return 'local';
  if (deploymentKind === 'CLOUD' || deploymentKind === 'BYOK') return 'cloud';
  if (LOCAL_WITHOUT_ROW.has(name)) return 'local';
  return undefined;
}

/** What a caller knows about the rows behind the providers on a `/generate` body. */
export interface ProviderLocalityHints {
  /** `AiModel.deploymentKind` of the row serving `provider`. */
  deploymentKind?: string | null;
  /** `AiModel.deploymentKind` of the row serving `fallback_provider`. */
  fallbackDeploymentKind?: string | null;
}

/**
 * Write `provider_locality` onto an outgoing `/generate` body, for `provider` and
 * `fallback_provider`. Any caller-supplied map is DISCARDED first: locality is a gateway statement,
 * never a client one (a client stamping `local` on a provider the gateway cannot classify would
 * otherwise switch redaction off). When nothing can be stamped the key is left absent.
 */
export function stampProviderLocality<T extends object>(target: T, hints: ProviderLocalityHints = {}): T {
  const body = target as Record<string, unknown>;
  delete body.provider_locality;
  const map: Record<string, ProviderLocality> = {};
  const entries: Array<[unknown, string | null | undefined]> = [
    [body.provider, hints.deploymentKind],
    [body.fallback_provider, hints.fallbackDeploymentKind],
  ];
  for (const [provider, deploymentKind] of entries) {
    if (typeof provider !== 'string' || provider.length === 0) continue;
    const locality = providerLocality(provider, deploymentKind);
    if (locality) map[provider] = locality;
  }
  if (Object.keys(map).length > 0) body.provider_locality = map;
  return target;
}
