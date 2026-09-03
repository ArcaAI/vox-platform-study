/**
 * AiProviderConnection `service` vocabulary contract.
 *
 * Two independent declarations of the capability discriminator exist, and they
 * CANNOT import each other:
 *
 *   - the GOVERNANCE list (`@arcaai/applications` `PROVIDER_SERVICES`), which is
 *     the source of truth — it types `ProviderService`, backs the route's
 *     `:service` guard, and keys `CLOUD_BYO_PROVIDERS`; and
 *   - the SEED list (`packages/database/.../seed/17-ai-provider-connection.ts`
 *     `SEEDABLE_PROVIDER_SERVICES`), which types what actually lands in the
 *     `AiProviderConnection.service` column.
 *
 * `@arcaai/applications` depends on `@arcaai/database`, so the seed cannot
 * import the governance list without a package cycle — and a relative import
 * across the package boundary is rejected outright by `@arcaai/database`'s
 * `rootDir` (TS6059). This is the same shape as the `AI_MODEL_PROVIDERS` drift
 * (`ai-model-providers.contract.test.ts`) and the `ResourceType` enum-parity
 * guard, and it gets the same answer: a contract test in the one place that can
 * see both.
 *
 * C.2 — the drift this pins is not hypothetical. P1-C widened
 * `ProviderService` from `{llm,stt,tts}` to include
 * `{embeddings,rerank,vector}`, but the seed-shape test still asserted the old
 * three. It was green only because no new-service row had been seeded yet; the
 * first Phase 2 `vector:qdrant` or `rerank:tei` SYSTEM row would have failed a
 * test that was describing a vocabulary that no longer existed.
 */

import { describe, it, expect } from 'vitest';
import { PROVIDER_SERVICES as GOVERNANCE_SERVICES } from '@arcaai/applications';
import { SEEDABLE_PROVIDER_SERVICES as SEED_SERVICES } from '../../packages/database/src/prisma/db_main/seed/17-ai-provider-connection';

describe('AiProviderConnection service vocabulary contract', () => {
  it('the seed vocabulary matches the governance vocabulary exactly', () => {
    expect([...SEED_SERVICES].sort()).toEqual([...GOVERNANCE_SERVICES].sort());
  });

  it('covers the three integration capabilities P1-C added, not just the inference three', () => {
    // Named explicitly because the equality above would stay green if a value
    // were dropped from BOTH lists — the same reasoning as the ResourceType
    // parity guard's pinned values.
    for (const service of ['embeddings', 'rerank', 'vector']) {
      expect(SEED_SERVICES).toContain(service);
      expect(GOVERNANCE_SERVICES).toContain(service);
    }
  });
});
