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
import {
  BUILT_IN_ENGINE_CARDS,
  BUILT_IN_PROVIDERS_BY_SERVICE,
  BUILT_IN_PROVIDER_ENTRIES,
  MODEL_REGISTRY_CARDS,
  PROVIDERS_BY_SERVICE,
  classOf,
  cloudProvidersFor,
} from '../provider-meta';

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

/**
 * `PLATFORM_SELF_HOST_PROVIDERS`, verbatim — a DIFFERENT gateway constant from
 * `ENGINE_SERVED_PROVIDERS` above, and the distinction is the point of
 * TASK-952 D-1c: the `llm` engines are the platform's completion servers, while
 * `embeddings:tei-embed` is its dense-embeddings server. Both are platform-tier
 * only (a tenant row for either is a 403) but they are governed by separate
 * lists, so this file mirrors both.
 *
 * The three `tts` entries are deliberately excluded below: those engines run
 * IN-PROCESS inside `apps/tts` with no endpoint and no credential, so a card
 * would have nothing on it — the same reason `built-in` has none.
 */
const GATEWAY_PLATFORM_SELF_HOST: Record<string, readonly string[]> = {
  embeddings: ['tei-embed'],
};

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

  /**
   * TASK-983 R2 — the Sarvam STT card had `fields: []`, so the ONE thing its
   * runtime cannot work without had nowhere to be typed.
   *
   * TASK-880 deleted the `stt.sarvam.baseUrl` platform setting and moved the
   * endpoint onto the connection row: `sarvam_loader.py` raises
   * `CloudASRAuthError` unless the SAME row carries a key AND a `baseUrl`. The
   * SYSTEM row only worked because the seed hand-writes `https://api.sarvam.ai`
   * — which the seed itself flags as not PHI-safe — and a TENANT bringing its
   * own Sarvam account could never produce a usable row from this console.
   * `tts:sarvam` and `stt:openai` carried the field all along; only this card
   * was missed.
   */
  it('gives every cloud STT card the endpoint its loader requires (TASK-983 R2)', () => {
    for (const provider of ['sarvam', 'openai']) {
      const card = PROVIDERS_BY_SERVICE.stt.find((p) => p.id === provider);
      expect(card, `no stt:${provider} card`).toBeDefined();
      expect(card!.fields.some((f) => f.name === 'baseUrl'), `stt:${provider} offers no baseUrl field`).toBe(true);
    }
  });

  it('never calls an STT endpoint OPTIONAL where the loader refuses the row without it', () => {
    // `openai_loader.py` has no default base URL either — the label said
    // "(optional)" while the write path (PROVIDER_REQUIREMENTS) refuses it.
    for (const provider of ['sarvam', 'openai']) {
      const label = PROVIDERS_BY_SERVICE.stt.find((p) => p.id === provider)!.fields.find((f) => f.name === 'baseUrl')!.label;
      expect(label, `stt:${provider} labels a required endpoint optional`).not.toMatch(/optional/i);
    }
  });

  it('warns on the Sarvam card that the public endpoint is not PHI-safe (OD-2)', () => {
    const sarvam = PROVIDERS_BY_SERVICE.stt.find((p) => p.id === 'sarvam')!;
    expect(sarvam.hint ?? '', 'the Sarvam card carries no BAA warning').toMatch(/BAA|PHI/i);
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

  it('renders a card for every platform self-host serving provider that has an endpoint (TASK-952 D-1c)', () => {
    for (const [service, expected] of Object.entries(GATEWAY_PLATFORM_SELF_HOST)) {
      const rendered = (BUILT_IN_PROVIDERS_BY_SERVICE[service as keyof typeof PROVIDERS_BY_SERVICE] ?? []).map((p) => p.id);
      expect([...rendered].sort(), `${service} has a platform self-host provider with no card`).toEqual([...expected].sort());
    }
  });

  it("names the TEI embeddings model — the harness has no default for it any more", () => {
    // `embeddings_model` lost its `text-embedding-bge-m3` literal AND its env var
    // (a model id is a SELECTION, not config-in-code). This row is the only home
    // the platform's embeddings model has, and `PROVIDER_REQUIREMENTS` refuses an
    // enabled row without it — so a card with no model field would leave a
    // platform admin unable to satisfy the 400 they are shown.
    const tei = (BUILT_IN_PROVIDERS_BY_SERVICE.embeddings ?? []).find((p) => p.id === 'tei-embed')!;
    expect(tei, 'no `embeddings:tei-embed` card — the connection is writable and unreachable').toBeDefined();
    expect(tei.fields.some((f) => f.name === 'baseUrl')).toBe(true);
    expect(tei.fields.some((f) => f.name === 'model' && f.store === 'extra')).toBe(true);
  });

  it('pairs every platform card with its OWN service, never a hardcoded one', () => {
    // The screen used to render every built-in card under a literal
    // `service="llm"`. Writing the TEI endpoint to `llm:tei-embed` would create a
    // row nothing resolves, so the service now travels WITH the card.
    expect(BUILT_IN_PROVIDER_ENTRIES.map((e) => `${e.service}:${e.meta.id}`).sort()).toEqual(
      ['llm:lm-studio', 'llm:ollama', 'llm:vllm', 'llm:llama-cpp', 'embeddings:tei-embed'].sort(),
    );
  });

  it('keeps the platform planes out of the cloud lists entirely', () => {
    expect(cloudProvidersFor('model-registry')).toHaveLength(0);
    expect(cloudProvidersFor('rerank')).toHaveLength(0);
  });
});
