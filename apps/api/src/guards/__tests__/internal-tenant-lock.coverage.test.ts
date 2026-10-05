import { describe, expect, it } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { HarnessInternalController } from '../../modules/consultation/harness-internal.controller';
import { SttInternalController } from '../../modules/internal/stt-internal.controller';
import { InternalTenantLockGuard } from '../internal-tenant-lock.guard';

const guardsOf = (controller: object): unknown[] => Reflect.getMetadata('__guards__', controller) ?? [];

describe('internal controllers that write tenant data carry the restore lock', () => {
  it.each([
    ['HarnessInternalController', HarnessInternalController],
    ['SttInternalController', SttInternalController],
  ])('%s', (_name, controller) => {
    expect(guardsOf(controller)).toContain(InternalTenantLockGuard);
  });
});

/**
 * TASK-1043. A `@Public()` internal controller authenticates in its own guard, so the restore lock
 * must be checked by `InternalTenantLockGuard` AFTER that guard — the global `TenantLockGuard` no
 * longer reads the lock for those routes. Order is the whole point: with the lock first, a caller
 * holding no token learns a tenant is being restored (503 + restoreId) instead of getting 401.
 * Discovered from the controller files, so a new internal controller cannot be added without it.
 */
const modules = import.meta.glob('../../modules/**/*.controller.ts', { eager: true }) as Record<string, Record<string, unknown>>;

const publicInternalControllers = Object.entries(modules).flatMap(([file, exports]) =>
  Object.entries(exports)
    .filter(([, value]) => typeof value === 'function')
    .filter(([, value]) => {
      const path = Reflect.getMetadata(PATH_METADATA, value as object) as string | string[] | undefined;
      const paths = Array.isArray(path) ? path : path === undefined ? [] : [path];
      return paths.some((p) => p.replace(/^\//, '').startsWith('internal')) && Reflect.getMetadata(SKIP_AUTH_KEY, value as object) === true;
    })
    .map(([name, value]) => [`${name} (${file.replace('../../modules/', '')})`, value as object] as const),
);

describe('every @Public() internal controller checks the restore lock after authenticating (TASK-1043)', () => {
  it('discovers the public internal controllers', () => {
    expect(publicInternalControllers.length).toBeGreaterThanOrEqual(10);
  });

  it.each(publicInternalControllers)('%s', (_name, controller) => {
    const guards = guardsOf(controller);
    const lockAt = guards.indexOf(InternalTenantLockGuard);
    expect(lockAt, 'carries InternalTenantLockGuard').toBeGreaterThan(-1);
    expect(lockAt, 'InternalTenantLockGuard runs after the controller’s authentication guard').toBeGreaterThan(0);
    expect(guards.slice(0, lockAt).length, 'an authentication guard precedes the lock').toBeGreaterThan(0);
  });
});
