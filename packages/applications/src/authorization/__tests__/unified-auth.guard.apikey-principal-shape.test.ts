/**
 * the API-key CLS principal carries NO `roles`, and that is
 * LOAD-BEARING. Do not "fix" it.
 *
 * `UnifiedAuthGuard.handleApiKeyAuth` writes `{ id, tenantId }` into CLS
 * `user`, with no `roles` array. `isSuperAdmin()` (`common/tenant-guards.ts`)
 * answers off `user.roles`, so it is **always false** for an API-key caller.
 * That accident is the last line of defence behind every super-admin-only
 * imperative gate in the platform — `SUPER_ADMIN_ONLY_TASK_PREFIXES`,
 * `SUPER_ADMIN_ONLY_POLICY_KEYS`, the `globalOnly` descriptor lock, MCP writes,
 * `PromptManagementService.assertCanApprove` — none of which are expressible in
 * a permission decorator and none of which would otherwise notice that the
 * caller is a static bearer secret rather than a person.
 *
 * A well-meaning future change that "enriches" the API-key principal with the
 * bound user's roles would silently re-open every one of those routes, and
 * without this test **nothing would fail**. So the shape is pinned here
 * explicitly.
 *
 * A2 (`@ForbidApiKey()` on the whole admin plane) is the primary defence and
 * makes this one unreachable through `/admin/*`. Defence in depth: A2 is a
 * per-route declaration that a new controller could omit; this is a property of
 * the credential itself.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnifiedAuthGuard } from '../unified-auth.guard';
import { RequiredScopes } from '../decorators';
import { PolicyEngine } from '../policy.engine';
import { isSuperAdmin } from '../../common/tenant-guards';

class DummyBusinessController {
  /** A declared API-key surface with NO CASL metadata, so the key path completes. */
  @RequiredScopes('consultation:session:read')
  list() {}
}

const createMockContext = () => {
  const request = { headers: {}, method: 'GET', url: '/api/v1/consultations', ip: '127.0.0.1', params: {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => DummyBusinessController.prototype.list,
    getClass: () => DummyBusinessController,
  } as unknown as ExecutionContext;
};

describe('UnifiedAuthGuard — API-key CLS principal shape (regression pin)', () => {
  let guard: UnifiedAuthGuard;
  const clsStore = new Map<string, unknown>();

  beforeEach(async () => {
    clsStore.clear();

    const apiKeyService = {
      extractApiKeyFromRequest: () => 'raw-key-123',
      authenticateByRawKey: async () => ({
        id: 'key-1',
        keyName: 'test-key',
        tenantId: 'tenant-1',
        // The key is BOUND to a user who really is a super admin. The principal
        // published to CLS must still not say so.
        userId: 'super-admin-user',
        scopes: ['*'],
        rateLimit: 0,
        allowedIps: [],
      }),
      hasScope: (key: { scopes: string[] | null }, required: string) =>
        Array.isArray(key.scopes) && (key.scopes.includes('*') || key.scopes.includes(required)),
    };

    const clsService = {
      get: (key: string) => clsStore.get(key),
      set: (key: string, value: unknown) => clsStore.set(key, value),
    };

    guard = new UnifiedAuthGuard(
      new Reflector(),
      apiKeyService as never,
      {} as unknown as PolicyEngine,
      clsService as never,
      undefined,
      undefined,
      undefined,
    );

    await guard.canActivate(createMockContext());
  });

  it('publishes exactly { id, tenantId } — no `roles` key at all', () => {
    const user = clsStore.get('user') as Record<string, unknown>;
    expect(user).toBeDefined();
    expect(Object.keys(user).sort()).toEqual(['id', 'tenantId']);
    expect(user).not.toHaveProperty('roles');
  });

  it('makes isSuperAdmin() false for an API-key caller even when the bound user is a super admin', () => {
    const user = clsStore.get('user') as { roles?: string[] | null };
    expect(isSuperAdmin(user)).toBe(false);
  });

  it('never publishes a compiled CASL ability for an API-key caller (gate now, publish never)', () => {
    expect(clsStore.has('userAbility')).toBe(false);
  });
});
