import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TENANT_LOCK_CHANNEL } from '../../contracts';
import { TENANT_RESTORE_COMPLETED_EVENT } from '../tenant-restore-events';
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
  let emitter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = { findActiveByTenant: vi.fn() };
    redis = { publish: vi.fn().mockResolvedValue(undefined) };
    subject = new Subject<string>();
    subscriber = { subscribeToChannel: vi.fn().mockResolvedValue(subject.asObservable()) };
    emitter = { emit: vi.fn() };
    service = new TenantLockService(repo as never, redis as never, subscriber as never, emitter as never);
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
    await new Promise((r) => setImmediate(r));
    await service.state('T');
    await service.state('U');
    // T was re-read eagerly by the message; U stayed cached.
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

  describe('restore-completed event', () => {
    const flush = () => new Promise((r) => setImmediate(r));

    it('emits once when a channel message finds the tenant unlocked after it was locked', async () => {
      repo.findActiveByTenant.mockResolvedValueOnce({ id: 'R1', status: 'RECONCILING' });
      await service.state('T');
      repo.findActiveByTenant.mockResolvedValue(null);
      subject.next(JSON.stringify({ tenantId: 'T' }));
      await flush();
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(TENANT_RESTORE_COMPLETED_EVENT, { tenantId: 'T' });
    });

    it('emits on EVERY unlock message, even on a node that never observed the locked state', async () => {
      // R2 M-8: a node that missed the lock-start message (or served no request) must still drop its
      // caches; the handlers are idempotent, so a repeat is harmless.
      repo.findActiveByTenant.mockResolvedValue(null);
      subject.next(JSON.stringify({ tenantId: 'T' }));
      await flush();
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(TENANT_RESTORE_COMPLETED_EVENT, { tenantId: 'T' });
      subject.next(JSON.stringify({ tenantId: 'T' }));
      await flush();
      expect(emitter.emit).toHaveBeenCalledTimes(2);
    });

    it('does not emit on a message that finds the lock beginning, nor on a plain cache-miss read', async () => {
      repo.findActiveByTenant.mockResolvedValue(null);
      await service.state('T');
      expect(emitter.emit).not.toHaveBeenCalled();
      repo.findActiveByTenant.mockResolvedValue({ id: 'R1', status: 'LOCKING' });
      subject.next(JSON.stringify({ tenantId: 'T' }));
      await flush();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('emits when the cache TTL expiry is what reveals the unlock (missed message)', async () => {
      vi.useFakeTimers();
      try {
        repo.findActiveByTenant.mockResolvedValueOnce({ id: 'R1', status: 'POST_COMMIT' });
        await service.state('T');
        vi.advanceTimersByTime(6_000);
        repo.findActiveByTenant.mockResolvedValue(null);
        await service.state('T');
        expect(emitter.emit).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not mistake a failed read for an unlock', async () => {
      repo.findActiveByTenant.mockResolvedValueOnce({ id: 'R1', status: 'VERIFYING' });
      await service.state('T');
      repo.findActiveByTenant.mockRejectedValueOnce(new Error('db down'));
      subject.next(JSON.stringify({ tenantId: 'T' }));
      await flush();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});
