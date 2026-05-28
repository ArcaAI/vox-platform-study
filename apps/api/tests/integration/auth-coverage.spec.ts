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

import { describe, it, expect, beforeAll } from 'vitest';
import { Reflector, MetadataScanner } from '@nestjs/core';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod, type DynamicModule, type Type } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY } from '@arcaai/applications';
import { AppModule } from '../../src/app.module';

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
