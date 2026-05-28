import type { INestApplicationContext } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY } from '@arcaai/applications';

/**
 * Boot-time route permission audit (originally Phase 0 Item 3 / TASK-302
 * Stream A; widened by TASK-307 W4a.1).
 *
 * Walks every controller registered on the Nest application context and
 * refuses to start if any HTTP route lacks BOTH:
 *
 *   1. `@Public()` (sets `SKIP_AUTH_KEY=true`), OR
 *   2. `REQUIRED_PERMISSIONS_KEY` metadata set to an array (any value —
 *      including empty — counts as an explicit "auth-required" label,
 *      matching `AuthorizationGuard.canActivate`'s runtime semantics).
 *
 * Diagnostic-only — this function does NOT change runtime guard
 * behaviour. It surfaces drift before TASK-307 W4b registers
 * `UnifiedAuthGuard` as `APP_GUARD`, so any forgotten decorator is
 * caught at boot rather than silently leaking PHI in production.
 *
 * Implementation notes:
 *
 * - The previous (TASK-302) version walked the Express router stack and
 *   read metadata via `Reflect.getMetadata` on the bound handler only.
 *   NestJS's `RouterExplorer.copyMetadataToCallback` copies METHOD-level
 *   metadata to the route handler but does NOT copy class-level metadata
 *   (verified empirically). This made class-level decorators like
 *   `@CanManage('Tenant')` on `TenantController` invisible to the audit,
 *   so the previous audit silently passed routes whose methods relied
 *   entirely on class-level annotations. The widened audit uses
 *   `Reflector.getAllAndOverride([methodRef, classRef])` so the audit
 *   sees exactly what `AuthorizationGuard` sees at request time.
 * - We use `ModulesContainer` (auto-provided by NestJS's `InternalCoreModule`)
 *   directly instead of `DiscoveryService` so we don't have to import
 *   `DiscoveryModule` into `AppModule` (which would conflict with W4b's
 *   pending changes to that file).
 */
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
        // Any array (including empty) means an explicit @Authorize() / @CanXxx()
        // decorator is present — the runtime guard treats this as
        // "authentication required, no specific permission".
        if (Array.isArray(required)) continue;

        const methodPath = readMethodPath(methodRef);
        const fullPath = joinPath(controllerPath, methodPath);
        const httpMethod = mapRequestMethod(httpMethodCode as number);

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
      `TASK-307 W4a.1: refused to start — ${offenders.length} HTTP route(s) ` +
        `lack both @Public() and a permission decorator:\n${list}`,
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
