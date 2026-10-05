/**
 * TASK-1038 OD-35 — the API key that authenticated a request is published on CLS `apiKey`
 * (`{ id, scopes }`), beside — never instead of — the bound human on `user`.
 *
 * A run started with an API key is bound to the KEY (`RunPrincipalAccessService`), and the service
 * layer that answers a run read (status, result, stream, cancel) only sees CLS. `user` carries the
 * key's bound human, which is the wrong principal for that comparison: two keys bound to one human
 * would otherwise read each other's runs.
 *
 * The `user` shape pinned by `unified-auth.guard.apikey-principal-shape.test.ts` (`{ id, tenantId }`,
 * no `roles`) is unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnifiedAuthGuard } from '../unified-auth.guard';
import { RequiredScopes } from '../decorators';
import { PolicyEngine } from '../policy.engine';

class DummyRunController {
  @RequiredScopes('workflow:run:read')
  status() {}
}

const context = () => {
  const request = { headers: {}, method: 'GET', url: '/api/v1/workflows/x/runs/r', ip: '127.0.0.1', params: {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => DummyRunController.prototype.status,
    getClass: () => DummyRunController,
  } as unknown as ExecutionContext;
};

describe('UnifiedAuthGuard — CLS `apiKey` for run-principal binding (OD-35)', () => {
  const clsStore = new Map<string, unknown>();

  beforeEach(async () => {
    clsStore.clear();
    const apiKeyService = {
      extractApiKeyFromRequest: () => 'raw-key',
      authenticateByRawKey: async () => ({
        id: 'key-A',
        keyName: 'integration',
        tenantId: 'tenant-1',
        userId: 'human-1',
        scopes: ['workflow:run:read', 'workflow:run:read-all'],
        rateLimit: 0,
        allowedIps: [],
      }),
      hasScope: (key: { scopes: string[] | null }, required: string) => Array.isArray(key.scopes) && key.scopes.includes(required),
    };
    const cls = { get: (key: string) => clsStore.get(key), set: (key: string, value: unknown) => clsStore.set(key, value) };
    const guard = new UnifiedAuthGuard(new Reflector(), apiKeyService as never, {} as unknown as PolicyEngine, cls as never, undefined, undefined, undefined);
    await guard.canActivate(context());
  });

  it('publishes the key id and its scopes on `apiKey`', () => {
    expect(clsStore.get('apiKey')).toEqual({ id: 'key-A', scopes: ['workflow:run:read', 'workflow:run:read-all'] });
  });

  it('leaves `user` as the bound human, unchanged', () => {
    expect(clsStore.get('user')).toEqual({ id: 'human-1', tenantId: 'tenant-1' });
  });
});
