import { HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ITenantLockService, TenantLockState } from '../contracts';

const logger = new Logger('assertTenantNotLocked');

/**
 * The one place a locked tenant becomes an HTTP answer. Resolves when the tenant is not locked;
 * throws 423 `TENANT_RESTORE_IN_PROGRESS` (with the restore id) when it is, and 503
 * `TENANT_LOCK_UNAVAILABLE` when the lock state cannot be read — a failed read never means
 * "unlocked".
 *
 * `internal: true` is for service-to-service callers (STT, harness): they classify 423 as a
 * permanent client error and drop the write, but retry 503 — so the same `code` + `restoreId`
 * body is answered with 503 (the guard adds `Retry-After`).
 */
export const TENANT_LOCK_RETRY_AFTER_SECONDS = 30;

/**
 * Machine callers (service-token routes, the STT WebSocket open, BullMQ processors) write clinical
 * rows, so they are held back ONLY by a restore that includes CLINICAL. A CONFIG_CONTENT /
 * USERS_ACCESS restore leaves them running. Unknown categories fail closed (treated as CLINICAL).
 */
export function lockBlocksMachineCallers(state: TenantLockState): boolean {
  return state.locked && (state.categories === undefined || state.categories.includes('CLINICAL'));
}

export async function assertTenantNotLocked(lock: ITenantLockService, tenantId: string, options: { internal?: boolean } = {}): Promise<void> {
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
  if (options.internal ? !lockBlocksMachineCallers(state) : !state.locked) return;
  const status = options.internal ? 503 : 423;
  throw new HttpException(
    {
      statusCode: status,
      code: 'TENANT_RESTORE_IN_PROGRESS',
      message: 'This tenant is being restored from a checkpoint and is read-only until the restore finishes',
      restoreId: state.restoreId,
    },
    status,
  );
}
