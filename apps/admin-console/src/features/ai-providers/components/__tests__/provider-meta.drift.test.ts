/**
 * Drift gate for the per-service PROVIDER lists.
 *
 * `provider-services.drift.test.ts` pins the CAPABILITY list (the tab bar)
 * against the gateway's own `:service` enum. Nothing pinned the providers
 * INSIDE a tab, and the same failure recurred one level down: TASK-880 split
 * `stt:azure-foundry` out of `stt:azure-speech` — deliberately, because a
 * Foundry resource has a different data-residency posture and one credential
 * gating both meant a tenant could not enable Speech without also enabling a
 * PREVIEW service for its PHI — and the console kept a single "Azure Speech"
 * card whose endpoint field was LABELLED "(Azure Foundry resource)". So
 * `PUT /admin/providers/stt/azure-foundry` worked, had no button, and an admin
 * filling in the field they were pointed at wrote the OTHER row.
 *
 * The gateway does not project a per-service provider enum (the `:provider`
 * path parameter carries no enum), so this mirrors `CLOUD_BYO_PROVIDERS` in
 * `packages/applications/src/services/ai-provider-connection/constants.ts`
 * by hand. When the two disagree, the fix is to update `../provider-meta.ts`
 * — never to relax the expectation.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDERS_BY_SERVICE } from '../provider-meta';

/** `CLOUD_BYO_PROVIDERS`, verbatim, in the order an admin reads the cards. */
const GATEWAY_CLOUD_BYO: Record<string, readonly string[]> = {
  llm: ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
  stt: ['azure-speech', 'azure-foundry', 'sarvam', 'openai'],
  tts: ['azure', 'sarvam'],
  embeddings: ['azure', 'openai'],
  rerank: [],
  vector: ['qdrant'],
};

describe('PROVIDERS_BY_SERVICE mirrors the gateway BYO declaration', () => {
  for (const [service, expected] of Object.entries(GATEWAY_CLOUD_BYO)) {
    it(`renders a card for every tenant-writable ${service} provider`, () => {
      const rendered = PROVIDERS_BY_SERVICE[service as keyof typeof PROVIDERS_BY_SERVICE].map((p) => p.id);
      expect([...rendered].sort()).toEqual([...expected].sort());
    });
  }

  it('keeps Azure Foundry addressable on its own card, not on the Azure Speech one', () => {
    const stt = PROVIDERS_BY_SERVICE.stt;
    const foundry = stt.find((p) => p.id === 'azure-foundry');
    const speech = stt.find((p) => p.id === 'azure-speech');

    expect(foundry, 'no `azure-foundry` card — the connection is writable and unreachable').toBeDefined();
    expect(foundry!.fields.some((f) => f.name === 'baseUrl')).toBe(true);
    // The Speech card must no longer claim its endpoint is the Foundry resource.
    expect(speech!.fields.find((f) => f.name === 'baseUrl')?.label ?? '').not.toMatch(/foundry/i);
  });

  it('model-registry stays SYSTEM-only with both weight-fetch cards (rerank is the empty one)', () => {
    expect(PROVIDERS_BY_SERVICE['model-registry'].map((p) => p.id)).toEqual(['huggingface', 's3']);
    expect(PROVIDERS_BY_SERVICE.rerank).toHaveLength(0);
  });
});
