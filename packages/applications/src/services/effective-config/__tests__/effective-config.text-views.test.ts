// A.1 — the two TEXT views that lane B could not land.
//
// `apps/text` was written against BOTH groups before either existed
// (`core/effective_config.py::external_guardrail` / `::generation_defaults`
// read `raw["externalGuardrail"]` / `raw["generation"]`), and degraded
// correctly meanwhile: an absent group keeps the in-code floor. That is what
// made the gap invisible — the descriptors were registered, the keys resolved,
// and the service simply never saw them, because the response groups are
// hand-shaped VIEWS and `consumedBy` alone only reaches the generic `settings`
// map.
//
// Every test below fails before the two views exist.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import type { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import { EffectiveConfigService } from '../effective-config.service';

/** Key → the value the override lane reports; absent keys resolve code-default. */
function settingsStub(overrides: Record<string, unknown> = {}) {
  return {
    resolveEffective: vi.fn(async (key: string) => {
      const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      return {
        key,
        tier: descriptor.tier,
        value: key in overrides ? overrides[key] : descriptor.default,
        sourceScope: key in overrides ? 'system' : 'code-default',
      };
    }),
  } as unknown as EffectiveSettingsService;
}

function serviceWith(settings: EffectiveSettingsService): EffectiveConfigService {
  const runtimeProfiles = { list: vi.fn(async () => []) } as unknown as IProviderConnectionService;
  return new EffectiveConfigService(settings, runtimeProfiles);
}

describe('effective-config: the TEXT externalGuardrail view', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves the four posture fields under the exact names apps/text reads — no switch, no requireMedical', async () => {
    const response = await serviceWith(settingsStub()).resolveForService('text');

    expect(response.externalGuardrail).toEqual({
      timeoutS: 120,
      maxRetries: 2,
      retryBackoffMs: 100,
      includeReasoning: false,
      source: 'env-fallback',
    });
  });

  it('a stored platform row reaches the wire and reads as `db`', async () => {
    const response = await serviceWith(
      settingsStub({
        'text.externalGuardrail.timeoutS': 25,
        'text.externalGuardrail.includeReasoning': true,
      }),
    ).resolveForService('text');

    expect(response.externalGuardrail).toEqual({
      timeoutS: 25,
      maxRetries: 2,
      retryBackoffMs: 100,
      includeReasoning: true,
      source: 'db',
    });
  });

  it('refuses a value of the wrong declared type — null, never a substituted default', async () => {
    // `includeReasoning` is declared boolean. A string must NOT become `true`, and must
    // NOT quietly become the descriptor default either: null is what tells
    // apps/text to keep its own floor.
    const response = await serviceWith(settingsStub({ 'text.externalGuardrail.includeReasoning': 'yes' })).resolveForService('text');

    expect(response.externalGuardrail?.includeReasoning).toBeNull();
  });

  it('is omitted entirely for a service that declares none of the keys', async () => {
    const response = await serviceWith(settingsStub()).resolveForService('nlp');
    expect(response.externalGuardrail).toBeUndefined();
  });
});

describe('effective-config: the TEXT generation view', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves the platform generation profile under the names apps/text reads', async () => {
    const response = await serviceWith(settingsStub()).resolveForService('text');

    expect(response.generation).toEqual({
      temperature: 0.1,
      topP: 0.95,
      maxTokens: 16_384,
      // TASK-1001 OD-10 — neutral until a platform admin writes a value.
      frequencyPenalty: 0,
      presencePenalty: 0,
      source: 'env-fallback',
    });
  });

  it('a stored profile reaches the wire and reads as `db`', async () => {
    const response = await serviceWith(settingsStub({ 'text.generation.temperature': 0.7, 'text.generation.maxTokens': 4096 })).resolveForService(
      'text',
    );

    expect(response.generation).toEqual({ temperature: 0.7, topP: 0.95, maxTokens: 4096, frequencyPenalty: 0, presencePenalty: 0, source: 'db' });
  });

  // TASK-1001 OD-10 — the platform default for decode-time repetition pressure. A published
  // Agent's parameters cannot be edited, so THIS row is what reaches the fleet: it must arrive in
  // the same group, under the names apps/text reads, and mark the group `db`.
  it('a stored penalty row reaches the wire under `frequencyPenalty` / `presencePenalty`', async () => {
    const response = await serviceWith(
      settingsStub({
        'text.generation.frequencyPenalty': 0.4,
        'text.generation.presencePenalty': -0.25,
      }),
    ).resolveForService('text');

    expect(response.generation).toEqual({
      temperature: 0.1,
      topP: 0.95,
      maxTokens: 16_384,
      frequencyPenalty: 0.4,
      presencePenalty: -0.25,
      source: 'db',
    });
  });

  it('a penalty of the wrong declared type is refused as null — never a substituted default', async () => {
    const response = await serviceWith(settingsStub({ 'text.generation.frequencyPenalty': '0.4' })).resolveForService('text');

    expect(response.generation?.frequencyPenalty).toBeNull();
    expect(response.generation?.presencePenalty).toBe(0);
  });

  it('is omitted entirely for a service that declares none of the keys', async () => {
    const response = await serviceWith(settingsStub()).resolveForService('guardrail');
    expect(response.generation).toBeUndefined();
  });
});
