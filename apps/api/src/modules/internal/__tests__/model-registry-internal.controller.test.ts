/**
 * ModelRegistryInternalController — the generic
 * `GET /internal/model-registry-credential` route ( follow-on).
 *
 * Guard choice: `@Public()` + `InternalServiceTokenGuard` (the
 * `EffectiveConfigController` pattern), NOT the STT-specific reserved
 * API-key-scope exemption `SttInternalController` carries.
 * `RESERVED_INTERNAL_SCOPE_CONTROLLERS` is FROZEN AT ONE MEMBER by owner
 * decision (`apps/api/src/bootstrap/api-key-scope-audit.ts`, gate
 * G2/D-3) and pinned by `api-key-scope-audit.test.ts` — widening it is a
 * deliberate, reviewed change, not a side effect of adding a route. Every
 * caller this route needs to serve (nlp/tts/harness, and stt too) already
 * holds a working credential for `InternalServiceTokenGuard`
 * (`NLP_SERVICE_TOKEN` / `TTS_SERVICE_TOKEN` / `HARNESS_SERVICE_TOKEN` /
 * `API_GATEWAY_KEY`, all already registered in its `SERVICE_SECRETS` map),
 * so this needs no new credential type either.
 */
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import type { IActiveUserContext, IProviderConnectionService, ResolvedProviderCredential } from '@arcaai/applications';
import type { ClsService } from 'nestjs-cls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRegistryInternalController } from '../model-registry-internal.controller';
import { InternalServiceTokenGuard } from '../internal-service-token.guard';

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

function build(resolveCredential = vi.fn(async () => RESOLVED)) {
  const providerConnections = { resolveCredential } as unknown as IProviderConnectionService;
  const cls = fakeCls();
  return {
    controller: new ModelRegistryInternalController(providerConnections, cls as unknown as ClsService<IActiveUserContext>),
    resolveCredential,
    cls,
  };
}

describe('ModelRegistryInternalController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('route is GET internal/model-registry-credential', () => {
    const path = Reflect.getMetadata(PATH_METADATA, ModelRegistryInternalController) as string;
    expect(path).toBe('internal');
    expect(Reflect.getMetadata(PATH_METADATA, ModelRegistryInternalController.prototype.getModelRegistryCredential)).toBe('model-registry-credential');
    expect(Reflect.getMetadata(METHOD_METADATA, ModelRegistryInternalController.prototype.getModelRegistryCredential)).toBe(RequestMethod.GET);
  });

  it('delegates to resolveCredential("model-registry", provider, tenantId) via the shared helper', async () => {
    const { controller, resolveCredential, cls } = build();
    const result = await controller.getModelRegistryCredential('s3', 'tenant-1');
    expect(resolveCredential).toHaveBeenCalledWith('model-registry', 's3', 'tenant-1');
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
    expect(result).toEqual(RESOLVED);
  });

  it('rejects a missing provider (400) before touching the service', async () => {
    const { controller, resolveCredential } = build();
    await expect(controller.getModelRegistryCredential(undefined, 'tenant-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('rejects a missing tenantId (400) before touching the service', async () => {
    const { controller, resolveCredential } = build();
    await expect(controller.getModelRegistryCredential('s3', undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  describe('boot-time route-permission audit compliance', () => {
    it('carries @Public() at the class level, so the audit admits it (isPublic: true in the manifest)', () => {
      expect(
        new Reflector().getAllAndOverride<boolean>(SKIP_AUTH_KEY, [
          ModelRegistryInternalController.prototype.getModelRegistryCredential,
          ModelRegistryInternalController,
        ]),
      ).toBe(true);
    });

    it('applies InternalServiceTokenGuard — the recognised guard that actually authenticates it', () => {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, ModelRegistryInternalController) ?? []) as unknown[];
      expect(guards).toContain(InternalServiceTokenGuard);
    });

    it('is not on RESERVED_INTERNAL_SCOPE_CONTROLLERS — it does not need the frozen exemption', async () => {
      const { RESERVED_INTERNAL_SCOPE_CONTROLLERS } = await import('../../../bootstrap/api-key-scope-audit');
      expect(RESERVED_INTERNAL_SCOPE_CONTROLLERS.has('ModelRegistryInternalController')).toBe(false);
    });
  });
});
