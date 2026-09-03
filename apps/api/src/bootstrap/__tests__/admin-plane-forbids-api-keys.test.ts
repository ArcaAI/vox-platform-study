/**
 * Policy **A2** proved against the REAL `UnifiedAuthGuard` and the
 * REAL admin controller classes — not against a synthetic stand-in.
 *
 * The boot audits (`admin-scope-audit.test.ts`) prove the METADATA is right.
 * This proves the metadata actually produces a denial when the guard runs, for
 * the credential that matters most: a key holding the bare `'*'` wildcard.
 *
 * `'*'` is the interesting case because it is the ONLY thing `@RequiredScopes`
 * could never deny — `ApiKeyService.hasScope` grants it every scope, so under
 * scope-narrowing a `'*'` key reached every admin controller with
 * full reach. A2 closes that, and it closes it for a structural reason worth
 * pinning: `enforceApiKeyNotForbidden` runs BEFORE `enforceApiKeyScopes` in
 * `UnifiedAuthGuard.handleApiKeyAuth`, so a forbidden route has no scope — not
 * even `'*'` — that could rescue it.
 *
 * Follows the real-decorator + real-Reflector pattern
 * `stt-internal.controller.scope.test.ts` established.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnifiedAuthGuard, PolicyEngine } from '@arcaai/applications';

import { ApiKeyController } from '../../modules/api-key/api-key.controller';
import { RolesController } from '../../modules/rbac/roles.controller';
import { PoliciesController } from '../../modules/rbac/policies.controller';
import { TenantController } from '../../modules/tenant/tenant.controller';
import { GlobalSettingController } from '../../modules/global-setting/global-setting.controller';
import { WebhookController } from '../../modules/webhook/webhook.controller';
import { UserController } from '../../modules/user/user.controller';
import { PrismaStudioController } from '../../modules/pstudio/pstudio.controller';
import { HarnessAdminController } from '../../modules/harness-admin/harness-admin.controller';
import { KnowledgeController } from '../../modules/knowledge/knowledge.controller';
import { WorkflowSandboxRunController } from '../../modules/workflow-sandbox-run/workflow-sandbox-run.controller';

/**
 * The highest-risk classes plus the three the old hand-maintained audit list
 * never policed. `WebhookController` is here because it is the one admin
 * controller that was gated by a NON-`admin:` scope (`webhook:event:write`), so
 * a sweep that reasoned only about the `admin:` family would have missed it.
 */
const ADMIN_CONTROLLERS = [
  ApiKeyController,
  RolesController,
  PoliciesController,
  TenantController,
  GlobalSettingController,
  WebhookController,
  UserController,
  PrismaStudioController,
  HarnessAdminController,
  // Absent from `ADMIN_SCOPED_CONTROLLERS` before — genuinely
  // API-key-reachable, simply never transcribed into the list.
  KnowledgeController,
  WorkflowSandboxRunController,
] as const;

const buildApiKey = (scopes: string[]) => ({
  id: 'key-1',
  keyName: 'test-key',
  tenantId: 'tenant-1',
  userId: 'user-1',
  scopes,
  rateLimit: 0,
  allowedIps: [],
});

describe('A2 — the real UnifiedAuthGuard denies API keys on every admin controller', () => {
  let guard: UnifiedAuthGuard;
  let heldScopes: string[];

  beforeEach(() => {
    heldScopes = ['*'];

    const apiKeyService = {
      extractApiKeyFromRequest: () => 'raw-key-123',
      authenticateByRawKey: async () => buildApiKey(heldScopes),
      // Real wildcard semantics: `'*'` satisfies every required scope. If A2
      // were enforced by scopes alone, this key would pass.
      hasScope: (key: { scopes: string[] }, required: string) => key.scopes.includes('*') || key.scopes.includes(required),
    };

    guard = new UnifiedAuthGuard(
      new Reflector(),
      apiKeyService as never,
      {} as unknown as PolicyEngine,
      { get: () => undefined, set: () => undefined } as never,
      undefined,
      undefined,
      undefined,
    );
  });

  const contextFor = (ControllerClass: (new (...args: never[]) => unknown) & { prototype: object }, methodName: string): ExecutionContext => {
    const request = { headers: {}, method: 'GET', url: '/api/v1/admin/probe', ip: '127.0.0.1', params: {} };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => (ControllerClass.prototype as Record<string, unknown>)[methodName],
      getClass: () => ControllerClass,
    } as unknown as ExecutionContext;
  };

  /** Any HTTP handler on the class — class-level metadata gates all of them. */
  const firstHandlerName = (ControllerClass: { prototype: object }): string => {
    const name = Object.getOwnPropertyNames(ControllerClass.prototype).find(
      (n) => n !== 'constructor' && typeof (ControllerClass.prototype as Record<string, unknown>)[n] === 'function',
    );
    if (!name) throw new Error('controller has no handler methods');
    return name;
  };

  for (const ControllerClass of ADMIN_CONTROLLERS) {
    it(`denies a key holding '*' on ${ControllerClass.name}`, async () => {
      const context = contextFor(ControllerClass as never, firstHandlerName(ControllerClass));
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it(`denies a key holding the old admin scope on ${ControllerClass.name}`, async () => {
      heldScopes = ['admin:*', 'webhook:*'];
      const context = contextFor(ControllerClass as never, firstHandlerName(ControllerClass));
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });
  }

  /**
   * The denial message must NOT distinguish "declared never" from "declares
   * nothing" — a caller must not be able to probe which admin routes were
   * deliberately closed. `UnifiedAuthGuard` keeps both on one string and
   * separates them only in the server-side log.
   */
  it('uses the non-probing denial message', async () => {
    const context = contextFor(TenantController as never, firstHandlerName(TenantController));
    await expect(guard.canActivate(context)).rejects.toThrow(/does not accept API-key authentication/);
  });
});
