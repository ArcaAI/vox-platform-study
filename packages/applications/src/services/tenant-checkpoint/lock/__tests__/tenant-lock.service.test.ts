import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TENANT_LOCK_CHANNEL } from '../../contracts';
import { TenantLockService } from '../tenant-lock.service';

interface ActiveRestoreReader {
  findActiveByTenant(tenantId: string): Promise<{ id: string; status: string } | null>;
}

describe('TenantLockService', () => {
  let repo: { findActiveByTenant: ReturnType<typeof vi.fn> } & ActiveRestoreReader;
  let redis: { publish: ReturnType<typeof vi.fn> };
  let subject: Subject<string>;
  let subscriber: { subscribeToChannel: ReturnType<typeof vi.fn> };
  let service: TenantLockService;

  beforeEach(async () => {
    repo = { findActiveByTenant: vi.fn() };
    redis = { publish: vi.fn().mockResolvedValue(undefined) };
    subject = new Subject<string>();
    subscriber = { subscribeToChannel: vi.fn().mockResolvedValue(subject.asObservable()) };
    service = new TenantLockService(repo as never, redis as never, subscriber as never);
    await service.onModuleInit();
  });

  it.each(['LOCKING', 'SAFETY_CHECKPOINT', 'VERIFYING', 'RECONCILING', 'POST_COMMIT'])('locks while the restore is %s', async (status) => {
    repo.findActiveByTenant.mockResolvedValue({ id: 'R1', status });
    await expect(service.state('T')).resolves.toEqual({ locked: true, restoreId: 'R1' });
  });

  it('does not lock a PENDING restore or a tenant with none', async () => {
    repo.findActiveByTenant.mockResolvedValueOnce({ id: 'R1', status: 'PENDING' });
    await expect(service.state('T')).resolves.toEqual({ locked: false });
    repo.findActiveByTenant.mockResolvedValueOnce(null);
    await expect(service.state('U')).resolves.toEqual({ locked: false });
  });

  it('serves a second call within the TTL from cache', async () => {
    repo.findActiveByTenant.mockResolvedValue(null);
    await service.state('T');
    await service.state('T');
    expect(repo.findActiveByTenant).toHaveBeenCalledTimes(1);
  });

  it('drops the cache for a tenant named on the channel, not for others', async () => {
    repo.findActiveByTenant.mockResolvedValue(null);
    await service.state('T');
    await service.state('U');
    subject.next(JSON.stringify({ tenantId: 'T' }));
    await service.state('T');
    await service.state('U');
    expect(repo.findActiveByTenant).toHaveBeenCalledTimes(3);
    expect(subscriber.subscribeToChannel).toHaveBeenCalledWith(TENANT_LOCK_CHANNEL);
  });

  it('publishChange publishes the tenant and drops the local cache', async () => {
    repo.findActiveByTenant.mockResolvedValue(null);
    await service.state('T');
    await service.publishChange('T');
    expect(redis.publish).toHaveBeenCalledWith(TENANT_LOCK_CHANNEL, JSON.stringify({ tenantId: 'T' }));
    await service.state('T');
    expect(repo.findActiveByTenant).toHaveBeenCalledTimes(2);
  });

  it('fails closed: a repository error rethrows and is not cached', async () => {
    repo.findActiveByTenant.mockRejectedValueOnce(new Error('db down'));
    await expect(service.state('T')).rejects.toThrow('db down');
    repo.findActiveByTenant.mockResolvedValueOnce(null);
    await expect(service.state('T')).resolves.toEqual({ locked: false });
  });
});
