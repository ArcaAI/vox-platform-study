/**
 * TASK-307 W4a.2 — Auth-coverage integration test.
 *
 * Walks every controller registered in `AppModule` and asserts that
 * each HTTP route declares EITHER:
 *
 *   1. `@Public()` (sets `SKIP_AUTH_KEY=true`), OR
 *   2. `REQUIRED_PERMISSIONS_KEY` metadata set to an array — any value,
 *      including an empty array. An empty array means
 *      `@Authorize()` was applied with no specific permission tuple,
 *      which `AuthorizationGuard.canActivate` treats as
 *      "authentication required, no specific permission". This matches
 *      the runtime guard's semantics exactly.
 *
 * This is the **AC-13 part 1 verification gate** for TASK-307 W4a:
 * W4a merges only when this test is green so W4b's runtime
 * `APP_GUARD` flip lands on a known-clean route table.
 *
 * Implementation note — the plan-README mentions `DiscoveryService` +
 * `MetadataScanner`. We instead walk `AppModule`'s `@Module` metadata
 * tree directly because `Test.createTestingModule({ imports: [AppModule] })
 * .compile()` triggers `BullModule.registerQueue` → eager ioredis
 * connection on port 6380, which fails in CI without a running Redis.
 * The static walk is functionally equivalent (and cheaper):
 *
 * - We collect controllers via recursive `Reflect.getMetadata('imports', M)`
 *   + `Reflect.getMetadata('controllers', M)`.
 * - For each controller method, we use `new Reflector()` (a stateless
 *   wrapper over `Reflect.getMetadata`) and the same
 *   `getAllAndOverride([method, class])` precedence the runtime guard
 *   uses. This sees class-level decorators like `@CanManage('Tenant')`
 *   on `TenantController` exactly the same way `AuthorizationGuard`
 *   sees them at request time.
 *
 * Boot-time `auditAdminRoutePermissions` is the production-side mirror
 * of this same check (W4a.1) — both are diagnostic only; W4b registers
 * `UnifiedAuthGuard` as `APP_GUARD` to make the runtime default deny.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Reflector, MetadataScanner, APP_GUARD } from '@nestjs/core';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Controller, Get, RequestMethod, type DynamicModule, type INestApplication, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import {
  Authorize,
  IApiKeyService,
  PolicyEngine,
  Public,
  REQUIRED_PERMISSIONS_KEY,
  SKIP_AUTH_KEY,
  UnifiedAuthGuard,
} from '@arcaai/applications';
import { AppModule } from '../../src/app.module';

// Side-effect import — applies @Public() to third-party controllers.
// Same import the production audit pulls in; keeps the test in sync
// with what AuthorizationGuard sees at request time.
import '../../src/bootstrap/third-party-public-routes';

interface RouteHit {
  controllerName: string;
  methodName: string;
  httpMethod: string;
  path: string;
  hasPublic: boolean;
  hasRequiredPermissions: boolean;
}

type ControllerClass = new (...args: unknown[]) => unknown;
type ModuleLike = Type<unknown> | DynamicModule | { default: Type<unknown> };

function isClass(value: unknown): value is ControllerClass {
  return typeof value === 'function';
}

/**
 * Recursively walk `@Module` metadata starting at `rootModule` and
 * collect every controller class declared along the way.
 */
function collectControllerClasses(rootModule: ModuleLike): ControllerClass[] {
  const seen = new Set<unknown>();
  const out: ControllerClass[] = [];

  const visit = (mod: ModuleLike | unknown): void => {
    if (!mod || typeof mod !== 'object' && typeof mod !== 'function') return;
    if (seen.has(mod)) return;
    seen.add(mod);

    let imports: unknown[] = [];
    let controllers: unknown[] = [];

    if (typeof mod === 'function') {
      // Static @Module class — read metadata.
      imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) as unknown[]) ?? [];
      controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod) as unknown[]) ?? [];
    } else if (typeof mod === 'object') {
      // DynamicModule (e.g. RedisServiceModule.register(...)).
      const dyn = mod as DynamicModule;
      imports = (dyn.imports as unknown[]) ?? [];
      controllers = (dyn.controllers as unknown[]) ?? [];
      // The "module" key on a DynamicModule points back at the static
      // class, which may carry additional metadata (e.g. AppModule
      // declares its own controllers via the static @Module decorator).
      if (dyn.module && typeof dyn.module === 'function') {
        visit(dyn.module);
      }
    }

    for (const c of controllers) {
      if (isClass(c) && !out.includes(c)) {
        out.push(c);
      }
    }
    for (const imp of imports) {
      // Promise-based / forwardRef'd / async DynamicModules cannot be
      // resolved without DI. We skip them rather than crash; the boot-
      // time audit (W4a.1) is the production safety net.
      if (typeof imp === 'function' || (typeof imp === 'object' && imp !== null)) {
        visit(imp as ModuleLike);
      }
    }
  };

  visit(rootModule);
  return out;
}

function readControllerPath(controllerClass: ControllerClass): string {
  const raw = Reflect.getMetadata(PATH_METADATA, controllerClass);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return '';
}

function readMethodPath(methodRef: unknown): string {
  const raw = Reflect.getMetadata(PATH_METADATA, methodRef as object);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return '';
}

function joinPath(controllerPath: string, methodPath: string): string {
  const normalize = (segment: string): string => {
    if (!segment) return '';
    return segment.startsWith('/') ? segment : `/${segment}`;
  };
  const a = normalize(controllerPath).replace(/\/+$/, '');
  const b = normalize(methodPath).replace(/\/+$/, '');
  const joined = `${a}${b}` || '/';
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function mapRequestMethod(code: number): string {
  switch (code) {
    case RequestMethod.GET:
      return 'GET';
    case RequestMethod.POST:
      return 'POST';
    case RequestMethod.PUT:
      return 'PUT';
    case RequestMethod.DELETE:
      return 'DELETE';
    case RequestMethod.PATCH:
      return 'PATCH';
    case RequestMethod.OPTIONS:
      return 'OPTIONS';
    case RequestMethod.HEAD:
      return 'HEAD';
    case RequestMethod.ALL:
      return 'ALL';
    default:
      return 'UNKNOWN';
  }
}

describe('TASK-307 W4a.2 / AC-13 part 1 — every AppModule route is labeled (@Public OR REQUIRED_PERMISSIONS_KEY)', () => {
  const reflector = new Reflector();
  const metadataScanner = new MetadataScanner();

  let routes: RouteHit[];

  beforeAll(() => {
    const controllers = collectControllerClasses(AppModule);
    const hits: RouteHit[] = [];

    for (const ControllerClass of controllers) {
      const proto = ControllerClass.prototype as Record<string, unknown> | null;
      if (!proto) continue;

      for (const methodName of metadataScanner.getAllMethodNames(proto)) {
        const methodRef = proto[methodName];
        if (typeof methodRef !== 'function') continue;

        const httpMethodCode = Reflect.getMetadata(METHOD_METADATA, methodRef);
        if (httpMethodCode === undefined) continue;

        const skipAuth = reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [methodRef, ControllerClass]);
        const required = reflector.getAllAndOverride<unknown>(REQUIRED_PERMISSIONS_KEY, [methodRef, ControllerClass]);

        hits.push({
          controllerName: ControllerClass.name,
          methodName,
          httpMethod: mapRequestMethod(httpMethodCode as number),
          path: joinPath(readControllerPath(ControllerClass), readMethodPath(methodRef)),
          hasPublic: skipAuth === true,
          hasRequiredPermissions: Array.isArray(required),
        });
      }
    }

    routes = hits;
  });

  it('discovers a non-empty list of HTTP routes from AppModule', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('every route declares @Public() OR REQUIRED_PERMISSIONS_KEY (no drift)', () => {
    const drift = routes.filter((r) => !r.hasPublic && !r.hasRequiredPermissions);

    if (drift.length > 0) {
      const lines = drift.map((r) => `  - ${r.httpMethod} ${r.path} on ${r.controllerName}.${r.methodName}`);
      throw new Error(
        `${drift.length} HTTP route(s) lack both @Public() and REQUIRED_PERMISSIONS_KEY:\n` +
          `${lines.join('\n')}\n\n` +
          `Each drifted route must add @Public() (legitimately unauthenticated) or ` +
          `@Authorize() / @CanXxx() (requires auth + permissions).\n` +
          `When TASK-307 W4b registers UnifiedAuthGuard as APP_GUARD, drifted routes will return 401 by default.`,
      );
    }

    expect(drift).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TASK-307 W4b — Global APP_GUARD runtime walk (synthetic module).
//
// Why a synthetic module instead of `Test.createTestingModule({ imports:
// [AppModule] }).compile()` (which the plan README §3 lists for AC-13
// part 2): booting AppModule from a unit/integration test hangs.
// AppModule's eager DI graph opens BullMQ workers (each ioredis-backed),
// runs `Issuer.discover()` against an external OIDC provider, and fires
// `AppSettingsService.initializeCache()` (Prisma calls). `compile()`
// never returns in this environment. See W4b dispatch prompt Step 0 for
// the previous agent's full investigation summary.
//
// Option A (locked in by user, 2026-05-28): validate the guard CONTRACT
// directly with a synthetic test module that wires `UnifiedAuthGuard`
// as `APP_GUARD` + the three minimal fixture controllers needed to
// observe the runtime behaviour. Route-table coverage against the
// production AppModule remains the responsibility of W4a's static
// metadata walk above + the boot-time `auditAdminRoutePermissions`
// check (widened in W4a).
//
// W7 follow-up: file a deferred task to build a proper AppModule
// integration test harness — likely a `TestAppModule` that re-exports
// AppModule's controllers + providers but stubs the infra-heavy
// modules. Not in TASK-307 scope.
// ────────────────────────────────────────────────────────────────────────────

@Controller('test/unprotected')
class _UnprotectedFixtureController {
  @Get()
  get() {
    return { ok: true };
  }
}

@Controller('test/public')
class _PublicFixtureController {
  @Get()
  @Public()
  get() {
    return { ok: true };
  }
}

@Controller('test/authorized')
class _AuthorizedFixtureController {
  @Get()
  @Authorize()
  get() {
    return { ok: true };
  }
}

describe('TASK-307 W4b / AC-13 part 2 — global APP_GUARD runtime walk (synthetic module)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({
          global: true,
          middleware: { mount: true },
        }),
      ],
      controllers: [_UnprotectedFixtureController, _PublicFixtureController, _AuthorizedFixtureController],
      providers: [
        Reflector,
        {
          provide: IApiKeyService,
          useValue: {
            extractApiKeyFromRequest: () => null,
            authenticateByRawKey: () => {
              throw new Error('IApiKeyService.authenticateByRawKey should not be called in W4b synthetic tests');
            },
            hasScope: () => false,
          },
        },
        // Stub PolicyEngine so UnifiedAuthGuard can resolve its dependency;
        // never invoked because the synthetic flow never reaches JWT post-auth
        // (no JWT_AUTH_GUARD provider → guard short-circuits to 401).
        {
          provide: PolicyEngine,
          useValue: {
            buildAbility: () => {
              throw new Error('PolicyEngine.buildAbility should not be called in W4b synthetic tests');
            },
          },
        },
        // The runtime flip — registers `UnifiedAuthGuard` as the
        // application-wide guard. With this in place, the unprotected
        // fixture controller now returns 401 by default; @Public() opts
        // out; @Authorize() routes still require auth.
        { provide: APP_GUARD, useClass: UnifiedAuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('unprotected fixture controller returns 401 without Authorization header', async () => {
    const res = await request(app.getHttpServer()).get('/test/unprotected');
    expect(res.status).toBe(401);
  });

  it('@Public() fixture controller returns NOT 401 without Authorization header', async () => {
    const res = await request(app.getHttpServer()).get('/test/public');
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('@Authorize() fixture controller returns 401 without Authorization header', async () => {
    const res = await request(app.getHttpServer()).get('/test/authorized');
    expect(res.status).toBe(401);
  });
});
