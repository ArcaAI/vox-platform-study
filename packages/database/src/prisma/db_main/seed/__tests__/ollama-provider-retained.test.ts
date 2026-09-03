/**
 * (REVISED) — Ollama provider logic stays; Ollama model CATALOG goes.
 *
 * The ticket's original R1 read "Ollama is removed completely, including its
 * model catalog rows". The owner REVERSED that on 2026-08-17
 * (`docs/programs/agentic-workflow-platform/owner-decisions-2026-08-17.md`
 * row 736):
 *
 *   > "ollama provider logic must be available, however, model catalog related
 *   > to ollama must be removed."
 *
 * So the seed plane has to hold two facts at once, and this file pins both so
 * neither half can drift back:
 *
 *   1. **Selectable.** `ollama` is a canonical serving provider — it is in
 *      `AI_MODEL_PROVIDERS` (which the DTO `@IsIn` allow-list mirrors, pinned
 *      by `tests/contracts/ai-model-providers.contract.test.ts`) and it has a
 *      SYSTEM `AiProviderConnection` row, so a tenant that brings its own
 *      Ollama endpoint has something to configure. Per the three-state
 *      semantics in `.claude/rules/09-infrastructure-devops.md`, ABSENCE of a
 *      row is "no opinion" — which is exactly what a tenant with no Ollama
 *      would have; the SYSTEM row is the platform default it inherits.
 *
 *   2. **No catalog.** Not one `DEFAULT_AI_MODELS` row serves on `ollama`, and
 *      every `ollama-*` slug the platform ever shipped is in the retired
 *      ledger. Seeds are create-only, so deleting a row is not enough: the
 *      ledger is what sweeps a slug out of a tenant's already-materialised
 *      catalog (`retireLegacyAiModels`, `06-stt.ts`).
 *
 * The pair is the whole point. A provider with no catalog rows is not a
 * contradiction here — it is BYO: the model id arrives from the tenant's own
 * `AiModel` row / `AiTaskDefault`, never from a platform-seeded default.
 */

import { describe, it, expect } from 'vitest';

import { DEFAULT_AI_MODELS } from '../06-stt';
import { AI_MODEL_PROVIDERS } from '../ai-models/shared';
import { RETIRED_AI_MODEL_SLUGS } from '../ai-models/retired';
import { SYSTEM_AI_PROVIDER_CONNECTIONS } from '../17-ai-provider-connection';
import { SYSTEM_TENANT_ID } from '../00-constants';

/** Every `ollama-*` slug the platform has ever seeded. */
const PURGED_OLLAMA_SLUGS = [
  'ollama-gemma4-12b-mlx',
  'ollama-gemma4-e2b-it-qat',
  'ollama-qwen3.5-2b',
] as const;

describe(' (revised) — Ollama provider retained, Ollama catalog purged', () => {
  describe('provider logic stays selectable', () => {
    it('lists `ollama` as a canonical serving provider', () => {
      expect(AI_MODEL_PROVIDERS).toContain('ollama');
    });

    it('seeds a SYSTEM `llm` AiProviderConnection for ollama so it can be configured', () => {
      const row = SYSTEM_AI_PROVIDER_CONNECTIONS.find((c) => c.service === 'llm' && c.provider === 'ollama');
      expect(row, 'a tenant bringing its own Ollama endpoint needs a platform-default row to inherit').toBeDefined();
      expect(row!.tenantId).toBe(SYSTEM_TENANT_ID);
      // Self-host engines carry their endpoint and seed keyless + enabled,
      // exactly like lm-studio / vllm / llama-cpp.
      expect(row!.baseUrl, 'a self-host engine declares its endpoint').toBeTruthy();
      expect(row!.encryptedApiKey, 'no key material ever lives in a seed').toBeNull();
      expect(row!.enabled).toBe(true);
    });
  });

  describe('model catalog is purged', () => {
    it('seeds no AiModel row on the ollama provider', () => {
      const rows = DEFAULT_AI_MODELS.filter((m) => m.provider === 'ollama');
      expect(rows.map((m) => m.slug)).toEqual([]);
    });

    it('seeds no AiModel row whose slug looks like an ollama catalog entry', () => {
      const rows = DEFAULT_AI_MODELS.filter((m) => m.slug.startsWith('ollama-'));
      expect(rows.map((m) => m.slug)).toEqual([]);
    });

    it('retires every purged ollama slug so tenant copies are swept too', () => {
      // Seeds are create-only: deleting the seed row leaves an already-
      // materialised tenant row pointing at a catalog entry nothing serves.
      for (const slug of PURGED_OLLAMA_SLUGS) {
        expect(RETIRED_AI_MODEL_SLUGS, `${slug} must be in the retired ledger`).toContain(slug);
      }
    });

    it('keeps the retired ledger disjoint from the live catalog', () => {
      const live = new Set(DEFAULT_AI_MODELS.map((m) => m.slug));
      const overlap = RETIRED_AI_MODEL_SLUGS.filter((slug) => live.has(slug));
      expect(overlap).toEqual([]);
    });
  });
});
