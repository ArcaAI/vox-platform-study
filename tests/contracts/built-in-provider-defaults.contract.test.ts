/**
 * TASK-932 D-8 — built-in provider defaults: the SEED literals vs the RESET table.
 *
 * There are two places that have to agree about what "the default" is for a
 * platform-managed connection row:
 *
 *   - `seed/17-ai-provider-connection.ts` writes it on a fresh database;
 *   - `BUILT_IN_CONNECTION_DEFAULTS` (@arcaai/applications) restores it when a
 *     platform admin presses "Reset to default" on `/ai-providers`.
 *
 * They cannot share a module: `packages/database` is a dependency LEAF and can
 * import neither `@arcaai/applications` nor `@arcaai/types`, so the seed's
 * literals are the only form the seed can hold. What CAN be shared is the
 * CHECK — this file — following `ai-model-providers.contract.test.ts`, which
 * pins the same kind of unavoidable duplication for the provider vocabulary.
 *
 * The failure this prevents is quiet in exactly the way that matters: an admin
 * presses Reset, the endpoint changes to something the seed never wrote, and
 * `apps/text` starts answering 503 for an engine whose row looks configured.
 * When these two disagree, fix the VALUE that is wrong — never relax the test.
 */
import { describe, expect, it } from 'vitest';
import { BUILT_IN_CONNECTION_DEFAULTS, SELF_HOST_PLACEHOLDER_API_KEY as SERVICE_PLACEHOLDER } from '@arcaai/applications';
import {
  SELF_HOST_PLACEHOLDER_API_KEY as SEED_PLACEHOLDER,
  SYSTEM_AI_PROVIDER_CONNECTIONS,
} from '../../packages/database/src/prisma/db_main/seed/17-ai-provider-connection';
import { SYSTEM_TENANT_ID } from '../../packages/database/src/prisma/db_main/seed/00-constants';

/**
 * The seed row for one `service:provider` key, or `undefined`.
 *
 * NOTE the LM Studio caveat: its seeded `baseUrl` is `lmStudioBaseUrl()`, which
 * honours `SEED_LMSTUDIO_BASE_URL` so a developer can seed a database pointing
 * at a desktop LM Studio. That is a SEED-TIME input, not a second default, so
 * the comparison below is made against the fallback the seed uses when the
 * variable is unset — the value both sides genuinely declare.
 */
function seedRow(key: string) {
  const [service, provider] = key.split(/:(.*)/s);
  return SYSTEM_AI_PROVIDER_CONNECTIONS.find((row) => row.service === service && row.provider === provider);
}

const LM_STUDIO_SEED_OVERRIDE = (process.env.SEED_LMSTUDIO_BASE_URL ?? '').trim();

describe('BUILT_IN_CONNECTION_DEFAULTS ↔ seed 17 parity', () => {
  it('declares a default for the four built-in engines and both model-registry rows, and nothing else', () => {
    expect(Object.keys(BUILT_IN_CONNECTION_DEFAULTS).sort()).toEqual(
      ['llm:llama-cpp', 'llm:lm-studio', 'llm:ollama', 'llm:vllm', 'model-registry:huggingface', 'model-registry:s3'].sort(),
    );
  });

  it('the self-host placeholder is spelled identically on both sides', () => {
    expect(SERVICE_PLACEHOLDER).toBe(SEED_PLACEHOLDER);
  });

  for (const [key, fallback] of Object.entries(BUILT_IN_CONNECTION_DEFAULTS)) {
    describe(key, () => {
      it('has a SYSTEM-tenant seed row', () => {
        const row = seedRow(key);
        expect(row, `${key} declares a reset default but the seed writes no row for it`).toBeDefined();
        expect(row!.tenantId).toBe(SYSTEM_TENANT_ID);
      });

      it('seeds the same baseUrl the reset restores', () => {
        const row = seedRow(key)!;
        // The one sanctioned divergence, and only when the env var is actually set.
        if (key === 'llm:lm-studio' && LM_STUDIO_SEED_OVERRIDE) {
          expect(row.baseUrl).toBe(LM_STUDIO_SEED_OVERRIDE);
          return;
        }
        expect(row.baseUrl).toBe(fallback.baseUrl);
      });

      it('seeds the same enabled state the reset restores', () => {
        expect(seedRow(key)!.enabled).toBe(fallback.enabled);
      });

      it('seeds the same key material the reset restores', () => {
        // Never a vendor credential on either side: the ONLY non-null value
        // permitted is the non-secret self-host placeholder.
        const seeded = seedRow(key)!.apiKeyPlaintext;
        expect(seeded).toBe(fallback.apiKey);
        if (seeded !== null) expect(seeded).toBe(SEED_PLACEHOLDER);
      });

      it('seeds the same extraJson the reset restores', () => {
        expect(seedRow(key)!.extraJson ?? null).toEqual(fallback.extraJson);
      });
    });
  }
});

describe('the weight store is the built-in global default (R-11 / D-7)', () => {
  it('model-registry:s3 seeds ENABLED, keyless, and marked as inheriting the platform storage', () => {
    const row = seedRow('model-registry:s3')!;
    expect(row.enabled).toBe(true);
    expect(row.apiKeyPlaintext).toBeNull();
    expect(row.baseUrl).toBeNull();
    expect(row.extraJson).toEqual({ inheritsPlatformStorage: true });
  });

  it('model-registry:huggingface seeds ENABLED and blank — an anonymous pull is a resolved state', () => {
    const row = seedRow('model-registry:huggingface')!;
    expect(row.enabled).toBe(true);
    expect(row.apiKeyPlaintext).toBeNull();
  });
});
