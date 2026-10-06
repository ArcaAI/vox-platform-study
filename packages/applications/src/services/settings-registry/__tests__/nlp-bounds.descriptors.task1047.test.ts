// TASK-1047 L8 — the NLP bounded-inference knobs (FC-8) and the guardrail window-cache
// key (FC-7) are governed: registered, resolvable on the pull route, defaults frozen.

import { describe, expect, it } from 'vitest';
import { effectiveResolverLane } from '../effective-settings.service';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { toEnvVarName } from '../registry.types';
import { PLATFORM_SECRET_SETTINGS } from '../descriptors/platform-secrets.descriptors';
import { SERVICE_RUNTIME_DEFAULTS } from '../descriptors/service-runtime.descriptors';

const FC8 = {
  'nlp.inference.maxInputChars': 8192,
  'nlp.inference.maxInputWords': 2048,
  'nlp.inference.threadsPerInference': 0,
  'nlp.worker.recycleAfterRequests': 2000,
  'nlp.worker.recycleRssMib': 6144,
} as const;

describe('FC-8 NLP bound settings', () => {
  for (const [key, def] of Object.entries(FC8)) {
    describe(key, () => {
      const d = () => HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      it('is registered with the frozen default', () => {
        expect(d().default).toBe(def);
        expect((SERVICE_RUNTIME_DEFAULTS as Record<string, unknown>)[key]).toBe(def);
      });
      it('is a platform-scope, open-to-default number served to nlp', () => {
        expect(d().tier).toBe('global-kv');
        expect(d().dataType).toBe('number');
        expect(d().maxScope).toBe('system');
        expect(d().globalOnly).toBe(true);
        expect(d().failMode).toBe('open-to-default');
        expect(d().consumedBy).toEqual(['nlp']);
        expect(effectiveResolverLane(d())).not.toBeNull();
        expect(d().description.length).toBeGreaterThan(40);
      });
    });
  }
});

describe('FC-7 guardrail.windowCacheKey', () => {
  const d = () => PLATFORM_SECRET_SETTINGS.find((s) => s.key === 'guardrail.windowCacheKey');
  it('is a registered vault-kv platform secret named GUARDRAIL_WINDOW_CACHE_KEY', () => {
    expect(d()).toBeDefined();
    expect(toEnvVarName('guardrail.windowCacheKey')).toBe('GUARDRAIL_WINDOW_CACHE_KEY');
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow('guardrail.windowCacheKey').tier).toBe('vault-kv');
  });
  it('fails closed, platform scope, no default', () => {
    expect(d()!.failMode).toBe('closed');
    expect(d()!.maxScope).toBe('system');
    expect(d()!.sensitivity).toBe('secret');
    expect(d()!.default).toBeUndefined();
  });
});
