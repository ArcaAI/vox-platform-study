/**
 * Config-plane core seed invariants
 *
 * Static assertions over the EXPORTED seed data (no live DB), following the
 * conventions of `ai-model-consolidation-seed.test.ts` in this directory.
 *
 * SEED-AUTHORITATIVE Day-1 posture. The seed is now the
 * authoritative source of the built-in-local connection defaults —
 * NOT env. Concretely —
 *
 *   1. The four built-in-local `llm` rows (`lm-studio`, `built-in`,
 *      `vllm`, `llama-cpp`) seed `enabled: true`, so `resolveConnection('llm', …)`
 *      returns the SYSTEM row Day-1 and env becomes a pure fallback. Ollama was
 * removed entirely — there is no `llm:ollama` row to seed.
 *   2. Every CLOUD-BYO row (all services — e.g. llm `azure`/`bedrock`/`openai`/
 *      `anthropic`/`vertex`, and all stt/tts cloud rows) stays
 *      `enabled: false`: a cloud provider needs a tenant key, so an
 *      enabled-but-keyless cloud row must never serve.
 *   3. No row carries a VENDOR credential, and no ciphertext is committed to
 * source. Round 4 lane B narrowed this from "no key material at
 *      all": the self-hosted engines must carry the non-secret `not-needed`
 *      placeholder, because the `provider_overrides` fold — the channel
 *      `apps/text` actually reads — drops a keyless row on BOTH tiers. See the
 *      delivery-path section at the top of `17-ai-provider-connection.ts`.
 *   4. TASK-862: there is NO `llm:sarvam` row (Sarvam has no LLM adapter —
 *      decision D-4) and no `AiRuntimeProfile` seed at all (the model was
 *      retired; connection ceilings live on `AiProviderConnection`).
 *
 * Plus the allow-list drift guard (test 19): the connection model must be
 * tenant-scoped, SYSTEM-shared for reads, and soft-deleting.
 */

import { describe, it, expect } from 'vitest';

import { MODELS_WITHOUT_SOFT_DELETE } from '../../../../client';
import { SYSTEM_SHARED_READ_MODELS, TENANT_SCOPED_MODELS } from '../../../../extensions/tenant-scope';
import { AI_MODEL_PROVIDERS } from '../ai-models/shared';
import { LLM_AI_MODELS } from '../ai-models/llm';
import { SYSTEM_TENANT_ID } from '../00-constants';
import {
  PLATFORM_SELF_HOST_CONNECTIONS,
  SEEDABLE_PROVIDER_SERVICES,
  SELF_HOST_PLACEHOLDER_API_KEY,
  SYSTEM_AI_PROVIDER_CONNECTIONS,
  isPlatformSelfHostConnection,
} from '../17-ai-provider-connection';

// =============================================================================
// 1. AiProviderConnection seed shape
// =============================================================================

/**
 * Round 4 lane B.2 — the predicate is IMPORTED, not transcribed.
 *
 * It used to be a local `c.service === 'llm' && provider in [...]`, which
 * silently answered a narrower question than its name: "is this a built-in
 * LOCAL LLM engine", not "is this a connection to something the PLATFORM runs
 * itself". The first `rerank:tei` / `vector:qdrant` SYSTEM row seeded
 * `enabled: true` would therefore have been classified as a cloud row by the
 * test below and failed it — a test failure caused by the test's own vocabulary
 * rather than by the seed. `isPlatformSelfHostConnection` is exported from the
 * seed module (the same B.3 discipline as `SEEDABLE_PROVIDER_SERVICES`), so a
 * future widening cannot desynchronise this file from the data it describes.
 */
const isBuiltInLocalLlm = isPlatformSelfHostConnection;

describe('AiProviderConnection SYSTEM seed rows', () => {
  it('seeds one llm row per canonical serving provider', () => {
    // `anthropic` / `vertex` are now first-class members of AI_MODEL_PROVIDERS
    // so the llm seed rows must equal it exactly — no manual append. TASK-862
    // D-4: `sarvam` is a catalogue provider (STT/TTS) but has NO LLM adapter,
    // so it seeds no `llm` connection row.
    const llmProviders = SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => c.service === 'llm')
      .map((c) => c.provider)
      .sort();
    expect(llmProviders).toEqual([...AI_MODEL_PROVIDERS].filter((p) => p !== 'sarvam').sort());
    expect(SYSTEM_AI_PROVIDER_CONNECTIONS.some((c) => c.service === 'llm' && c.provider === 'sarvam')).toBe(false);
  });

  it('seeds the STT cloud catalog rows', () => {
    const stt = SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => c.service === 'stt')
      .map((c) => c.provider)
      .sort();
    expect(stt).toEqual(['azure-speech', 'openai', 'sarvam']);
  });

  it('seeds the TTS cloud catalog rows', () => {
    const tts = SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => c.service === 'tts')
      .map((c) => c.provider)
      .sort();
    expect(tts).toEqual(['azure', 'sarvam']);
  });

  /**
   * C.2 — asserted against the DECLARED vocabulary, never a
   * transcription of it.
   *
   * This used to read `['llm', 'stt', 'tts']` inline. P1-C widened
   * `ProviderService` to add `embeddings`/`rerank`/`vector`, and the literal was
   * green only because no row for a new service had been seeded yet — the first
   * Phase 2 `vector:qdrant` or `rerank:tei` SYSTEM row would have failed a test
   * describing a vocabulary that no longer existed. Reading the exported list
   * means the next widening cannot desynchronise this assertion, and
   * `tests/contracts/provider-connection-services.contract.test.ts` pins that
   * list to `@arcaai/applications` `PROVIDER_SERVICES` (the source of truth,
   * which this package cannot import — it would be a dependency cycle).
 */
  it('carries a valid service discriminator on every row', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.forEach((c) => {
      expect(SEEDABLE_PROVIDER_SERVICES, `service for ${c.service}:${c.provider}`).toContain(c.service);
    });
  });

  it('admits a Phase 2 integration row without needing a test change', () => {
    // The rows Phase 2's harness lane will seed for the platform's self-hosted
    // integrations. Asserting the GUARD rather than seeding the rows: those
    // belong to that lane, and adding them here would collide with it.
    for (const service of ['rerank', 'vector', 'embeddings'] as const) {
      expect(SEEDABLE_PROVIDER_SERVICES).toContain(service);
    }
  });

  it('keeps every row on the SYSTEM tenant', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.forEach((c) => expect(c.tenantId).toBe(SYSTEM_TENANT_ID));
  });

  it('enables exactly the five built-in-local llm rows Day-1 (seed-authoritative)', () => {
    const enabled = SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => c.enabled)
      .map((c) => `${c.service}:${c.provider}`)
      .sort();
    expect(enabled).toEqual(['llm:built-in', 'llm:llama-cpp', 'llm:lm-studio', 'llm:ollama', 'llm:vllm']);
  });

  /*
   * REVISED (owner decision 2026-08-17): the previous assertion here
   * was `never seeds an ollama connection row`, encoding the superseded
   * "Ollama removed entirely" directive. The product changed, not the test's
   * rigor: the connection row is REQUIRED so a tenant can point the platform at
   * its own Ollama, while the MODEL CATALOG stays purged — the pair is pinned
   * by `ollama-provider-retained.test.ts`.
*/
  it('seeds the ollama connection row keyless, so the endpoint is configurable without a platform key', () => {
    const ollama = SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => c.provider === 'ollama');
    expect(ollama).toHaveLength(1);
    expect(ollama[0]!.service).toBe('llm');
    expect(ollama[0]!.encryptedApiKey ?? null).toBeNull();
  });

  it('enables every built-in-local llm engine', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.filter(isBuiltInLocalLlm).forEach((c) => {
      expect(c.enabled, `built-in-local ${c.provider} must seed enabled`).toBe(true);
    });
  });

  it('keeps every cloud-BYO / non-built-in row disabled (no keyless cloud row serves)', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => !isBuiltInLocalLlm(c)).forEach((c) => {
      expect(c.enabled, `cloud/non-built-in ${c.service}:${c.provider} must seed disabled`).toBe(false);
    });
  });

  it('never seeds ciphertext into source (the column is filled at seed time, via Vault)', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.forEach((c) => {
      expect(c.encryptedApiKey ?? null, `connection ${c.provider} must have no ciphertext`).toBeNull();
      expect(c.keyVersion ?? null, `connection ${c.provider} must have no key version`).toBeNull();
    });
  });

  /*
   * ────────────────────────────────────────────────────────────────────────
   * Round 4 lane B.1 — the DELIVERY-PATH invariants.
   *
   * Phase 2's text migration made every adapter resolve its connection per
   * request and FAIL CLOSED (`apps/text/src/text/core/connection.py`), and the
   * delivery channel it reads is the `provider_overrides` fold that
   * `TextRequestEnrichmentService.applyTenantProviderOverrides` builds from
   * `AiProviderConnectionService.resolveTenantCloudOverrides('llm', tenantId)`.
   *
   * That fold SKIPS a keyless row on BOTH tiers
   * (`ai-provider-connection.service.ts`: `if (!row.enabled || !row.encryptedApiKey) continue;`),
   * by design — it is what stops a SYSTEM row's `baseUrl` being mistaken for a
   * credential. So the self-hosted engines, which need no vendor credential at
   * all, must still carry KEY MATERIAL or they are never delivered and text
   * answers 503 `No provider connection resolved for '<engine>'`.
   *
   * The reconciliation, stated once: a row that must be DELIVERED through the
   * override fold needs key material even when its engine requires no auth —
   * hence the non-secret placeholder `not-needed`, which is literally the value
   * `openai_compat.py` substitutes for LM Studio when the field is empty.
   * ────────────────────────────────────────────────────────────────────────
*/

  /** The self-host llm engines `apps/text` registers a provider factory for. */
  const TEXT_SELF_HOST_ENGINES = ['llm:lm-studio', 'llm:ollama', 'llm:vllm', 'llm:llama-cpp'] as const;

  it('gives every text-served self-host engine key material, so the override fold delivers it', () => {
    TEXT_SELF_HOST_ENGINES.forEach((pair) => {
      const row = SYSTEM_AI_PROVIDER_CONNECTIONS.find((c) => `${c.service}:${c.provider}` === pair);
      expect(row, `${pair} must have a SYSTEM connection row`).toBeDefined();
      expect(row!.apiKeyPlaintext, `${pair} must carry the keyless-engine placeholder or the fold drops it`).toBe(
        SELF_HOST_PLACEHOLDER_API_KEY,
      );
      expect(row!.baseUrl, `${pair} must carry the engine endpoint`).toBeTruthy();
    });
  });

  it('addresses every PLATFORM-RUN self-host engine by its cluster Service name, not a workstation', () => {
    /*
     * A SYSTEM-tenant row is the PLATFORM default every tenant without an
     * opinion inherits, so its endpoint has to be an address the platform's own
     * pods can reach. `llm:lm-studio` carried `http://localhost:1234/v1` — the
     * developer-desktop address — long after `llm:vllm` and `llm:llama-cpp` had
     * moved to cluster Service names; in a cluster that resolves to the calling
     * pod itself and every generation 503s on connect.
     *
     * `llm:ollama` is deliberately NOT in this list: the platform runs no Ollama
     * and seeds no Ollama model (owner decision 2026-08-17). Its row is the
     * endpoint a BYO tenant overrides, not an engine the platform hosts.
     */
    const PLATFORM_RUN_ENGINES = ['llm:lm-studio', 'llm:vllm', 'llm:llama-cpp'] as const;
    PLATFORM_RUN_ENGINES.forEach((pair) => {
      const row = SYSTEM_AI_PROVIDER_CONNECTIONS.find((c) => `${c.service}:${c.provider}` === pair);
      expect(row, `${pair} must have a SYSTEM connection row`).toBeDefined();
      expect(row!.baseUrl, `${pair} must carry an endpoint`).toBeTruthy();
      expect(row!.baseUrl, `${pair} must not point the platform default at a workstation`).not.toMatch(
        /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/,
      );
    });
  });

  it('never seeds a VENDOR credential — the only seeded key material is the non-secret placeholder', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.forEach((c) => {
      const key = c.apiKeyPlaintext;
      if (key === null) return;
      expect(key, `${c.service}:${c.provider} may only seed the sanctioned placeholder`).toBe(SELF_HOST_PLACEHOLDER_API_KEY);
    });
  });

  it('leaves every cloud-BYO row keyless (a seeded placeholder would defeat fail-closed)', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => (CLOUD_BYO_SEED_PAIRS as readonly string[]).includes(`${c.service}:${c.provider}`)).forEach(
      (c) => {
        expect(c.apiKeyPlaintext, `cloud-BYO ${c.service}:${c.provider} must seed no key material at all`).toBeNull();
      },
    );
  });

  it('keeps `llm:built-in` keyless — it is in-process, so there is nothing to deliver a credential to', () => {
    const builtIn = SYSTEM_AI_PROVIDER_CONNECTIONS.find((c) => c.service === 'llm' && c.provider === 'built-in');
    expect(builtIn).toBeDefined();
    expect(builtIn!.baseUrl).toBeNull();
    expect(builtIn!.apiKeyPlaintext).toBeNull();
  });

  /*
   * B.2 — the widened predicate, tested as a CLASSIFIER rather than through the
   * rows that happen to be seeded today. `vector:qdrant` is the case the old
   * `service === 'llm'` form got wrong: the provider IS cloud-BYO eligible (a
   * tenant may point at its own Qdrant Cloud), yet the SYSTEM row is the
   * platform-run cluster and would seed enabled.
   */
  it('classifies a platform-run self-host integration as self-host, whatever its service', () => {
    expect(isPlatformSelfHostConnection({ service: 'vector', provider: 'qdrant' })).toBe(true);
    expect(isPlatformSelfHostConnection({ service: 'rerank', provider: 'tei' })).toBe(true);
    expect(isPlatformSelfHostConnection({ service: 'llm', provider: 'vllm' })).toBe(true);
    // …and a cloud vendor is still not self-host, in any service.
    expect(isPlatformSelfHostConnection({ service: 'llm', provider: 'azure' })).toBe(false);
    expect(isPlatformSelfHostConnection({ service: 'stt', provider: 'openai' })).toBe(false);
  });

  it('declares the self-host classification once, as `service:provider` pairs', () => {
    PLATFORM_SELF_HOST_CONNECTIONS.forEach((pair) => {
      const [service] = pair.split(':');
      expect(SEEDABLE_PROVIDER_SERVICES, `self-host pair ${pair} names a declared service`).toContain(service);
    });
  });

  it('marks no built-in-local row as a placeholder (they are active connections, not suggestions)', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.filter(isBuiltInLocalLlm).forEach((c) => {
      expect(c.metaData?.placeholder ?? false, `active connection ${c.provider} must not be a placeholder`).toBe(false);
    });
  });

  /*
   * Test 39 — the cascade's arming switch.
   *
   * Once the platform-default cascade lands, an ENABLED + KEYED SYSTEM row is
   * the single thing that makes a cloud provider reachable on the PLATFORM's
   * money for every tenant that lacks its own key. The seed must therefore keep
   * every cloud-BYO SYSTEM row disabled and keyless, so arming one stays a
   * deliberate, per-provider act by a super admin.
   *
   * The pair list is spelled out here rather than derived: it mirrors
   * `CLOUD_BYO_PROVIDERS` in `@arcaai/applications`, which the database package
   * must not import (same one-way dependency rule as the plan matrix). Written
   * out in full so that adding a provider on either side surfaces as a failure
   * here rather than as a silently-unchecked row.
   */
  const CLOUD_BYO_SEED_PAIRS = [
    'llm:azure',
    'llm:bedrock',
    'llm:openai',
    'llm:anthropic',
    'llm:vertex',
    'stt:azure-speech',
    'stt:sarvam',
    'stt:openai',
    'tts:azure',
    'tts:sarvam',
  ] as const;

  it('seeds every cloud-BYO provider a SYSTEM row (the cascade has something to arm)', () => {
    const seeded = new Set(SYSTEM_AI_PROVIDER_CONNECTIONS.map((c) => `${c.service}:${c.provider}`));
    CLOUD_BYO_SEED_PAIRS.forEach((pair) => {
      expect(seeded.has(pair), `cloud-BYO ${pair} must have a SYSTEM connection row`).toBe(true);
    });
  });

  it('keeps every cloud-BYO SYSTEM row DISABLED and KEYLESS (— the cascade stays unarmed until an admin arms it)', () => {
    const cloudByo = SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => (CLOUD_BYO_SEED_PAIRS as readonly string[]).includes(`${c.service}:${c.provider}`));
    expect(cloudByo).toHaveLength(CLOUD_BYO_SEED_PAIRS.length);

    cloudByo.forEach((c) => {
      expect(c.tenantId, `${c.service}:${c.provider} must be a SYSTEM row`).toBe(SYSTEM_TENANT_ID);
      expect(c.enabled, `cloud-BYO ${c.service}:${c.provider} must seed disabled — an enabled row is platform-funded for every entitled tenant`).toBe(
        false,
      );
      expect(c.encryptedApiKey ?? null, `cloud-BYO ${c.service}:${c.provider} must seed keyless`).toBeNull();
      expect(c.keyVersion ?? null, `cloud-BYO ${c.service}:${c.provider} must seed without a key version`).toBeNull();
    });
  });

  it('has unique ids and one row per (tenant, service, provider)', () => {
    const ids = SYSTEM_AI_PROVIDER_CONNECTIONS.map((c) => c.id);
    const triples = SYSTEM_AI_PROVIDER_CONNECTIONS.map((c) => `${c.tenantId}::${c.service}::${c.provider}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(triples).size).toBe(triples.length);
  });
});

// =============================================================================
// 3. Allow-list drift guard (test 19)
// =============================================================================

describe('client extension allow-lists', () => {
  it.each(['AiProviderConnection'])('registers %s as tenant-scoped', (model) => {
    expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
  });

  it.each(['AiProviderConnection'])('registers %s as a SYSTEM-shared read model', (model) => {
    expect(SYSTEM_SHARED_READ_MODELS.has(model)).toBe(true);
  });

  it.each(['AiProviderConnection'])('keeps %s soft-deleting', (model) => {
    expect(MODELS_WITHOUT_SOFT_DELETE.has(model)).toBe(false);
  });
});
