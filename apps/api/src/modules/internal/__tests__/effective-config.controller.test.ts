// The internal effective-config route.
//
// The controller delegates to the read
// service and rejects unknown service names, and its decorator stack satisfies
// the boot-time route-permission audit exactly like HarnessInternalController.

import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import type { IActiveUserContext, IEffectiveConfigService } from '@arcaai/applications';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import type { ClsService } from 'nestjs-cls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EffectiveConfigController } from '../effective-config.controller';
import { InternalServiceTokenGuard } from '../internal-service-token.guard';

const SNAPSHOT = {
  service: 'text',
  generatedAt: '2026-07-20T00:00:00.000Z',
  runtimeProfiles: [{ provider: 'ollama', modelSlug: '', maxConcurrent: 6, timeoutS: 120, source: 'db' as const }],
};

/**
 * Minimal CLS fake mirroring the harness-internal controller tests: `run`
 * executes the callback synchronously in a fresh store, `set`/`get` operate on
 * that store, and the recorded values let the tests assert what tenant context
 * the service call executed under.
 */
function fakeCls() {
  const store = new Map<string, unknown>();
  return {
    store,
    run: vi.fn((fn: () => unknown) => fn()),
    set: vi.fn((key: string, value: unknown) => void store.set(key, value)),
    get: vi.fn((key: string) => store.get(key)),
  };
}

function controllerWith(resolve = vi.fn(async (_service: string) => SNAPSHOT)) {
  const service = { resolveForService: resolve } as unknown as IEffectiveConfigService;
  const cls = fakeCls();
  return {
    controller: new EffectiveConfigController(service, cls as unknown as ClsService<IActiveUserContext>),
    resolve,
    cls,
  };
}

describe('EffectiveConfigController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the resolved subset for the requested service', async () => {
    const { controller, resolve } = controllerWith();
    await expect(controller.getEffectiveConfig('text')).resolves.toEqual(SNAPSHOT);
    expect(resolve).toHaveBeenCalledWith('text');
  });

  // Service-to-service requests arrive with an EMPTY CLS store (no user, no
  // tenant), and the read subtree touches tenant-scoped models (AiProviderConnection
  // via listProfiles — TASK-862). Without an explicit tenant context the tenant-scope
  // Prisma extension throws ("tenant context required") and the route 500s for
  // every caller. The controller must therefore re-establish CLS around the
  // read, pinned to the SYSTEM tenant — the platform scope every effective-config
  // subset resolves against (harness-internal controller precedent).
  it('resolves inside a CLS context pinned to the SYSTEM tenant', async () => {
    const resolve = vi.fn(async function (this: unknown, service: string) {
      return { ...SNAPSHOT, service };
    });
    const { controller, cls } = controllerWith(resolve);

    await controller.getEffectiveConfig('text');

    expect(cls.run).toHaveBeenCalledTimes(1);
    expect(cls.set).toHaveBeenCalledWith('tenantId', SYSTEM_TENANT_ID);
    // The tenant must be in place BEFORE the service read executes.
    expect(cls.set.mock.invocationCallOrder[0]).toBeLessThan(resolve.mock.invocationCallOrder[0]);
  });

  it('propagates ArgumentInvalidException for an unknown service (→ 400)', async () => {
    const resolve = vi.fn(async () => {
      throw new ArgumentInvalidException("Unknown service 'nope'.");
    });
    const { controller } = controllerWith(resolve);
    await expect(controller.getEffectiveConfig('nope')).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('rejects a missing service query param without reaching the service', async () => {
    const { controller, resolve } = controllerWith();
    await expect(controller.getEffectiveConfig(undefined as unknown as string)).rejects.toBeInstanceOf(ArgumentInvalidException);
    expect(resolve).not.toHaveBeenCalled();
  });

  // Ticket RED test #2 — the route must not crash boot. The audit admits a route
  // that carries `SKIP_AUTH_KEY` (i.e. `@Public()`) at method or class level, and
  // it reads that via metadata only — so asserting the metadata asserts exactly
  // what the audit will conclude, without standing up the DI graph.
  // The explicit service-token guard is what actually authenticates the route
  // (HarnessInternalController precedent).
  describe('boot-time route-permission audit compliance', () => {
    it('carries @Public() at the class level, so the audit admits it', () => {
      expect(
        new Reflector().getAllAndOverride<boolean>(SKIP_AUTH_KEY, [
          EffectiveConfigController.prototype.getEffectiveConfig,
          EffectiveConfigController,
        ]),
      ).toBe(true);
    });

    it('is not an /admin/ route, so the audit never demands a concrete permission', () => {
      const path = Reflect.getMetadata(PATH_METADATA, EffectiveConfigController) as string;
      expect(path).toBe('internal/effective-config');
      expect(path.startsWith('admin/')).toBe(false);
    });

    it('applies the service-token guard that actually authenticates it', () => {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, EffectiveConfigController) ?? []) as unknown[];
      expect(guards).toContain(InternalServiceTokenGuard);
    });
  });
});
