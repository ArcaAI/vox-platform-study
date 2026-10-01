import { HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ITenantLockService } from '../contracts';

const logger = new Logger('assertTenantNotLocked');

/**
 * The one place a locked tenant becomes an HTTP answer. Resolves when the tenant is not locked;
 * throws 423 `TENANT_RESTORE_IN_PROGRESS` (with the restore id) when it is, and 503
 * `TENANT_LOCK_UNAVAILABLE` when the lock state cannot be read — a failed read never means
 * "unlocked".
 */
export async function assertTenantNotLocked(lock: ITenantLockService, tenantId: string): Promise<void> {
  let state;
  try {
    state = await lock.state(tenantId);
  } catch (error) {
    logger.error({ message: 'Tenant lock state unreadable — refusing request', tenantId, error: String(error) });
    throw new ServiceUnavailableException({
      statusCode: 503,
      code: 'TENANT_LOCK_UNAVAILABLE',
      message: 'Tenant lock state could not be determined',
    });
  }
  if (!state.locked) return;
  throw new HttpException(
    {
      statusCode: 423,
      code: 'TENANT_RESTORE_IN_PROGRESS',
      message: 'This tenant is being restored from a checkpoint and is read-only until the restore finishes',
      restoreId: state.restoreId,
    },
    423,
  );
}
