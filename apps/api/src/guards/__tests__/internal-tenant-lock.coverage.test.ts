import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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
// Discovered from the files on disk, resolved from `cwd` rather than `import.meta` (`apps/api`
// typechecks as CommonJS, which rejects `import.meta` — TS1343); the suite runs from the repo root
// or from `apps/api`, so both roots are tried, and a miss FAILS rather than passing vacuously.
const MODULES_DIR = ['apps/api/src/modules', 'src/modules'].map((candidate) => resolve(process.cwd(), candidate)).find(existsSync);

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : controllerFiles(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

async function publicInternalControllers(): Promise<Array<readonly [string, object]>> {
  const found: Array<readonly [string, object]> = [];
  for (const file of controllerFiles(MODULES_DIR!)) {
    const exports = (await import(file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      if (typeof value !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, value) as string | string[] | undefined;
      const paths = Array.isArray(path) ? path : path === undefined ? [] : [path];
      if (paths.some((p) => p.replace(/^\//, '').startsWith('internal')) && Reflect.getMetadata(SKIP_AUTH_KEY, value) === true) {
        found.push([`${name} (${relative(MODULES_DIR!, file)})`, value] as const);
      }
    }
  }
  return found;
}

describe('every @Public() internal controller checks the restore lock after authenticating (TASK-1043)', () => {
  it('located the controller sources', () => {
    expect(MODULES_DIR, `could not locate apps/api/src/modules from cwd ${process.cwd()}`).toBeDefined();
  });

  it('every one carries InternalTenantLockGuard after an authentication guard', async () => {
    const controllers = await publicInternalControllers();
    expect(controllers.length, 'discovers the public internal controllers').toBeGreaterThanOrEqual(10);
    const offenders = controllers.flatMap(([name, controller]) => {
      const guards = guardsOf(controller);
      const lockAt = guards.indexOf(InternalTenantLockGuard);
      if (lockAt === -1) return [`${name}: no InternalTenantLockGuard`];
      if (lockAt === 0) return [`${name}: InternalTenantLockGuard runs before the controller's authentication guard`];
      return [];
    });
    expect(offenders).toEqual([]);
  }, 60_000);
});
