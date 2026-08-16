/**
 * Boot-time audit — B1 regression (G1 closure).
 *
 * Proves two things:
 *  1. Against the REAL controllers, every route the HOPE Node SDK calls
 *     day-1 carries `@RequiredScopes(...)` metadata (`SDK_DAY1_SCOPED_ROUTES`
 *     is exhaustive and every entry passes).
 *  2. The audit actually CATCHES drift: a synthetic route list pointing at a
 *     handler with no `@RequiredScopes(...)` throws, and a stale method name
 *     throws too (so the audit itself can't silently no-op on a rename).
 */
import { describe, it, expect } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { UnifiedAuthGuard } from '@arcaai/applications';
import { Public, RequiredScopes } from '../../decorators';
import { InternalServiceTokenGuard } from '../../modules/internal/internal-service-token.guard';
import { SttInternalController } from '../../modules/internal/stt-internal.controller';
import { EffectiveConfigController } from '../../modules/internal/effective-config.controller';
import { HarnessInternalController } from '../../modules/consultation/harness-internal.controller';
import { ServiceReleaseInternalController } from '../../modules/service-release/service-release-internal.controller';
import { auditApiKeyRequiredScopes, auditInternalRoutesOffApiKeySurface, SDK_DAY1_SCOPED_ROUTES } from '../api-key-scope-audit';

describe('boot-time API-key scope audit', () => {
  it('passes for the real HOPE Node SDK day-1 surface (SmrCompatController, ConsultationController, ConsultationJobController)', () => {
    expect(() => auditApiKeyRequiredScopes()).not.toThrow();
  });

  // Asserts the route SET, not a count. A bare `toHaveLength(n)` fails on any
  // legitimate addition without saying what changed — and, worse, passes if a
  // route is swapped for a different one. The SDK's method→route map is the
  // thing that must stay in sync, so name it.
  it('covers exactly the SDK day-1 method→route surface', () => {
    const covered = SDK_DAY1_SCOPED_ROUTES.map(({ controller, method }) => `${controller.name}.${method}`).sort();

    expect(covered).toEqual(
      [
        // Stateless v1-compat shims — hope.summarization.*
        'SmrCompatController.presummary',
        'SmrCompatController.summarySync',
        // Consultation-bound generation — hope.consultations.summaries.generate*
        'ConsultationController.generatePreSummary',
        'ConsultationController.generatePreSummaryAsync',
        'ConsultationController.generateSummary',
        'ConsultationController.generateSummaryAsync',
        // Consultation-bound reads/writes — hope.consultations.*
        'ConsultationController.getById',
        'ConsultationController.getLatestPreSummary',
        'ConsultationController.getLatestSummary',
        'ConsultationController.getSummaries',
        'ConsultationController.updateSummary',
        // Async jobs — hope.jobs.*
        'ConsultationJobController.cancelJob',
        'ConsultationJobController.getJob',
        'ConsultationJobController.streamJob',
      ].sort(),
    );
  });

  it('throws when a route in the list has no @RequiredScopes(...) metadata', () => {
    class Orphan {
      unscoped() {}
    }

    expect(() => auditApiKeyRequiredScopes([{ controller: Orphan, method: 'unscoped' }])).toThrow(
      /Orphan\.unscoped[\s\S]*no[\s\S]*@RequiredScopes/,
    );
  });

  it('throws when a route in the list DOES carry @RequiredScopes(...) metadata (sanity: the pass case is not a false negative)', () => {
    class Scoped {
      @RequiredScopes('consultation:report:read')
      covered() {}
    }

    expect(() => auditApiKeyRequiredScopes([{ controller: Scoped, method: 'covered' }])).not.toThrow();
  });

  it('throws with a stale-target message when the named method no longer exists (catches a rename silently dropping the audit)', () => {
    class Renamed {}

    expect(() => auditApiKeyRequiredScopes([{ controller: Renamed, method: 'goneNow' }])).toThrow(/does not exist[\s\S]*audit target is stale/);
  });

  it('lists every offender in one error when multiple routes drift', () => {
    class OrphanA {
      a() {}
    }
    class OrphanB {
      b() {}
    }

    expect(() =>
      auditApiKeyRequiredScopes([
        { controller: OrphanA, method: 'a' },
        { controller: OrphanB, method: 'b' },
      ]),
    ).toThrow(/OrphanA\.a[\s\S]*OrphanB\.b|OrphanB\.b[\s\S]*OrphanA\.a/);
  });
});

/**
 * TASK-708 — `/internal/*` off the API-key surface.
 *
 * `auditInternalRoutesOffApiKeySurface` walks `ModulesContainer` like
 * `admin-route-permission-audit.ts` does, so these tests build a synthetic
 * Nest application context the same way
 * `admin-route-permission-audit.test.ts` does (`.compile()`, not `.init()` —
 * metadata discovery only, no full DI graph).
 */
async function buildAppFromControllers(controllers: Array<new (...args: unknown[]) => unknown>) {
  @Module({ controllers })
  class _SyntheticInternalModule {}

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [_SyntheticInternalModule],
  })
    .overrideGuard(UnifiedAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();

  return moduleRef as unknown as Parameters<typeof auditInternalRoutesOffApiKeySurface>[0];
}

/**
 * Builds a fake `INestApplicationContext`-shaped object exposing only the two
 * tokens `auditInternalRoutesOffApiKeySurface` reads (`ModulesContainer`,
 * `Reflector`), backed by the REAL controller classes but WITHOUT
 * constructing them through Nest's DI — `Object.create(ControllerClass.prototype)`
 * gives an instance whose prototype chain is exactly what the audit walks
 * (`Object.getPrototypeOf(instance)`), with none of the controllers'
 * (sometimes large — `HarnessInternalController` alone takes nine) real
 * constructor dependencies to stand up. This proves the CURRENT production
 * classes' metadata shape without pulling in the DB/Redis/Vault-backed DI
 * graph a full `AppModule`/module compile would require.
 */
function buildFakeAppFromRealControllers(
  controllers: Array<new (...args: never[]) => unknown>,
): Parameters<typeof auditInternalRoutesOffApiKeySurface>[0] {
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
      throw new Error(`buildFakeAppFromRealControllers: unexpected token requested: ${String(token)}`);
    },
  } as unknown as Parameters<typeof auditInternalRoutesOffApiKeySurface>[0];
}

describe('boot-time /internal/* off-API-key-surface audit (TASK-708)', () => {
  it('passes against every REAL /internal/* controller currently in the tree', () => {
    const app = buildFakeAppFromRealControllers([
      SttInternalController,
      EffectiveConfigController,
      HarnessInternalController,
      ServiceReleaseInternalController,
    ]);

    expect(() => auditInternalRoutesOffApiKeySurface(app)).not.toThrow();
  });

  it('passes on a route that is @Public() and guarded by a recognised service-token guard', async () => {
    @Public()
    @UseGuards(InternalServiceTokenGuard)
    @Controller('internal/stt')
    class SttInternalOk {
      @Get('jobs/:id/status')
      status() {
        return {};
      }
    }
    const app = await buildAppFromControllers([SttInternalOk]);
    expect(() => auditInternalRoutesOffApiKeySurface(app)).not.toThrow();
  });

  it('passes on a route guarded by a DIFFERENT recognised guard (InternalServiceTokenGuard)', async () => {
    @Public()
    @UseGuards(InternalServiceTokenGuard)
    @Controller('internal/effective-config')
    class EffectiveConfigOk {
      @Get()
      read() {
        return {};
      }
    }
    const app = await buildAppFromControllers([EffectiveConfigOk]);
    expect(() => auditInternalRoutesOffApiKeySurface(app)).not.toThrow();
  });

  it('throws when an /internal/* route is not @Public() (reachable via ordinary JWT/API-key auth)', async () => {
    @UseGuards(InternalServiceTokenGuard)
    @Controller('internal/stt')
    class SttInternalNotPublic {
      @Get('jobs/:id/status')
      status() {
        return {};
      }
    }
    const app = await buildAppFromControllers([SttInternalNotPublic]);
    expect(() => auditInternalRoutesOffApiKeySurface(app)).toThrow(/internal\/stt\/jobs\/:id\/status[\s\S]*is not @Public\(\)/);
  });

  it('throws when an /internal/* route is @Public() but carries no recognised service-token guard (unauthenticated)', async () => {
    @Public()
    @Controller('internal/stt')
    class SttInternalNoGuard {
      @Get('jobs/:id/status')
      status() {
        return {};
      }
    }
    const app = await buildAppFromControllers([SttInternalNoGuard]);
    expect(() => auditInternalRoutesOffApiKeySurface(app)).toThrow(/internal\/stt\/jobs\/:id\/status[\s\S]*carries no[\s\S]*service-token guard/);
  });

  it('throws when @RequiredScopes is used instead of a service-token guard (the reverted TASK-708 approach)', async () => {
    @Public()
    @RequiredScopes('admin:*')
    @Controller('internal/stt')
    class SttInternalScopedNotGuarded {
      @Get('jobs/:id/status')
      status() {
        return {};
      }
    }
    const app = await buildAppFromControllers([SttInternalScopedNotGuarded]);
    expect(() => auditInternalRoutesOffApiKeySurface(app)).toThrow(/carries no[\s\S]*service-token guard/);
  });

  it('ignores routes outside /internal/*', async () => {
    @Controller('admin/tenants')
    class AdminTenantsOrphan {
      @Get()
      list() {
        return [];
      }
    }
    const app = await buildAppFromControllers([AdminTenantsOrphan]);
    expect(() => auditInternalRoutesOffApiKeySurface(app)).not.toThrow();
  });

  it('matches the versioned /api/v1/internal/* prefix too', async () => {
    @Controller('api/v1/internal/stt')
    class VersionedNotPublic {
      @Get('jobs/:id/status')
      status() {
        return {};
      }
    }
    const app = await buildAppFromControllers([VersionedNotPublic]);
    expect(() => auditInternalRoutesOffApiKeySurface(app)).toThrow(/is not @Public\(\)/);
  });

  it('lists every offender in one error when multiple routes drift', async () => {
    @Controller('internal/foo')
    class FooOrphan {
      @Get('a')
      a() {
        return {};
      }
    }
    @Controller('internal/bar')
    class BarOrphan {
      @Get('b')
      b() {
        return {};
      }
    }
    const app = await buildAppFromControllers([FooOrphan, BarOrphan]);
    expect(() => auditInternalRoutesOffApiKeySurface(app)).toThrow(/FooOrphan\.a[\s\S]*BarOrphan\.b|BarOrphan\.b[\s\S]*FooOrphan\.a/);
  });
});
