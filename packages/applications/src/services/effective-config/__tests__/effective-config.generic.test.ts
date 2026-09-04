// The GENERIC pull channel: registry-driven, typed, non-numeric-capable.
//
// Before this, `EffectiveConfigService` typed `ResolvedKey.value` as
// `number | null` and coerced anything else to the code default, so a string,
// boolean, enum, URL or label taxonomy could not traverse the DB→Python channel
// AT ALL. Every test below fails against that shape. They are the lock on the
// property Phase 2's ~150 variable migrations depend on: a value of the
// DECLARED dataType survives the pull path INTACT, and a value of the WRONG
// type is refused rather than silently replaced.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import type { SettingDescriptor } from '../../settings-registry/registry.types';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import type { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import { EffectiveConfigService } from '../effective-config.service';

/**
 * Register throwaway descriptors of every non-numeric dataType against a real
 * service name, so the assertions run through the SAME registry query the
 * production path uses rather than a parallel fixture registry.
 */
const PROBE_KEYS = {
  string: 'stt.__probe.stringKey',
  boolean: 'stt.__probe.booleanKey',
  enum: 'stt.__probe.enumKey',
  stringArray: 'stt.__probe.stringArrayKey',
  json: 'stt.__probe.jsonKey',
  secret: 'stt.__probe.secretKey',
} as const;

function probe(key: string, dataType: SettingDescriptor['dataType'], over: Partial<SettingDescriptor> = {}): SettingDescriptor {
  return {
    key,
    tier: 'global-kv',
    dataType,
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Service Runtime',
    consumedBy: ['stt'],
    ...over,
  };
}

const PROBE_DESCRIPTORS: SettingDescriptor[] = [
  probe(PROBE_KEYS.string, 'string', { default: 'bootstrap-value' }),
  probe(PROBE_KEYS.boolean, 'boolean', { default: false }),
  probe(PROBE_KEYS.enum, 'enum', { default: 'balanced' }),
  probe(PROBE_KEYS.stringArray, 'string[]', { default: ['a', 'b'] }),
  probe(PROBE_KEYS.json, 'json', { default: { nested: true } }),
  // A secret must NEVER reach the wire, whatever a descriptor declares.
  probe(PROBE_KEYS.secret, 'secret', { sensitivity: 'secret', failMode: 'closed' }),
];

let registered = false;
function registerProbes(): void {
  if (registered) return;
  HOPE_SETTINGS_REGISTRY.registerAll(PROBE_DESCRIPTORS);
  registered = true;
}

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

describe('effective-config: the generic, typed settings channel', () => {
  beforeEach(() => {
    registerProbes();
    vi.clearAllMocks();
  });

  describe('A.2 — a non-numeric value survives the pull path INTACT', () => {
    it('carries a STRING override through without coercing it to the default', async () => {
      const svc = serviceWith(settingsStub({ [PROBE_KEYS.string]: 'operator-set-value' }));
      const res = await svc.resolveForService('stt');

      expect(res.settings?.[PROBE_KEYS.string]).toEqual({
        value: 'operator-set-value',
        dataType: 'string',
        source: 'db',
      });
    });

    it('carries a BOOLEAN override through — including `false`, which must not read as absent', async () => {
      const svc = serviceWith(settingsStub({ [PROBE_KEYS.boolean]: true }));
      const res = await svc.resolveForService('stt');
      expect(res.settings?.[PROBE_KEYS.boolean]).toEqual({ value: true, dataType: 'boolean', source: 'db' });

      const off = serviceWith(settingsStub({ [PROBE_KEYS.boolean]: false }));
      const offRes = await off.resolveForService('stt');
      expect(offRes.settings?.[PROBE_KEYS.boolean]).toEqual({ value: false, dataType: 'boolean', source: 'db' });
    });

    it('carries enum, string[] and json overrides through unchanged', async () => {
      const taxonomy = ['person', 'email', 'national_id'];
      const svc = serviceWith(
        settingsStub({
          [PROBE_KEYS.enum]: 'aggressive',
          [PROBE_KEYS.stringArray]: taxonomy,
          [PROBE_KEYS.json]: { window: 512, mode: 'windowed' },
        }),
      );
      const res = await svc.resolveForService('stt');

      expect(res.settings?.[PROBE_KEYS.enum]?.value).toBe('aggressive');
      expect(res.settings?.[PROBE_KEYS.stringArray]?.value).toEqual(taxonomy);
      expect(res.settings?.[PROBE_KEYS.json]?.value).toEqual({ window: 512, mode: 'windowed' });
    });

    it('reports the descriptor default as env-fallback when no override exists', async () => {
      const svc = serviceWith(settingsStub());
      const res = await svc.resolveForService('stt');

      expect(res.settings?.[PROBE_KEYS.string]).toEqual({ value: 'bootstrap-value', dataType: 'string', source: 'env-fallback' });
      expect(res.settings?.[PROBE_KEYS.stringArray]?.value).toEqual(['a', 'b']);
    });
  });

  describe('type discipline: refuse, never coerce', () => {
    it('refuses a value of the wrong declared type and degrades to null (never a silent substitution)', async () => {
      const svc = serviceWith(settingsStub({ [PROBE_KEYS.string]: 42 }));
      const res = await svc.resolveForService('stt');

      expect(res.settings?.[PROBE_KEYS.string]).toEqual({ value: null, dataType: 'string', source: 'env-fallback' });
    });

    it('never serves a secret-sensitivity descriptor on the wire', async () => {
      const svc = serviceWith(settingsStub({ [PROBE_KEYS.secret]: 'super-secret' }));
      const res = await svc.resolveForService('stt');

      expect(res.settings?.[PROBE_KEYS.secret]).toBeUndefined();
      expect(JSON.stringify(res)).not.toContain('super-secret');
    });
  });

  describe('A.1 — the payload is a registry QUERY, not a per-service switch', () => {
    it('serves a key ONLY to the deployables its descriptor names', async () => {
      const svc = serviceWith(settingsStub());

      // The probes declare `consumedBy: ['stt']` and nothing else.
      expect((await svc.resolveForService('stt')).settings?.[PROBE_KEYS.string]).toBeDefined();
      for (const other of ['text', 'nlp', 'guardrail', 'harness', 'tts']) {
        expect((await svc.resolveForService(other)).settings?.[PROBE_KEYS.string], other).toBeUndefined();
      }
    });

    it('serves every registry key that names the service — no hand-written case list', async () => {
      const svc = serviceWith(settingsStub());
      const res = await svc.resolveForService('nlp');

      const expected = HOPE_SETTINGS_REGISTRY.list()
        .filter((d) => d.consumedBy?.includes('nlp') && d.sensitivity !== 'secret')
        .map((d) => d.key)
        .sort();

      expect(expected.length).toBeGreaterThan(0);
      expect(Object.keys(res.settings ?? {}).sort()).toEqual(expected);
    });
  });

  describe('resilience is unchanged: a control-plane failure never fails the endpoint', () => {
    it('degrades every key to a null value rather than throwing', async () => {
      const settings = {
        resolveEffective: vi.fn(async () => {
          throw new Error('appSettings cache cold');
        }),
      } as unknown as EffectiveSettingsService;
      const svc = serviceWith(settings);

      const res = await svc.resolveForService('stt');
      expect(res.settings?.[PROBE_KEYS.string]).toEqual({ value: null, dataType: 'string', source: 'env-fallback' });
      expect(res.retention?.ttlSeconds).toBeNull();
    });
  });
});
