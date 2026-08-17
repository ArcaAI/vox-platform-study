/**
 * Config-plane core seed invariants
 *
 * Static assertions over the EXPORTED seed data (no live DB), following the
 * conventions of `ai-model-consolidation-seed.test.ts` in this directory.
 *
 * SEED-AUTHORITATIVE Day-1 posture (OD-1). The seed is now the
 * authoritative source of the built-in-local connection defaults —
 * NOT env. Concretely —
 *
 *   1. The four built-in-local `llm` rows (`lm-studio`, `built-in`,
 *      `vllm`, `llama-cpp`) seed `enabled: true`, so `resolveConnection('llm', …)`
 *      returns the SYSTEM row Day-1 and env becomes a pure fallback. Ollama was
 *      removed entirely (TASK-736) — there is no `llm:ollama` row to seed.
 *   2. Every CLOUD-BYO row (all services — e.g. llm `azure`/`bedrock`/`openai`/
 *      `anthropic`/`vertex`/`sarvam`, and all stt/tts cloud rows) stays
 *      `enabled: false`: a cloud provider needs a tenant key, so an
 *      enabled-but-keyless cloud row must never serve.
 *   3. NO row ever carries key material.
 *   4. `AiRuntimeProfile` seeds are EMPTY. Absence of a profile row means "no
 *      opinion" — the injection cascade falls through to the service's own
 *      pydantic/env default, so forwarded requests stay byte-identical.
 *
 * Plus the allow-list drift guard (test 19): both models must be
 * tenant-scoped, SYSTEM-shared for reads, and soft-deleting.
 */

import { describe, it, expect } from 'vitest';

import { MODELS_WITHOUT_SOFT_DELETE } from '../../../../client';
import { SYSTEM_SHARED_READ_MODELS, TENANT_SCOPED_MODELS } from '../../../../extensions/tenant-scope';
import { AI_MODEL_PROVIDERS } from '../ai-models/shared';
import { SYSTEM_TENANT_ID } from '../00-constants';
import { SYSTEM_AI_PROVIDER_CONNECTIONS } from '../17-ai-provider-connection';
import { SYSTEM_AI_RUNTIME_PROFILES } from '../18-ai-runtime-profile';

// =============================================================================
// 1. AiProviderConnection seed shape
// =============================================================================

/**
 * The built-in-local `llm` engines the platform runs itself — these are the ONLY
 * rows enabled Day-1. `sarvam`/`azure`/`bedrock`/`openai`/`anthropic`/
 * `vertex` are cloud providers and stay disabled (they need a tenant key).
 */
const BUILT_IN_LOCAL_LLM_PROVIDERS = ['lm-studio', 'built-in', 'vllm', 'llama-cpp'] as const;

/** True iff the row is one of the enabled-Day-1 built-in-local llm engines. */
const isBuiltInLocalLlm = (c: { service: string; provider: string }): boolean =>
  c.service === 'llm' && (BUILT_IN_LOCAL_LLM_PROVIDERS as readonly string[]).includes(c.provider);

describe('AiProviderConnection SYSTEM seed rows', () => {
  it('seeds one llm row per canonical serving provider', () => {
    // `anthropic` / `vertex` are now first-class members of AI_MODEL_PROVIDERS
    // so the llm seed rows must equal it exactly — no manual append.
    const llmProviders = SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => c.service === 'llm')
      .map((c) => c.provider)
      .sort();
    expect(llmProviders).toEqual([...AI_MODEL_PROVIDERS].sort());
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

  it('carries a valid service discriminator on every row', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.forEach((c) => {
      expect(['llm', 'stt', 'tts'], `service for ${c.provider}`).toContain(c.service);
    });
  });

  it('keeps every row on the SYSTEM tenant', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.forEach((c) => expect(c.tenantId).toBe(SYSTEM_TENANT_ID));
  });

  it('enables exactly the four built-in-local llm rows Day-1 (seed-authoritative)', () => {
    const enabled = SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => c.enabled)
      .map((c) => `${c.service}:${c.provider}`)
      .sort();
    expect(enabled).toEqual(['llm:built-in', 'llm:llama-cpp', 'llm:lm-studio', 'llm:vllm']);
  });

  it('never seeds an ollama connection row (TASK-736 — Ollama removed entirely)', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.forEach((c) => {
      expect(c.provider).not.toBe('ollama');
    });
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

  it('never seeds key material', () => {
    SYSTEM_AI_PROVIDER_CONNECTIONS.forEach((c) => {
      expect(c.encryptedApiKey ?? null, `connection ${c.provider} must have no ciphertext`).toBeNull();
      expect(c.keyVersion ?? null, `connection ${c.provider} must have no key version`).toBeNull();
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
// 2. AiRuntimeProfile seed shape — deliberately empty
// =============================================================================

describe('AiRuntimeProfile seed', () => {
  it('seeds NO profile rows (absence = env defaults; silent-change guard)', () => {
    expect(SYSTEM_AI_RUNTIME_PROFILES).toEqual([]);
  });
});

// =============================================================================
// 3. Allow-list drift guard (test 19)
// =============================================================================

describe('client extension allow-lists', () => {
  it.each(['AiProviderConnection', 'AiRuntimeProfile'])('registers %s as tenant-scoped', (model) => {
    expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
  });

  it.each(['AiProviderConnection', 'AiRuntimeProfile'])('registers %s as a SYSTEM-shared read model', (model) => {
    expect(SYSTEM_SHARED_READ_MODELS.has(model)).toBe(true);
  });

  it.each(['AiProviderConnection', 'AiRuntimeProfile'])('keeps %s soft-deleting', (model) => {
    expect(MODELS_WITHOUT_SOFT_DELETE.has(model)).toBe(false);
  });
});
