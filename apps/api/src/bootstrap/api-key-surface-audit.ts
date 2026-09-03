/**
 * Boot-time audit: the API-key surface is DECLARED, never inferred.
 *
 * `UnifiedAuthGuard`'s API-key path fails closed — a route that declares no
 * `@RequiredScopes(...)` refuses API-key callers outright
 * (`enforceApiKeyScopes`). This audit is the static half of that rule and
 * enforces the invariant PLATFORM-WIDE:
 *
 *   For every HTTP route registered on the application, one of the following
 *   must be true:
 *     1. `@Public()` — authentication never runs, so there is nothing to
 *        declare (these routes are covered by `admin-route-permission-audit.ts`
 *        and, under `/internal/*`, by `auditInternalRoutesOffApiKeySurface`).
 *     2. `@RequiredScopes(...)` with at least one scope — an explicit "an API
 *        key holding one of these may do this".
 *     3. `@ForbidApiKey()` — an explicit "no API key may ever do this".
 *
 * Anything else is UNDECLARED, and undeclared is a boot failure.
 *
 * ─── Why a boot failure and not a warning ──────────────────────────────────
 *
 * Because the runtime already denies these routes. Without this audit the
 * omission surfaces as a 403 to whichever caller happens to hit the route
 * first, in whichever environment happens to reach it first. With it, the
 * omission surfaces to the engineer who added the route, at the moment they
 * add it, with the route named. This is the same shape as
 * `admin-route-permission-audit.ts`'s "@Public() or a permission decorator"
 * rule, which has held the JWT side of the gateway honest since.
 *
 * ─── Why this exists alongside the two hand-listed audits ──────────────────
 *
 * `auditApiKeyRequiredScopes` (`SDK_DAY1_SCOPED_ROUTES`) and
 * `auditAdminScopedControllers` (`ADMIN_SCOPED_CONTROLLERS`) pin that a NAMED
 * surface keeps a NAMED gate — they catch a scope silently changing VALUE, and
 * they carry the "this is the SDK's day-1 contract" / "this is the owner-
 * approved `/admin/*` narrowing" framing in their own lists. They cannot catch
 * a brand-new controller nobody added to a list. This audit catches exactly
 * that, and only that: presence of a declaration, never its value. Keep all
 * three; they fail for different reasons.
 *
 * Walks `ModulesContainer` and reads metadata through the app's own
 * `Reflector` with `getAllAndOverride([methodRef, ControllerClass])`, so it
 * sees precisely what `UnifiedAuthGuard` sees at request time — including
 * class-level decorators, which Nest does NOT copy onto route handlers (the
 * trap documented at length in `admin-route-permission-audit.ts`).
 */
import type { INestApplicationContext } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { API_KEY_FORBIDDEN, API_KEY_REQUIRED_SCOPES, SKIP_AUTH_KEY } from '@arcaai/applications';

// Side-effect import — patches @Public() onto third-party controllers we cannot
// decorate at the source (e.g. willsoto's PrometheusController). Must run
// before the walk, exactly as `admin-route-permission-audit.ts` requires.
import './third-party-public-routes';

export function auditEveryApiKeyReachableRouteDeclaresScopes(app: INestApplicationContext): void {
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

        // 1. @Public() — UnifiedAuthGuard returns before it ever looks for a key.
        const skipAuth = reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [methodRef, ControllerClass]);
        const legacyPublic = reflector.getAllAndOverride<boolean>('isPublic', [methodRef, ControllerClass]);
        if (skipAuth === true || legacyPublic === true) continue;

        // 2. @ForbidApiKey() — an explicit, deliberate "never".
        const forbidden = reflector.getAllAndOverride<boolean>(API_KEY_FORBIDDEN, [methodRef, ControllerClass]);
        if (forbidden === true) continue;

        // 3. @RequiredScopes(...) — an explicit opt-in. An EMPTY array is not a
        //    declaration: `enforceApiKeyScopes` treats it identically to absent
        //    (nothing could ever satisfy it), so the audit must too, or a
        //    `@RequiredScopes()` typo would look declared and behave denied.
        const scopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [methodRef, ControllerClass]);
        if (Array.isArray(scopes) && scopes.length > 0) continue;

        const fullPath = joinPath(controllerPath, readMethodPath(methodRef));
        const httpMethod = mapRequestMethod(httpMethodCode as number);

        offenders.push(
          `Route ${httpMethod} ${fullPath} on ${ControllerClass.name}.${methodName} declares nothing about API-key access. ` +
            `Since  the API-key path fails closed, so this route already REFUSES every API key at runtime — ` +
            `the declaration is missing, not the enforcement. Add @RequiredScopes('<scope>') ` +
            `(packages/applications/src/services/apiKey/apikey-scopes.registry.ts) if an API key legitimately reaches it, ` +
            `or @ForbidApiKey() if it is an interactive-human-only surface.`,
        );
      }
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map((o) => `  - ${o}`).join('\n');
    throw new Error(`refused to start — ${offenders.length} route(s) declare neither @RequiredScopes(...) nor @ForbidApiKey():\n${list}`);
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
