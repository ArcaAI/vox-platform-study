/**
 * Boot-time audit — policy **A2**: `/api/v1/admin/*` is a JWT-only
 * plane, so an `admin/`-prefixed route must NEVER declare `@RequiredScopes`.
 *
 * This file replaces 's regression guard, which asserted the
 * exact opposite (that each named admin controller KEPT a named
 * `@RequiredScopes` value). The invariant is inverted, not relaxed.
 *
 * Two audits, deliberately different in kind:
 *
 * - `auditAdminControllersDeclareNoApiKeyScopes(app)` — the DERIVED sweep, and
 *   the one that actually holds the line. It walks `ModulesContainer` and reads
 *   resolved metadata, so a brand-new admin controller nobody added to any list
 *   is caught on the day it is written. A hand-transcribed list cannot do that:
 *   the previous one silently policed 63 of 65 controllers because
 *   `KnowledgeController` and `WorkflowSandboxRunController` were never
 *   transcribed into it.
 * - `auditAdminScopedControllers()` — the NAMED list, collapsed to all-`FORBID`.
 *   It catches a different failure: a controller that stops being registered in
 *   any module (and so vanishes from the sweep entirely) while its class still
 *   exists. Kept for that reason, not as the primary gate.
 */
import { describe, it, expect } from 'vitest';
import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { RequiredScopes, ForbidApiKey, Public, Authorize } from '../../decorators';
import { auditAdminScopedControllers, auditAdminControllersDeclareNoApiKeyScopes, ADMIN_SCOPED_CONTROLLERS } from '../admin-scope-audit';

/** Same shortcut the sibling audit tests use: real metadata, no DI graph. */
function buildFakeAppFromRealControllers(
  controllers: Array<new (...args: never[]) => unknown>,
): Parameters<typeof auditAdminControllersDeclareNoApiKeyScopes>[0] {
  const wrappers = controllers.map((ControllerClass) => ({
    metatype: ControllerClass,
    instance: Object.create(ControllerClass.prototype) as Record<string, unknown>,
  }));
  const modulesContainer = new Map([['synthetic', { controllers: new Map(wrappers.map((w, i) => [i, w])) }]]);
  const reflector = new Reflector();

  return {
    get: (token: unknown) => {
      if (token === ModulesContainer) return modulesContainer;
      if (token === Reflector) return reflector;
      throw new Error(`unexpected token: ${String(token)}`);
    },
  } as unknown as Parameters<typeof auditAdminControllersDeclareNoApiKeyScopes>[0];
}

describe('A2 — admin plane declares no API-key scopes (derived sweep)', () => {
  it('FAILS an admin-prefixed controller that declares @RequiredScopes', () => {
    @Controller('admin/things')
    @RequiredScopes('admin:tenant:read')
    class AdminScoped {
      @Get()
      @Authorize(['read', 'Tenant'])
      list() {}
    }

    expect(() => auditAdminControllersDeclareNoApiKeyScopes(buildFakeAppFromRealControllers([AdminScoped]))).toThrow(
      /AdminScoped[\s\S]*admin:tenant:read/,
    );
  });

  it('FAILS a METHOD-level @RequiredScopes on an admin controller (class-level absence is not enough)', () => {
    @Controller('admin/things')
    @ForbidApiKey()
    class AdminMethodScoped {
      @Get()
      @RequiredScopes('admin:tenant:read')
      list() {}
    }

    expect(() => auditAdminControllersDeclareNoApiKeyScopes(buildFakeAppFromRealControllers([AdminMethodScoped]))).toThrow(/AdminMethodScoped/);
  });

  it('PASSES an admin-prefixed controller carrying @ForbidApiKey()', () => {
    @Controller('admin/things')
    @ForbidApiKey()
    class AdminForbidden {
      @Get()
      @Authorize(['read', 'Tenant'])
      list() {}
    }

    expect(() => auditAdminControllersDeclareNoApiKeyScopes(buildFakeAppFromRealControllers([AdminForbidden]))).not.toThrow();
  });

  it('PASSES a business-plane controller declaring @RequiredScopes — A1  owns that plane, not A2', () => {
    @Controller('things')
    @RequiredScopes('consultation:session:read')
    class BusinessScoped {
      @Get()
      @Authorize(['read', 'Consultation'])
      list() {}
    }

    expect(() => auditAdminControllersDeclareNoApiKeyScopes(buildFakeAppFromRealControllers([BusinessScoped]))).not.toThrow();
  });

  /**
   * The global prefix is applied by `main.ts`, not by `@Controller`, so the
   * registered path is normally bare `admin/...`. A controller that spells the
   * prefix out explicitly must still be detected — the same tolerance
   * `INTERNAL_ROUTE_RE` needs in `api-key-scope-audit.ts`.
   */
  it('detects an explicitly api/v1-prefixed admin controller', () => {
    @Controller('api/v1/admin/things')
    @RequiredScopes('admin:tenant:read')
    class PrefixedAdminScoped {
      @Get()
      @Authorize(['read', 'Tenant'])
      list() {}
    }

    expect(() => auditAdminControllersDeclareNoApiKeyScopes(buildFakeAppFromRealControllers([PrefixedAdminScoped]))).toThrow(/PrefixedAdminScoped/);
  });

  it('does not match a controller merely PREFIXED by the word admin (administration/...)', () => {
    @Controller('administration/things')
    @RequiredScopes('consultation:session:read')
    class NotAdmin {
      @Get()
      @Authorize(['read', 'Consultation'])
      list() {}
    }

    expect(() => auditAdminControllersDeclareNoApiKeyScopes(buildFakeAppFromRealControllers([NotAdmin]))).not.toThrow();
  });

  it('ignores a @Public() admin route — authentication never runs, so there is no credential class to judge', () => {
    @Controller('admin/things')
    class PublicAdmin {
      @Get()
      @Public()
      @RequiredScopes('admin:tenant:read')
      probe() {}
    }

    expect(() => auditAdminControllersDeclareNoApiKeyScopes(buildFakeAppFromRealControllers([PublicAdmin]))).not.toThrow();
  });

  it('lists every offender in one error', () => {
    @Controller('admin/a')
    @RequiredScopes('admin:tenant:read')
    class OffenderA {
      @Get()
      @Authorize(['read', 'Tenant'])
      list() {}
    }

    @Controller('admin/b')
    @RequiredScopes('admin:user:read')
    class OffenderB {
      @Get()
      @Authorize(['read', 'User'])
      list() {}
    }

    expect(() => auditAdminControllersDeclareNoApiKeyScopes(buildFakeAppFromRealControllers([OffenderA, OffenderB]))).toThrow(
      /OffenderA[\s\S]*OffenderB/,
    );
  });

  /**
   * The real-tree case. This is the assertion that actually proves the
   * 65-controller sweep landed — everything above only proves the audit's
   * logic.
   */
  it('passes against every REAL admin controller in the named list', () => {
    expect(() =>
      auditAdminControllersDeclareNoApiKeyScopes(buildFakeAppFromRealControllers(ADMIN_SCOPED_CONTROLLERS.map((c) => c.controller))),
    ).not.toThrow();
  });
});

describe('boot-time /admin/* named-surface audit (collapsed to FORBID)', () => {
  it('passes for every REAL /admin/* controller', () => {
    expect(() => auditAdminScopedControllers()).not.toThrow();
  });

  it('expects FORBID for every entry — no admin controller may declare a scope any more', () => {
    expect(ADMIN_SCOPED_CONTROLLERS.every((c) => c.expect === 'FORBID')).toBe(true);
  });

  /**
   * The two controllers the hand-transcribed list silently missed,
   * plus `ConsentGrantController`, which was absent though harmless (it was
   * already forbidden). Their absence is exactly why the derived sweep above
   * exists; listing them here closes the transcription gap as well.
 */
  // 70 -> 68: deleted `DepartmentAgentController` and
  // `DepartmentAgentResyncController` with the resource they administered.
  // 68 -> 67: TASK-862 deleted `AdminReconciliationController` with the
  // Provider Reconciliation feature (removed outright, owner directive).
  // 67 -> 66: TASK-862 deleted the legacy `AiProviderConnectionController`
  // (`admin/ai-providers`, the llm-only alias of `admin/providers`).
  // 66 -> 65: TASK-862 deleted `AiRuntimeProfileController` with `AiRuntimeProfile`.
  // 65 -> 64: TASK-881 deleted `AiTaskDefaultAdminController` with the `AiTaskDefault` facade.
  // 64 -> 63: TASK-882 deleted `PipelinePolicyAdminController` with `PipelinePolicy`.
  it('covers all 63 admin-prefixed controllers, including the three the  list missed', () => {
    const names = ADMIN_SCOPED_CONTROLLERS.map((c) => c.controller.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('KnowledgeController');
    expect(names).toContain('WorkflowSandboxRunController');
    expect(names).toContain('ConsentGrantController');
    expect(ADMIN_SCOPED_CONTROLLERS.length).toBe(63);
  });

  it('throws when a listed controller loses its @ForbidApiKey() metadata', () => {
    class Orphan {}

    expect(() => auditAdminScopedControllers([{ controller: Orphan, expect: 'FORBID' }])).toThrow(/Orphan[\s\S]*no @ForbidApiKey/);
  });

  it('throws when a listed controller has REGROWN a @RequiredScopes declaration', () => {
    @RequiredScopes('admin:tenant:write')
    class Regrown {}

    expect(() => auditAdminScopedControllers([{ controller: Regrown, expect: 'FORBID' }])).toThrow(/Regrown[\s\S]*admin:tenant:write/);
  });

  it('passes when a listed controller carries @ForbidApiKey() (sanity — not a false negative)', () => {
    @ForbidApiKey()
    class ForbiddenOk {}

    expect(() => auditAdminScopedControllers([{ controller: ForbiddenOk, expect: 'FORBID' }])).not.toThrow();
  });

  it('lists every offender in one error when multiple controllers drift', () => {
    class OrphanA {}
    class OrphanB {}

    expect(() =>
      auditAdminScopedControllers([
        { controller: OrphanA, expect: 'FORBID' },
        { controller: OrphanB, expect: 'FORBID' },
      ]),
    ).toThrow(/OrphanA[\s\S]*OrphanB|OrphanB[\s\S]*OrphanA/);
  });
});
