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
import type { IAiRuntimeProfileService } from '../../ai-runtime-profile/IAiRuntimeProfileService';
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
  const runtimeProfiles = { list: vi.fn(async () => []) } as unknown as IAiRuntimeProfileService;
  return new EffectiveConfigService(settings, runtimeProfiles);
}

describe('effective-config: the TEXT externalGuardrail view', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves the six posture fields under the exact names apps/text reads', async () => {
    const response = await serviceWith(settingsStub()).resolveForService('text');

    expect(response.externalGuardrail).toEqual({
      enabled: false,
      timeoutS: 10,
      maxRetries: 2,
      retryBackoffMs: 100,
      requireMedical: true,
      includeReasoning: false,
      source: 'env-fallback',
    });
  });

  it('a stored platform row reaches the wire and reads as `db`', async () => {
    const response = await serviceWith(
      settingsStub({
        'text.externalGuardrail.enabled': true,
        'text.externalGuardrail.timeoutS': 25,
        'text.externalGuardrail.requireMedical': false,
      }),
    ).resolveForService('text');

    expect(response.externalGuardrail).toEqual({
      enabled: true,
      timeoutS: 25,
      maxRetries: 2,
      retryBackoffMs: 100,
      requireMedical: false,
      includeReasoning: false,
      source: 'db',
    });
  });

  it('refuses a value of the wrong declared type — null, never a substituted default', async () => {
    // `enabled` is declared boolean. A string must NOT become `true`, and must
    // NOT quietly become the descriptor default either: null is what tells
    // apps/text to keep its own floor.
    const response = await serviceWith(settingsStub({ 'text.externalGuardrail.enabled': 'yes' })).resolveForService('text');

    expect(response.externalGuardrail?.enabled).toBeNull();
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
      source: 'env-fallback',
    });
  });

  it('a stored profile reaches the wire and reads as `db`', async () => {
    const response = await serviceWith(settingsStub({ 'text.generation.temperature': 0.7, 'text.generation.maxTokens': 4096 })).resolveForService(
      'text',
    );

    expect(response.generation).toEqual({ temperature: 0.7, topP: 0.95, maxTokens: 4096, source: 'db' });
  });

  it('is omitted entirely for a service that declares none of the keys', async () => {
    const response = await serviceWith(settingsStub()).resolveForService('guardrail');
    expect(response.generation).toBeUndefined();
  });
});
