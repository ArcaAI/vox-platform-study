// TASK-525 §4.1 — the internal effective-config route.
//
// Tests 1 & 2 of the ticket's RED list: the controller delegates to the read
// service and rejects unknown service names, and its decorator stack satisfies
// the boot-time route-permission audit exactly like HarnessInternalController.

import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import type { IEffectiveConfigService } from '@arcaai/applications';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EffectiveConfigController } from '../effective-config.controller';
import { InternalServiceTokenGuard } from '../internal-service-token.guard';

const SNAPSHOT = {
  service: 'smr',
  generatedAt: '2026-07-20T00:00:00.000Z',
  runtimeProfiles: [{ provider: 'ollama', modelSlug: '', maxConcurrent: 6, timeoutS: 120, source: 'db' as const }],
};

function controllerWith(resolve = vi.fn(async () => SNAPSHOT)) {
  const service = { resolveForService: resolve } as unknown as IEffectiveConfigService;
  return { controller: new EffectiveConfigController(service), resolve };
}

describe('EffectiveConfigController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the resolved subset for the requested service', async () => {
    const { controller, resolve } = controllerWith();
    await expect(controller.getEffectiveConfig('smr')).resolves.toEqual(SNAPSHOT);
    expect(resolve).toHaveBeenCalledWith('smr');
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
