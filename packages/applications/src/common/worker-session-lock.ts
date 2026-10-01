import { DelayedError } from 'bullmq';
import type { ITenantLockService } from '../services/tenant-checkpoint/contracts';
import { TenantLockedError } from '../services/tenant-checkpoint/lock/tenant-locked.error';

/** How long a postponed job waits before the queue offers it to a worker again. */
export const TENANT_LOCK_POSTPONE_MS = 30_000;

/** The subset of a BullMQ `Job` the postponement needs. */
export interface PostponableJob {
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

/**
 * Refuse to start tenant work while the tenant is locked by a restore. Call it BEFORE the job
 * body binds CLS / touches data. Absent lock service (a graph that does not wire it) is a no-op;
 * an unreadable lock state propagates, so the job fails and the queue's own retry takes over.
 */
export async function assertTenantUnlocked(lock: ITenantLockService | undefined, tenantId: string | undefined | null): Promise<void> {
  if (!lock || !tenantId) return;
  const state = await lock.state(tenantId);
  if (state.locked) throw new TenantLockedError(tenantId, state.restoreId);
}

/**
 * Processor-side translation of a locked tenant into a postponement: the job is moved back to
 * the delayed set and `DelayedError` tells the worker not to complete or fail it, so it keeps
 * its attempt count and runs after the restore. Resolves normally when the tenant is unlocked.
 */
export async function postponeIfTenantLocked(
  lock: ITenantLockService | undefined,
  job: PostponableJob,
  token: string | undefined,
  tenantId: string | undefined | null,
): Promise<void> {
  try {
    await assertTenantUnlocked(lock, tenantId);
  } catch (error) {
    if (!(error instanceof TenantLockedError)) throw error;
    await job.moveToDelayed(Date.now() + TENANT_LOCK_POSTPONE_MS, token);
    throw new DelayedError();
  }
}
