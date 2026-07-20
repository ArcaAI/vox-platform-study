// TASK-525 §4.1 — the frozen per-service effective-config contract.
//
// The service resolves the SERVICE-LEVEL subset only: retention, concurrency and
// runtime profiles. It never carries per-request model selection — SMR's
// stateless-gateway contract (`apps/smr/src/smr_v2/core/config.py:1-9`) is
// preserved verbatim, so a regression here would break that house constraint.

import { ArgumentInvalidException } from '@arcaai/exceptions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import type { IAiRuntimeProfileService } from '../../ai-runtime-profile/IAiRuntimeProfileService';
import type { AiRuntimeProfileResponse } from '../../ai-runtime-profile/dto';
import { EffectiveConfigService } from '../effective-config.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

function profile(over: Partial<AiRuntimeProfileResponse> = {}): AiRuntimeProfileResponse {
  return {
    tenantId: SYSTEM_TENANT_ID,
    provider: 'ollama',
    modelSlug: '',
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 2048,
    contextLength: 8192,
    maxConcurrent: 6,
    tpmLimit: null,
    rpmLimit: null,
    timeoutS: 120,
    keepAliveSeconds: null,
    extraJson: null,
    version: 1,
    ...over,
  };
}

/** A row that exists but carries no opinion on any tunable — service env wins. */
function emptyProfile(): AiRuntimeProfileResponse {
  return profile({
    temperature: null,
    topP: null,
    maxTokens: null,
    contextLength: null,
    maxConcurrent: null,
    timeoutS: null,
  });
}

/**
 * `resolveEffective` is per-key, so the stub is a key→result map. An absent key
 * resolves to its descriptor default with `sourceScope: 'code-default'` — the
 * "no DB override" case that must surface as `env-fallback`.
 */
function settingsStub(overrides: Record<string, unknown> = {}) {
  return {
    resolveEffective: vi.fn(async (key: string) => ({
      key,
      tier: 'global-kv',
      value: key in overrides ? overrides[key] : DEFAULTS[key],
      sourceScope: key in overrides ? 'global-kv' : 'code-default',
    })),
  } as unknown as EffectiveSettingsService;
}

// The code defaults the STT descriptors must carry (today's Python values).
const DEFAULTS: Record<string, unknown> = {
  'stt.modelCache.maxModels': 5,
  'stt.modelCache.ttlSeconds': 3600,
  'stt.modelCache.maxMemoryMb': 10000,
  'stt.workers.concurrency': 4,
  'stt.streaming.maxConcurrent': 0,
  'nlp.inference.maxConcurrent': 4,
};

function serviceWith(settings: EffectiveSettingsService, profiles: Array<AiRuntimeProfileResponse> = []): EffectiveConfigService {
  const runtimeProfiles = {
    list: vi.fn(async () => profiles),
  } as unknown as IAiRuntimeProfileService;
  return new EffectiveConfigService(settings, runtimeProfiles);
}

describe('EffectiveConfigService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an unknown service name (→ 400)', async () => {
    const svc = serviceWith(settingsStub());
    await expect(svc.resolveForService('not-a-service')).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('stamps the service name and an ISO-8601 generatedAt', async () => {
    const svc = serviceWith(settingsStub());
    const res = await svc.resolveForService('smr');
    expect(res.service).toBe('smr');
    expect(res.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  describe('per-service subset filtering', () => {
    it('serves smr runtimeProfiles and NOT retention (service-level knobs only)', async () => {
      const svc = serviceWith(settingsStub(), [profile()]);
      const res = await svc.resolveForService('smr');

      expect(res.runtimeProfiles).toHaveLength(1);
      expect(res.runtimeProfiles?.[0]).toMatchObject({
        provider: 'ollama',
        maxConcurrent: 6,
        timeoutS: 120,
        source: 'db',
      });
      expect(res.retention).toBeUndefined();
    });

    it('serves nlp runtimeProfiles plus concurrency.maxConcurrent', async () => {
      const svc = serviceWith(settingsStub(), [profile({ provider: 'nlp-local' })]);
      const res = await svc.resolveForService('nlp');

      expect(res.runtimeProfiles).toHaveLength(1);
      expect(res.concurrency?.maxConcurrent).toBe(4);
      expect(res.retention).toBeUndefined();
    });

    it('serves stt-v2 retention + worker/streaming concurrency, and NO runtimeProfiles', async () => {
      const svc = serviceWith(settingsStub(), [profile()]);
      const res = await svc.resolveForService('stt-v2');

      expect(res.retention).toMatchObject({ ttlSeconds: 3600, maxModels: 5, maxMemoryMb: 10000 });
      expect(res.concurrency).toMatchObject({ workerConcurrency: 4, streamingMaxConcurrent: 0 });
      expect(res.runtimeProfiles).toBeUndefined();
    });

    it.each(['guardrail', 'harness', 'tts-v2'])('serves %s a reserved (empty) subset', async (name) => {
      const svc = serviceWith(settingsStub(), [profile()]);
      const res = await svc.resolveForService(name);

      expect(res.service).toBe(name);
      expect(res.runtimeProfiles).toBeUndefined();
      expect(res.retention).toBeUndefined();
      expect(res.concurrency).toBeUndefined();
    });
  });

  describe('source stamping (operators must see which lane is live)', () => {
    it('stamps env-fallback when no DB override exists', async () => {
      const svc = serviceWith(settingsStub());
      const res = await svc.resolveForService('stt-v2');

      expect(res.retention?.source).toBe('env-fallback');
      expect(res.concurrency?.source).toBe('env-fallback');
    });

    it('stamps db when the registry write-lane supplied the value', async () => {
      const svc = serviceWith(settingsStub({ 'stt.modelCache.ttlSeconds': 900 }));
      const res = await svc.resolveForService('stt-v2');

      expect(res.retention?.ttlSeconds).toBe(900);
      expect(res.retention?.source).toBe('db');
    });

    it('stamps a runtime profile env-fallback when the row carries no opinion', async () => {
      const svc = serviceWith(settingsStub(), [emptyProfile()]);
      const res = await svc.resolveForService('smr');

      expect(res.runtimeProfiles?.[0].source).toBe('env-fallback');
    });
  });

  describe('house constraint: never leaks per-request model selection', () => {
    it('omits any model-selection field from the smr payload', async () => {
      const svc = serviceWith(settingsStub(), [profile({ modelSlug: 'llama3:8b' })]);
      const res = await svc.resolveForService('smr');

      // modelSlug identifies WHICH profile row applies; it must never be
      // presented as a selection directive alongside a `model`/`provider` choice.
      const payload = res.runtimeProfiles?.[0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('model');
      expect(payload).not.toHaveProperty('selectedModel');
      expect(payload).not.toHaveProperty('defaultModel');
    });
  });

  describe('resilience: a control-plane read failure must not fail the endpoint', () => {
    it('degrades to env-fallback when the settings facade throws', async () => {
      const settings = {
        resolveEffective: vi.fn(async () => {
          throw new Error('appSettings cache cold');
        }),
      } as unknown as EffectiveSettingsService;
      const svc = serviceWith(settings);

      const res = await svc.resolveForService('stt-v2');
      expect(res.retention?.source).toBe('env-fallback');
      expect(res.retention?.ttlSeconds).toBeNull();
    });
  });
});
