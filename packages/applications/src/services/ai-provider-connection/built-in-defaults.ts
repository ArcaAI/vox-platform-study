/**
 * TASK-932 D-8 — the factory settings of the PLATFORM's OWN connection rows.
 *
 * The owner's rule (2026-09-09, R-3/R-11): the built-in inference services —
 * LM Studio, Ollama, vLLM, llama.cpp — and the built-in weight store are
 * platform-managed, and the platform super admin must be able to CONFIGURE them
 * and to RESET them to the default. This module is what "the default" means, in
 * exactly one place.
 *
 * WHY A RESET NEEDED A TABLE AT ALL. There was already an obvious-looking way
 * to undo a bad endpoint — `DELETE admin/providers/llm/lm-studio` — and it is
 * WRONG. `apps/text` resolves a self-hosted engine's base URL only from the
 * gateway-injected `provider_overrides` fold (`text/core/connection.py:55-72`),
 * with no env fallback: a deleted SYSTEM row is not "back to the default", it is
 * a 503 on every generate. Reset therefore has to REWRITE the row, and the value
 * it rewrites has to live somewhere both the seed and the runtime agree on.
 *
 * WHY NOT `packages/types`. `packages/database` is a dependency LEAF: it cannot
 * import `@arcaai/applications` OR `@arcaai/types`, so the seed cannot import
 * this table however it is packaged. Parity between the seed literals and this
 * table is therefore pinned by a CONTRACT TEST
 * (`tests/contracts/built-in-provider-defaults.contract.test.ts`), the same
 * mechanism `tests/contracts/ai-model-providers.contract.test.ts` already uses
 * for the provider vocabulary. One home for the VALUE would have been nicer;
 * one home for the CHECK is what the dependency graph permits.
 *
 * WHY THE ENGINE ROWS KEEP A KEY. `SELF_HOST_PLACEHOLDER_API_KEY` is not a
 * credential — LM Studio and friends authenticate nobody. It exists because the
 * override fold DROPS a keyless row on both tiers (that guard is what stops a
 * SYSTEM row's `baseUrl` being mistaken for a credential), so an engine row with
 * no key material resolves and then delivers nothing. A reset that "cleared the
 * key" would therefore reproduce, silently, the exact 503 it was invoked to fix.
 * The default RESTORES whatever the row is supposed to hold: the placeholder for
 * an engine, nothing at all for the two model-registry rows.
 */

import type { ProviderService } from './constants';

/**
 * The non-secret stand-in a keyless self-hosted engine accepts as an API key.
 *
 * Mirrors `SELF_HOST_PLACEHOLDER_API_KEY` in
 * `packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts`
 * (the seed cannot import this module — see the header). It is NOT a credential
 * and must never be treated as one.
 */
export const SELF_HOST_PLACEHOLDER_API_KEY = 'not-needed';

/**
 * The `extraJson` marker that says "this weight store uses the platform's own
 * object-storage credentials" (TASK-932 D-7).
 *
 * A MARKER, not a credential: the row carries no endpoint and no key, and the
 * values come from the platform storage cascade (SYSTEM `TenantStorageConfig`
 * row → AppSettings `S3_*` → bootstrap `MINIO_*`) at resolve time. Requiring a
 * key on the row instead would duplicate the bootstrap MinIO credential into
 * Vault-Transit and leave two copies to rotate.
 */
export const INHERITS_PLATFORM_STORAGE_KEY = 'inheritsPlatformStorage';

/** One platform-managed connection row, as the platform ships it. */
export interface BuiltInConnectionDefault {
  service: ProviderService;
  provider: string;
  /** The engine's address, or `null` where the default carries none. */
  baseUrl: string | null;
  /** Whether the row serves by default. */
  enabled: boolean;
  /**
   * PLAINTEXT key material the default holds, or `null` to CLEAR the stored
   * ciphertext. Only ever the non-secret self-host placeholder — a vendor
   * credential in a default would arm the platform cascade for every entitled
   * tenant without an administrator deciding to.
   */
  apiKey: string | null;
  /** The default `extraJson`, or `null` to clear it. */
  extraJson: Record<string, boolean | number | string> | null;
}

/**
 * The factory settings, keyed `"<service>:<provider>"`.
 *
 * ADDRESSES ARE THE DEPLOYED ONES, verified 2026-09-09 against
 * `hope-v2-deployment/deployment/k8s/base/`:
 *   - `hope-lmstudio` is a ClusterIP Service on port 1234 (`lmstudio.yaml`);
 *   - `hope-vllm` is a ClusterIP Service on port 8000 (`vllm.yaml`);
 *   - there is NO Ollama and NO llama.cpp workload in that tree. Ollama's
 *     default therefore stays the seed's `http://localhost:11434` — it is a
 *     desktop engine, and inventing a `hope-ollama` Service name would be a
 *     dead address dressed as a default. `hope-llama-cpp:8080` keeps the seed's
 *     aspirational Service name for the same reason it was written: it is what
 *     the row WOULD point at, and it is create-only either way.
 *
 * A developer running LM Studio natively re-enters `http://localhost:1234/v1` on
 * the providers screen (or re-seeds with `SEED_LMSTUDIO_BASE_URL`); resetting
 * returns the row to the CLUSTER default, which is the only default a table
 * shared by every environment can honestly declare.
 */
export const BUILT_IN_CONNECTION_DEFAULTS: Readonly<Record<string, BuiltInConnectionDefault>> = Object.freeze({
  // LM Studio at the in-cluster Service address, enabled, no credential.
  'llm:lm-studio': {
    service: 'llm',
    provider: 'lm-studio',
    baseUrl: 'http://hope-lmstudio:1234/v1',
    enabled: true,
    apiKey: SELF_HOST_PLACEHOLDER_API_KEY,
    extraJson: null,
  },
  // Ollama at localhost:11434 — it runs beside the node, not as a cluster Service.
  'llm:ollama': {
    service: 'llm',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    enabled: true,
    apiKey: SELF_HOST_PLACEHOLDER_API_KEY,
    extraJson: null,
  },
  // vLLM at the in-cluster Service address, enabled, no credential.
  'llm:vllm': {
    service: 'llm',
    provider: 'vllm',
    baseUrl: 'http://hope-vllm:8000/v1',
    enabled: true,
    apiKey: SELF_HOST_PLACEHOLDER_API_KEY,
    extraJson: null,
  },
  // llama.cpp at its Service address, enabled, no credential.
  'llm:llama-cpp': {
    service: 'llm',
    provider: 'llama-cpp',
    baseUrl: 'http://hope-llama-cpp:8080',
    enabled: true,
    apiKey: SELF_HOST_PLACEHOLDER_API_KEY,
    extraJson: null,
  },
  // TASK-952 D-1c — the platform's own dense-embeddings server (HF
  // text-embeddings-inference). Endpoint and model mirror `hope-tei-embed` in
  // `infrastructure/docker/docker-compose.dev.yml` (`--model-id BAAI/bge-m3`,
  // published on 8871); TEI serves an OpenAI-compatible `POST /v1/embeddings`
  // beside its native `/embed`, which is the shape the harness posts. There is
  // no `hope-tei-embed` workload in the deployment repo's `base/`, so this keeps
  // the address the engine actually listens on — the `llm:ollama` case, not the
  // `hope-llama-cpp` one.
  //
  // It keeps the self-host PLACEHOLDER key for the reason every engine row does:
  // the override fold drops a keyless row, and a dropped row delivers neither
  // the endpoint nor the model id the harness now has no code default for.
  'embeddings:tei-embed': {
    service: 'embeddings',
    provider: 'tei-embed',
    baseUrl: 'http://localhost:8871/v1',
    enabled: true,
    apiKey: SELF_HOST_PLACEHOLDER_API_KEY,
    extraJson: { model: 'BAAI/bge-m3' },
  },
  // The Hub with NO token: public repos pull anonymously; a token is what reaches a gated one.
  'model-registry:huggingface': {
    service: 'model-registry',
    provider: 'huggingface',
    baseUrl: null,
    enabled: true,
    apiKey: null,
    extraJson: null,
  },
  // The platform's own object storage — endpoint and key pair come from the platform storage configuration, not from this row.
  'model-registry:s3': {
    service: 'model-registry',
    provider: 's3',
    baseUrl: null,
    enabled: true,
    apiKey: null,
    extraJson: { [INHERITS_PLATFORM_STORAGE_KEY]: true },
  },
} satisfies Record<string, BuiltInConnectionDefault>);

/** The factory setting for `(service, provider)`, or `undefined` when it has none. */
export function builtInDefaultFor(service: ProviderService, provider: string): BuiltInConnectionDefault | undefined {
  return BUILT_IN_CONNECTION_DEFAULTS[`${service}:${provider}`];
}
