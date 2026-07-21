import type { INestApplicationContext } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY } from '@arcaai/applications';

// Side-effect import — patches @Public() metadata onto third-party
// controllers (e.g. willsoto's PrometheusController) that we cannot
// decorate at the source. Must run before the audit walk so the
// metadata is in place when the walk reads it.
import './third-party-public-routes';

/**
 * Boot-time route permission audit.
 *
 * Walks every controller registered on the Nest application context and
 * refuses to start if any HTTP route lacks BOTH:
 *
 *   1. `@Public()` (sets `SKIP_AUTH_KEY=true`), OR
 *   2. `REQUIRED_PERMISSIONS_KEY` metadata set to an array (any value —
 *      including empty — counts as an explicit "auth-required" label,
 *      matching `AuthorizationGuard.canActivate`'s runtime semantics).
 *
 * Rule (2) is narrowed for the `/admin/*` surface: an EMPTY permission
 * array (`@Authorize()` with no tuple) is rejected on admin routes. Admin
 * endpoints must declare a concrete permission (e.g. `@CanManage('Tenant')`),
 * so an auth-only gate can never silently expose an admin route to every
 * authenticated user. End-user routes keep the lenient "any array" rule.
 *
 * Diagnostic-only — this function does NOT change runtime guard
 * behaviour. It surfaces drift before `UnifiedAuthGuard` runs as
 * `APP_GUARD`, so any forgotten decorator is caught at boot rather than
 * silently leaking PHI in production.
 *
 * Implementation notes:
 *
 * - `Reflect.getMetadata` on the bound handler alone is not enough:
 *   NestJS's `RouterExplorer.copyMetadataToCallback` copies METHOD-level
 *   metadata to the route handler but does NOT copy class-level metadata
 *   (verified empirically). That would make class-level decorators like
 *   `@CanManage('Tenant')` on `TenantController` invisible to the audit,
 *   silently passing routes whose methods rely entirely on class-level
 *   annotations. Using `Reflector.getAllAndOverride([methodRef, classRef])`
 *   instead makes the audit see exactly what `AuthorizationGuard` sees at
 *   request time.
 * - We use `ModulesContainer` (auto-provided by NestJS's `InternalCoreModule`)
 *   directly instead of `DiscoveryService` so we don't have to import
 *   `DiscoveryModule` into `AppModule`, avoiding a conflict with the guard
 *   wiring there.
 */
// Matches `/admin/...` and the versioned `/api/v<N>/admin/...` prefix used
// in production. Anchored so only the admin surface is narrowed.
const ADMIN_ROUTE_RE = /^\/(api\/v\d+\/)?admin\//;

export function auditAdminRoutePermissions(app: INestApplicationContext): void {
  const modulesContainer = app.get(ModulesContainer);
  const reflector = app.get(Reflector);
  const metadataScanner = new MetadataScanner();

  const offenders: string[] = [];

  for (const moduleRef of modulesContainer.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const ControllerClass = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!ControllerClass || !instance) continue;

      const proto = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!proto) continue;

      const controllerPath = readControllerPath(ControllerClass);

      for (const methodName of metadataScanner.getAllMethodNames(proto)) {
        const methodRef = proto[methodName];
        if (typeof methodRef !== 'function') continue;

        const httpMethodCode = Reflect.getMetadata(METHOD_METADATA, methodRef);
        if (httpMethodCode === undefined) continue;

        const skipAuth = reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [methodRef, ControllerClass]);
        if (skipAuth === true) continue;

        const required = reflector.getAllAndOverride<unknown>(REQUIRED_PERMISSIONS_KEY, [methodRef, ControllerClass]);

        const methodPath = readMethodPath(methodRef);
        const fullPath = joinPath(controllerPath, methodPath);
        const httpMethod = mapRequestMethod(httpMethodCode as number);
        const isAdminRoute = ADMIN_ROUTE_RE.test(fullPath);

        // Any array (including empty) means an explicit @Authorize() / @CanXxx()
        // decorator is present — the runtime guard treats this as
        // "authentication required, no specific permission".
        if (Array.isArray(required)) {
          // An empty @Authorize() (auth-only) is acceptable on end-user
          // routes but a security smell on the /admin surface — every
          // admin route must name the concrete permission it requires.
          if (isAdminRoute && required.length === 0) {
            offenders.push(
              `Route ${httpMethod} ${fullPath} on ${ControllerClass.name}.${methodName} is an /admin route ` +
                `with an empty @Authorize() (no specific permission). Admin routes MUST declare a concrete ` +
                `permission — use @CanManage('Subject') or @Authorize(['action','Subject']).`,
            );
          }
          continue;
        }

        offenders.push(
          `Route ${httpMethod} ${fullPath} on ${ControllerClass.name}.${methodName} has neither ` +
            `@Public() nor REQUIRED_PERMISSIONS_KEY. This is a security risk. ` +
            `Add @Public() or @Authorize() / @CanXxx().`,
        );
      }
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map((o) => `  - ${o}`).join('\n');
    throw new Error(
      `TASK-307 W4a.1: refused to start — ${offenders.length} HTTP route(s) ` + `lack both @Public() and a permission decorator:\n${list}`,
    );
  }
}

function readControllerPath(controllerClass: new (...args: unknown[]) => unknown): string {
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
