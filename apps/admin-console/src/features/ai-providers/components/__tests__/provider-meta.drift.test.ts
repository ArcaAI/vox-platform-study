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
 * path parameter carries no enum), so this mirrors the gateway constants in
 * `packages/applications/src/services/ai-provider-connection/constants.ts`
 * by hand. When the two disagree, the fix is to update `../provider-meta.ts`
 * — never to relax the expectation.
 *
 * TASK-932 widened what is mirrored. Until then this file pinned only
 * `CLOUD_BYO_PROVIDERS`, which is the list of what a TENANT may bring — so the
 * PLATFORM's own providers were, by construction, outside the gate that exists
 * to catch a provider with an API and no button. That is exactly what happened:
 * the four built-in engines had SYSTEM rows the seed wrote, endpoints
 * `apps/text` depends on, and no card anywhere in the console. The fixtures
 * below now cover all three classes.
 */

import { describe, expect, it } from 'vitest';
import { BUILT_IN_ENGINE_CARDS, MODEL_REGISTRY_CARDS, PROVIDERS_BY_SERVICE, classOf, cloudProvidersFor } from '../provider-meta';

/** `CLOUD_BYO_PROVIDERS`, verbatim, in the order an admin reads the cards. */
const GATEWAY_CLOUD_BYO: Record<string, readonly string[]> = {
  llm: ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
  stt: ['azure-speech', 'azure-foundry', 'sarvam', 'openai'],
  tts: ['azure', 'sarvam'],
  embeddings: ['azure', 'openai'],
  rerank: [],
  vector: ['qdrant'],
  // DELIBERATELY EMPTY on the gateway (owner ruling 2026-08-24): the whole
  // weight-fetch plane is platform-managed, so a tenant row is a 403 and — since
  // TASK-932 — a tenant read is a 404.
  'model-registry': [],
};

/**
 * `ENGINE_SERVED_PROVIDERS` minus the `lmstudio` spelling alias and `built-in`.
 *
 * The alias is a stored value the gateway folds, not a second engine, and
 * `built-in` runs in-process with no endpoint to configure — so neither is a
 * card. Everything else in that set must be reachable from this screen, because
 * its endpoint is the only thing standing between `apps/text` and a 503.
 */
const GATEWAY_ENGINE_SERVED: readonly string[] = ['lm-studio', 'ollama', 'vllm', 'llama-cpp'];

/** The two rows that can exist under `model-registry`, per the seed and the gateway. */
const GATEWAY_MODEL_REGISTRY: readonly string[] = ['huggingface', 's3'];

describe('the cloud vendor cards mirror the gateway BYO declaration', () => {
  for (const [service, expected] of Object.entries(GATEWAY_CLOUD_BYO)) {
    it(`renders a card for every tenant-writable ${service} provider`, () => {
      const rendered = cloudProvidersFor(service as keyof typeof PROVIDERS_BY_SERVICE).map((p) => p.id);
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

  it('never re-offers the `model` extras pin on an STT card (TASK-952 D-1)', () => {
    // Azure Speech / Azure Foundry never read the key at all; Sarvam / OpenAI
    // read it as an override-wins global pin that silently overrode whatever
    // model the agent had bound. Model identity is `AiModel`, declared
    // against the connection and bound to an agent by FK — not a console
    // text field. If this regresses, remove the `model` field again rather
    // than relaxing this assertion.
    for (const provider of PROVIDERS_BY_SERVICE.stt) {
      expect(
        provider.fields.some((f) => f.name === 'model'),
        `stt:${provider.id} re-declares the retired \`model\` extras field`,
      ).toBe(false);
    }
  });

  it('keeps the four STT provider ids and their order unchanged', () => {
    expect(PROVIDERS_BY_SERVICE.stt.map((p) => p.id)).toEqual(['azure-speech', 'azure-foundry', 'sarvam', 'openai']);
  });
});

describe('the platform-managed cards mirror the gateway platform planes (TASK-932)', () => {
  it('renders a card for every built-in inference engine an operator can address', () => {
    expect(BUILT_IN_ENGINE_CARDS.map((p) => p.id).sort()).toEqual([...GATEWAY_ENGINE_SERVED].sort());
  });

  it('gives every engine card an endpoint field — the endpoint is the whole point of the card', () => {
    for (const card of BUILT_IN_ENGINE_CARDS) {
      expect(card.fields.some((f) => f.name === 'baseUrl'), `${card.id} has no endpoint field`).toBe(true);
    }
  });

  it("names llama.cpp's model path — the endpoint alone does not identify what will answer", () => {
    const llamaCpp = BUILT_IN_ENGINE_CARDS.find((p) => p.id === 'llama-cpp')!;
    expect(llamaCpp.fields.some((f) => f.name === 'modelPath' && f.store === 'extra')).toBe(true);
  });

  it('renders both weight-fetch cards, classed as built-in rather than as vendor accounts', () => {
    expect(MODEL_REGISTRY_CARDS.map((p) => p.id)).toEqual([...GATEWAY_MODEL_REGISTRY]);
    for (const card of MODEL_REGISTRY_CARDS) expect(classOf(card)).toBe('built-in');
  });

  it('classes every engine card `engine-served`, so no tenant tier can render one', () => {
    for (const card of BUILT_IN_ENGINE_CARDS) expect(classOf(card)).toBe('engine-served');
  });

  it('keeps the platform planes out of the cloud lists entirely', () => {
    expect(cloudProvidersFor('model-registry')).toHaveLength(0);
    expect(cloudProvidersFor('rerank')).toHaveLength(0);
  });
});
