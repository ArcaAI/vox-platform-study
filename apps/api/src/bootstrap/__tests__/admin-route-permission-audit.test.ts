/**
 * Boot-time route permission audit.
 *
 * Walks ALL routes (not just `/admin/*`) using `DiscoveryService` +
 * `Reflector.getAllAndOverride([method, class])`, so class-level
 * decorators (e.g. a controller-level `@CanManage('Tenant')` with no
 * method-level decorator on a given route) are honoured the same way
 * the `AuthorizationGuard` honours them at runtime.
 *
 * "Labeled" means: `SKIP_AUTH_KEY === true` (i.e. `@Public()`) OR
 * `REQUIRED_PERMISSIONS_KEY` metadata is set to an array (any value,
 * including an empty array — `@Authorize()` with no permission tuples
 * is still an explicit "auth-required" label per the runtime guard's
 * semantics in `AuthorizationGuard.canActivate`).
 */

import { describe, it, expect } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { auditAdminRoutePermissions } from '../admin-route-permission-audit';
import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY, UnifiedAuthGuard } from '@arcaai/applications';
import { Authorize, CanManage, Public } from '../../decorators';

/**
 * Build a tiny Nest application context (no `listen`) from a list of
 * controller classes so the audit walks the same `ModulesContainer`
 * surface it sees in production. We avoid `app.init()` because it
 * triggers full module initialisation (DB, Redis, secrets); `compile()`
 * is sufficient for metadata discovery.
 *
 * `Authorize`/`CanXxx` are metadata-only (they don't apply
 * `@UseGuards(UnifiedAuthGuard)`), so the `.overrideGuard(UnifiedAuthGuard)`
 * below is a defensive no-op: the boot audit reads METADATA
 * (`REQUIRED_PERMISSIONS_KEY` / `SKIP_AUTH_KEY`), not guards. It is retained so
 * that if a controller in a future test re-applies the guard directly, the
 * testing module still compiles without the full auth-stack DI graph
 * (Reflector, IApiKeyService, PolicyEngine, ClsService, ...).
 */
async function buildAppFromControllers(controllers: Array<new (...args: unknown[]) => unknown>) {
  @Module({ controllers })
  class _SyntheticModule {}

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [_SyntheticModule],
  })
    .overrideGuard(UnifiedAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();

  return moduleRef as unknown as Parameters<typeof auditAdminRoutePermissions>[0];
}

describe('boot-time route permission audit (widened to ALL routes)', () => {
  describe('admin route coverage (regression — Phase 0 Item 3)', () => {
    it('passes when every admin route declares required_permissions via class-level @CanManage', async () => {
      @CanManage('User')
      @Controller('admin/users')
      class AdminUsersOk {
        @Get()
        list() {
          return [];
        }

        @Get(':id')
        getOne() {
          return {};
        }
      }
      const app = await buildAppFromControllers([AdminUsersOk]);
      expect(() => auditAdminRoutePermissions(app)).not.toThrow();
    });

    it('passes on a public admin route marked @Public()', async () => {
      @Controller('admin/pstudio')
      class AdminPublic {
        @Get()
        @Public()
        page() {
          return 'html';
        }
      }
      const app = await buildAppFromControllers([AdminPublic]);
      expect(() => auditAdminRoutePermissions(app)).not.toThrow();
    });

    it('throws when an admin route is missing required_permissions', async () => {
      @Controller('admin/orphans')
      class AdminOrphan {
        @Get()
        list() {
          return [];
        }
      }
      const app = await buildAppFromControllers([AdminOrphan]);
      expect(() => auditAdminRoutePermissions(app)).toThrow(/admin\/orphans.*has neither @Public\(\) nor REQUIRED_PERMISSIONS_KEY/);
    });
  });

  describe('non-admin route coverage (W4a.1 widening)', () => {
    it('throws when a non-admin route has neither @Public() nor any permission decorator', async () => {
      @Controller('consultations')
      class ConsultationsOrphan {
        @Get()
        list() {
          return [];
        }
      }
      const app = await buildAppFromControllers([ConsultationsOrphan]);
      expect(() => auditAdminRoutePermissions(app)).toThrow(/ConsultationsOrphan\.list.*has neither @Public\(\) nor REQUIRED_PERMISSIONS_KEY/);
    });

    it('throws when an auth route (login) has no decorator at all', async () => {
      @Controller('auth')
      class AuthOrphan {
        @Post('login')
        login() {
          return { ok: true };
        }
      }
      const app = await buildAppFromControllers([AuthOrphan]);
      expect(() => auditAdminRoutePermissions(app)).toThrow(/AuthOrphan\.login.*has neither @Public/);
    });

    it('passes on a non-admin route marked @Public()', async () => {
      @Controller('health')
      class HealthOk {
        @Get('live')
        @Public()
        live() {
          return { status: 'healthy' };
        }
      }
      const app = await buildAppFromControllers([HealthOk]);
      expect(() => auditAdminRoutePermissions(app)).not.toThrow();
    });

    it('passes on a non-admin route guarded by class-level @Authorize() (empty)', async () => {
      @Authorize()
      @Controller('consultations/jobs')
      class ConsultationJobsOk {
        @Get(':id')
        getJob() {
          return {};
        }
      }
      const app = await buildAppFromControllers([ConsultationJobsOk]);
      expect(() => auditAdminRoutePermissions(app)).not.toThrow();
    });

    it('passes on a non-admin route with method-level specific permissions', async () => {
      @Controller('voice-profile')
      class VoiceProfileOk {
        @Post(':id/activate')
        @CanManage('UserVoiceProfile')
        activate() {
          return {};
        }
      }
      const app = await buildAppFromControllers([VoiceProfileOk]);
      expect(() => auditAdminRoutePermissions(app)).not.toThrow();
    });
  });

  // Admin routes must declare a CONCRETE permission. An empty @Authorize()
  // (auth-only, no permission tuple) is an acceptable label on end-user
  // routes but a security smell on the /admin surface, where every route
  // should name the specific permission it requires.
  describe('/admin routes require a non-empty permission', () => {
    it('throws when an /admin route carries only an empty @Authorize() (no specific permission)', async () => {
      @Authorize()
      @Controller('admin/reports')
      class AdminEmptyAuthorize {
        @Get()
        list() {
          return [];
        }
      }
      const app = await buildAppFromControllers([AdminEmptyAuthorize]);
      expect(() => auditAdminRoutePermissions(app)).toThrow(/admin\/reports.*empty @Authorize\(\)/);
    });

    it('passes when an /admin route declares a concrete permission via @CanManage', async () => {
      @CanManage('Consultation')
      @Controller('admin/consultations')
      class AdminConsultationsOk {
        @Get()
        list() {
          return [];
        }
      }
      const app = await buildAppFromControllers([AdminConsultationsOk]);
      expect(() => auditAdminRoutePermissions(app)).not.toThrow();
    });

    it('still allows an empty @Authorize() on a NON-admin route (regression)', async () => {
      @Authorize()
      @Controller('consultations')
      class EndUserEmptyAuthorize {
        @Get()
        list() {
          return [];
        }
      }
      const app = await buildAppFromControllers([EndUserEmptyAuthorize]);
      expect(() => auditAdminRoutePermissions(app)).not.toThrow();
    });
  });

  describe('error message shape', () => {
    it('includes the controller name, method name, and the suggested decorators', async () => {
      @Controller('foo')
      class FooOrphan {
        @Get('bar/:id')
        bar() {
          return {};
        }
      }
      const app = await buildAppFromControllers([FooOrphan]);
      expect(() => auditAdminRoutePermissions(app)).toThrow(
        /Route GET .*\/foo\/bar\/:id on FooOrphan\.bar has neither @Public\(\) nor REQUIRED_PERMISSIONS_KEY\. This is a security risk\. Add @Public\(\) or @Authorize\(\) \/ @CanXxx\(\)\./,
      );
    });

    it('lists all offenders in a single error when multiple controllers drift', async () => {
      @Controller('a')
      class A {
        @Get()
        a() {
          return {};
        }
      }
      @Controller('b')
      class B {
        @Get()
        b() {
          return {};
        }
      }
      const app = await buildAppFromControllers([A, B]);
      expect(() => auditAdminRoutePermissions(app)).toThrow(/A\.a[\s\S]*B\.b|B\.b[\s\S]*A\.a/);
    });
  });

  describe('honours metadata key constants', () => {
    it('uses the @arcaai/applications SKIP_AUTH_KEY symbol exactly', () => {
      expect(typeof SKIP_AUTH_KEY).toBe('string');
      expect(SKIP_AUTH_KEY).toBe('skip_auth');
    });

    it('uses the @arcaai/applications REQUIRED_PERMISSIONS_KEY symbol exactly', () => {
      expect(typeof REQUIRED_PERMISSIONS_KEY).toBe('string');
      expect(REQUIRED_PERMISSIONS_KEY).toBe('required_permissions');
    });
  });
});
