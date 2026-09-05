// lane A.1 — `db-config` on the READ path.
//
// Before this, `resolveEffective` served `pipeline.*`, `models.*` and
// `global-kv` and threw "No effective resolver is registered" for everything
// else. `EffectiveConfigService.resolveKey` catches that and degrades, so
// declaring `consumedBy` on a `db-config` key compiled, deployed, and served
// `null` FOREVER. Three Phase-2 lanes hit that wall independently.
//
// The fix is a DISPATCH branch, not a new store: each key family goes to the
// service that owns its table, exactly as `models.*` delegates to
// `AiTaskDefaultService`. This file pins the properties that make the branch
// safe to widen later.

import { ArgumentInvalidException } from '@arcaai/exceptions';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigResolver } from '../../config-resolver/config-resolver.service';
import type { PlatformStorageSettingsResolver } from '../../tenant-storage-config/platform-storage-settings.resolver';
import { EffectiveSettingsService } from '../effective-settings.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const ctx = { tenantId: SYSTEM_TENANT_ID, departmentId: null, doctorId: null };

const configResolver = {} as unknown as ConfigResolver;

function storageResolver(impl: Partial<PlatformStorageSettingsResolver> = {}): PlatformStorageSettingsResolver {
  return {
    resolves: vi.fn((key: string) => key.startsWith('storage.platformDefault.') && key !== 'storage.platformDefault.credentials'),
    resolve: vi.fn(async () => undefined),
    ...impl,
  } as unknown as PlatformStorageSettingsResolver;
}

function service(storage?: PlatformStorageSettingsResolver): EffectiveSettingsService {
  return new EffectiveSettingsService(configResolver, undefined, undefined, storage);
}

describe('EffectiveSettingsService — the db-config lane', () => {
  it('serves a db-config key through the resolver that owns its table', async () => {
    const svc = service(storageResolver({ resolve: vi.fn(async () => ({ value: 'ap-south-1', sourceScope: 'system' })) }));

    await expect(svc.resolveEffective('storage.platformDefault.region', ctx)).resolves.toEqual({
      key: 'storage.platformDefault.region',
      tier: 'db-config',
      value: 'ap-south-1',
      // The tier that ACTUALLY answered, so an operator can see why the value
      // is what it is — not a blanket 'db-config' echo of the declared tier.
      sourceScope: 'system',
    });
  });

  it('applies the DECLARED failMode when the cascade bottoms out with no value', async () => {
    const svc = service(storageResolver({ resolve: vi.fn(async () => undefined) }));

    // `storage.platformDefault.region` is `open-to-default` ⇒ the descriptor
    // default, labelled `code-default` so it is distinguishable from a stored
    // value that happens to equal it.
    await expect(svc.resolveEffective('storage.platformDefault.region', ctx)).resolves.toEqual({
      key: 'storage.platformDefault.region',
      tier: 'db-config',
      value: 'us-east-1',
      sourceScope: 'code-default',
    });
  });

  it('RAISES for a db-config key with no resolution lane, rather than reporting null', async () => {
    // Specimen changed in TASK-872. It was `stt.fallback.pipelineSlug` — the
    // registry's only db-config + `failMode: 'closed'` key — under the title
    // "fails CLOSED … selection never falls back". That title overstated what
    // ran: `failMode` is never consulted on this path. A db-config key that
    // dispatches to no family resolver falls through every lane to the final
    // throw, whatever its declared mode, and THAT is the contract worth
    // pinning — a read surface must never answer "null" for a key it simply
    // cannot resolve. `tts.defaultVoiceEn` is the specimen now: tenant-varying,
    // so per D-1 it travels the push channel and deliberately has no lane here.
    const svc = service(storageResolver());
    await expect(svc.resolveEffective('tts.defaultVoiceEn', ctx)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('PROPAGATES a backend error rather than substituting the default', async () => {
    const boom = new Error('connection terminated unexpectedly');
    const svc = service(storageResolver({ resolve: vi.fn(async () => Promise.reject(boom)) }));

    // The rule from rule 09: `failMode` governs an ABSENT VALUE only. An
    // unreachable control plane must surface as a failure, or a fail-open knob
    // becomes a way to disguise an outage as "the default".
    await expect(svc.resolveEffective('storage.platformDefault.region', ctx)).rejects.toThrow('connection terminated unexpectedly');
  });

  it('REFUSES the secret credentials pointer even though it shares the prefix', async () => {
    const svc = service(storageResolver());
    // `storage.platformDefault.credentials` is the Vault `credentialsRef`
    // pointer: `sensitivity: 'secret'`, refused before any dispatch happens.
    await expect(svc.resolveEffective('storage.platformDefault.credentials', ctx)).rejects.toThrow(/is a secret/);
  });

  it('still raises for a db-config key no resolver claims — silence is the bug being fixed', async () => {
    const svc = service(storageResolver());
    // `tts.defaultVoiceEn` is db-config and tenant-scoped: it travels the PUSH
    // channel (D-1) and has no pull resolver. An explicit throw keeps that
    // visible instead of serving a plausible null.
    await expect(svc.resolveEffective('tts.defaultVoiceEn', ctx)).rejects.toThrow(/No effective resolver is registered/);
  });

  it('leaves an unwired graph on the declared failMode rather than throwing a DI error', async () => {
    const svc = service(undefined);
    await expect(svc.resolveEffective('storage.platformDefault.region', ctx)).resolves.toMatchObject({ sourceScope: 'code-default' });
  });
});
