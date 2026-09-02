/**
 * resolveModelRegistryCredential — the shared body behind BOTH
 * `GET /internal/model-registry-credential` (generic, TASK-855 follow-on)
 * and the superseded `GET /internal/stt/model-registry-credential`
 * (`SttInternalController`, TASK-799). One implementation, two routes.
 */
import { BadRequestException } from '@nestjs/common';
import type { IActiveUserContext, IProviderConnectionService, ResolvedProviderCredential } from '@arcaai/applications';
import type { ClsService } from 'nestjs-cls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveModelRegistryCredential } from '../model-registry-credential.util';

const RESOLVED: ResolvedProviderCredential = { outcome: 'resolved', apiKey: 'secret', baseUrl: 'https://s3.internal' };

function fakeCls() {
  const store = new Map<string, unknown>();
  return {
    store,
    run: vi.fn((fn: () => unknown) => fn()),
    set: vi.fn((key: string, value: unknown) => void store.set(key, value)),
    get: vi.fn((key: string) => store.get(key)),
  };
}

describe('resolveModelRegistryCredential', () => {
  let resolveCredential: ReturnType<typeof vi.fn>;
  let providerConnections: IProviderConnectionService;
  let cls: ReturnType<typeof fakeCls>;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveCredential = vi.fn(async () => RESOLVED);
    providerConnections = { resolveCredential } as unknown as IProviderConnectionService;
    cls = fakeCls();
  });

  it('rejects a missing provider before touching the service', async () => {
    await expect(
      resolveModelRegistryCredential(providerConnections, cls as unknown as ClsService<IActiveUserContext>, undefined, 'tenant-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('rejects a missing tenantId before touching the service', async () => {
    await expect(
      resolveModelRegistryCredential(providerConnections, cls as unknown as ClsService<IActiveUserContext>, 's3', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('rejects when the provider-connection plane is unwired', async () => {
    await expect(resolveModelRegistryCredential(undefined, cls as unknown as ClsService<IActiveUserContext>, 's3', 'tenant-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects when CLS is unwired', async () => {
    await expect(resolveModelRegistryCredential(providerConnections, undefined, 's3', 'tenant-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pins CLS to the requested tenant BEFORE resolving, and calls resolveCredential("model-registry", provider, tenantId)', async () => {
    const result = await resolveModelRegistryCredential(providerConnections, cls as unknown as ClsService<IActiveUserContext>, 's3', ' tenant-1 ');

    expect(cls.run).toHaveBeenCalledTimes(1);
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
    expect(cls.set.mock.invocationCallOrder[0]).toBeLessThan(resolveCredential.mock.invocationCallOrder[0]);
    expect(resolveCredential).toHaveBeenCalledWith('model-registry', 's3', 'tenant-1');
    expect(result).toEqual(RESOLVED);
  });

  it('trims the provider before calling the service', async () => {
    await resolveModelRegistryCredential(providerConnections, cls as unknown as ClsService<IActiveUserContext>, '  s3  ', 'tenant-1');
    expect(resolveCredential).toHaveBeenCalledWith('model-registry', 's3', 'tenant-1');
  });
});
