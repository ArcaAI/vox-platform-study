/**
 * Boot-time audit: the HOPE Node SDK's day-1 summarization surface
 * must never silently lose API-key scope enforcement.
 *
 * (docs/implementation/TASK-632-HOPE-Node-SDK/README.md): previously,
 * `API_KEY_SCOPE_REGISTRY` and `UnifiedAuthGuard.enforceApiKeyScopes` both
 * existed, but no decorator ever SET `API_KEY_REQUIRED_SCOPES` metadata, so
 * `requiredScopes` was always `undefined` and any valid API key reached
 * every route RBAC permitted. That gap closed on the routes below by
 * applying `@RequiredScopes(...)`. This audit is the regression guard: it
 * fails the boot if a future refactor (renamed method, moved decorator,
 * route rewritten) drops that metadata without anyone noticing.
 *
 * Deliberately narrow — this does NOT walk every controller in the app
 * (unlike `admin-route-permission-audit.ts`'s full sweep). It checks
 * exactly the fixed list of routes the Node SDK calls day-1. Widening it
 * into a gateway-wide "every API-key-reachable route must have scopes"
 * policy is out of scope; see the gap note on that README.
 *
 * Reads `Reflect` metadata directly off the controller prototypes via a
 * plain `Reflector` — no `INestApplicationContext` / DI graph needed, since
 * the target routes are known statically (unlike the admin audit, which
 * must discover them by walking `ModulesContainer`).
 */
import type { INestApplicationContext } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { API_KEY_REQUIRED_SCOPES, SKIP_AUTH_KEY } from '@arcaai/applications';
import { TextCompatController } from '../modules/text-compat/text-compat.controller';
import { ConsultationController } from '../modules/consultation/consultation.controller';
import { ConsultationJobController } from '../modules/consultation/consultation-job.controller';
import { WorkflowsController } from '../modules/workflows/workflows.controller';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructor signature is intentionally unconstrained; only prototype methods are ever read off it
type ControllerClass = new (...args: any[]) => unknown;

interface ScopedRoute {
  controller: ControllerClass;
  method: string;
}

/** The HOPE Node SDK's day-1 surface. */
export const SDK_DAY1_SCOPED_ROUTES: ScopedRoute[] = [
  { controller: TextCompatController, method: 'summarySync' },
  { controller: TextCompatController, method: 'presummary' },
  { controller: ConsultationController, method: 'generateSummary' },
  { controller: ConsultationController, method: 'generatePreSummary' },
  { controller: ConsultationController, method: 'generateSummaryAsync' },
  { controller: ConsultationController, method: 'generatePreSummaryAsync' },
  { controller: ConsultationController, method: 'getSummaries' },
  { controller: ConsultationController, method: 'getLatestSummary' },
  { controller: ConsultationController, method: 'getLatestPreSummary' },
  // The SDK also reaches these two. They were missed on the first pass because the
  // route list was derived from "summarization routes" rather than from the SDK's
  // actual method→route map — `consultations.get()` and `summaries.update()` are
  // day-1 surface too, and were left unscoped while everything around them was gated.
  { controller: ConsultationController, method: 'getById' },
  { controller: ConsultationController, method: 'updateSummary' },
  { controller: ConsultationJobController, method: 'getJob' },
  { controller: ConsultationJobController, method: 'cancelJob' },
  { controller: ConsultationJobController, method: 'streamJob' },
  // TASK-722's exposure plane — the surface S-2/R-1 exist to gate. Every route reaches this
  // audit (not `admin-scope-audit.ts`'s ADMIN_SCOPED_CONTROLLERS list — `/workflows/*` is not
  // an `/admin/*` route). Coordinate with TASK-708, which hardens this same list.
  { controller: WorkflowsController, method: 'list' },
  { controller: WorkflowsController, method: 'invoke' },
  { controller: WorkflowsController, method: 'getRunStatus' },
  { controller: WorkflowsController, method: 'cancelRun' },
  { controller: WorkflowsController, method: 'streamRunStatus' },
];

export function auditApiKeyRequiredScopes(routes: ScopedRoute[] = SDK_DAY1_SCOPED_ROUTES): void {
  const reflector = new Reflector();
  const offenders: string[] = [];

  for (const { controller, method } of routes) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- indexing the prototype by a dynamic method name; the typeof check right below is the real guard
    const handler = (controller.prototype as any)[method];
    if (typeof handler !== 'function') {
      offenders.push(`${controller.name}.${method} does not exist — TASK-632 B1 audit target is stale, update SDK_DAY1_SCOPED_ROUTES.`);
      continue;
    }

    const scopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [handler, controller]);

    if (!Array.isArray(scopes) || scopes.length === 0) {
      offenders.push(
        `${controller.name}.${method} is on the HOPE Node SDK's day-1 surface but carries no ` +
          `@RequiredScopes(...) metadata. A leaked API key would reach this route with no scope check. ` +
          `Add @RequiredScopes('<scope>') from packages/applications/src/services/apiKey/apikey-scopes.registry.ts.`,
      );
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map((o) => `  - ${o}`).join('\n');
    throw new Error(
      `TASK-632 B1: refused to start — ${offenders.length} API-key-reachable summarization route(s) lack API_KEY_REQUIRED_SCOPES metadata:\n${list}`,
    );
  }
}

/**
 * Boot-time audit (TASK-708): every `/internal/*` route must be fully OFF
 * the API-key (and JWT) auth surface — gated by a dedicated platform
 * service-token guard instead, never by `@RequiredScopes`.
 *
 * Background: `/internal/*` routes used to rely on ordinary `UnifiedAuthGuard`
 * auth. `ApiKeyService.extractApiKeyFromRequest` treats `x-internal-service-key`
 * as an ordinary API-key header, so — before this closed —
 * `SttInternalController` was reachable by ANY valid API key, tenant or
 * platform, presented via `apikey`/`api-key`/`x-api-key`/`x-internal-service-key`
 * (see that controller's own doc comment). A per-route scope was tried first
 * and reverted: the owner's decision was that `/admin/*` (scope-narrowed —
 * see `auditApiKeyRequiredScopes` above and the `admin:*` scope family in
 * `apikey-scopes.registry.ts`) and `/internal/*` (guard-only) were designed
 * for different purposes and must not be unified under one mechanism.
 *
 * "Off the API-key surface" means, for every `/internal/*` route:
 *   1. `@Public()` is set (`SKIP_AUTH_KEY===true`) — `UnifiedAuthGuard`
 *      short-circuits before ever attempting API-key or JWT auth (its
 *      `authenticate()`: `if (isPublic) return true;`), so no key of any
 *      kind — tenant or platform, any scope — reaches the route via that
 *      path at all.
 *   2. The controller (or the route) carries a recognised platform
 *      service-token guard via `@UseGuards(...)` — so the route is not
 *      actually unauthenticated, just authenticated by a different,
 *      non-API-key primitive (a shared secret compared out of band).
 *
 * Walks `ModulesContainer` (like `admin-route-permission-audit.ts`) rather
 * than a fixed route list, so a brand-new `/internal/*` controller that
 * forgets the guard fails boot immediately instead of silently reopening the
 * gap this ticket closed.
 */
const INTERNAL_ROUTE_RE = /^\/(api\/v\d+\/)?internal\//;

/**
 * Recognised platform service-token guards — `CanActivate` classes that
 * authenticate a service-to-service caller by a shared secret compared out
 * of band, never by an API key or JWT. Add a new guard's class name here
 * when a new `/internal/*` surface is introduced (and nowhere else — this is
 * intentionally a closed allow-list, not "any guard at all", so a
 * `@UseGuards(SomeUnrelatedGuard)` typo doesn't silently satisfy the audit).
 */
export const RECOGNISED_SERVICE_TOKEN_GUARD_NAMES: ReadonlySet<string> = new Set([
  'InternalServiceTokenGuard',
  'HarnessServiceTokenGuard',
  'ServiceReleaseTokenGuard',
]);

/**
 * Controllers under `/internal/*` that are deliberately gated by a RESERVED
 * `internal:` API-key scope instead of a service-token guard.
 *
 * There is exactly one, and it is not a style choice: the STT worker
 * authenticates with `X-Internal-Service-Key` carrying `api_gateway_key`, which
 * BUG-013 requires to be the RAW value of a registered ACTIVE SERVICE_ACCOUNT
 * `ApiKey` row. The live send sites are `apps/stt/src/stt/core/api_client/gateway.py`
 * (`"X-Internal-Service-Key": self.api_key`) and
 * `apps/stt/src/stt/core/effective_config.py` — corrected by TASK-759 (D-3):
 * the previous citation `apps/stt/src/stt/worker.py:209` now points at
 * SERVICE-RELEASE REGISTRATION, not the STT internal callback path. It presents
 * an API KEY, not a service token, so pulling this controller off the API-key
 * surface would break the worker unless `apps/stt` changed in lockstep.
 *
 * The exemption is POLICED, not a hole: an exempted controller must still carry
 * `@RequiredScopes` with a scope under the reserved `internal:` root, which no
 * tenant SDK/WEBHOOK/INTEGRATION key is ever issued and which prefix matching
 * cannot cross. Removing that decorator fails boot exactly like the guard case.
 *
 * FROZEN AT ONE MEMBER (TASK-761 gate G2, decision D-3). Policing the exemption
 * never constrained its SIZE: adding a second name here is a one-line change
 * that silently re-opens the API-key path under `/internal/*` for that
 * controller, with no boot failure and nothing in the diff louder than a
 * string. `api-key-scope-audit.test.ts` therefore pins the exact membership, so
 * widening it requires editing a test — which forces the discussion into review
 * rather than letting it happen by accident. Exported for that pin only; it is
 * not part of any runtime contract.
 */
export const RESERVED_INTERNAL_SCOPE_CONTROLLERS: ReadonlySet<string> = new Set(['SttInternalController']);

const RESERVED_INTERNAL_SCOPE_PREFIX = 'internal:';

export function auditInternalRoutesOffApiKeySurface(app: INestApplicationContext): void {
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

        const methodPath = readMethodPath(methodRef);
        const fullPath = joinPath(controllerPath, methodPath);
        if (!INTERNAL_ROUTE_RE.test(fullPath)) continue;

        // Reserved-scope exemption (see RESERVED_INTERNAL_SCOPE_CONTROLLERS).
        // Policed: the controller must actually carry an `internal:`-rooted
        // @RequiredScopes, or it falls through to the offender checks below.
        if (RESERVED_INTERNAL_SCOPE_CONTROLLERS.has(ControllerClass.name)) {
          const scopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [methodRef, ControllerClass]) ?? [];
          if (scopes.some((s) => s.startsWith(RESERVED_INTERNAL_SCOPE_PREFIX))) continue;
          offenders.push(
            `Route ${fullPath} on ${ControllerClass.name}.${methodName} is exempted from the service-token-guard rule ` +
              `(it is gated by a reserved API-key scope because the STT worker presents an API key per BUG-013), but it ` +
              `carries no @RequiredScopes under the reserved '${RESERVED_INTERNAL_SCOPE_PREFIX}' root. The exemption is ` +
              `policed: restore the reserved scope, or remove the controller from RESERVED_INTERNAL_SCOPE_CONTROLLERS ` +
              `and gate it with a platform service-token guard instead.`,
          );
          continue;
        }

        const skipAuth = reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [methodRef, ControllerClass]);
        if (skipAuth !== true) {
          offenders.push(
            `Route ${fullPath} on ${ControllerClass.name}.${methodName} is under /internal/* but is not @Public() — it is ` +
              `still reachable through UnifiedAuthGuard's JWT/API-key auth path, exactly the gap TASK-708 closed for ` +
              `SttInternalController. Mark it @Public() and gate it with a dedicated platform service-token guard instead.`,
          );
          continue;
        }

        if (!hasRecognisedServiceTokenGuard(methodRef, ControllerClass)) {
          offenders.push(
            `Route ${fullPath} on ${ControllerClass.name}.${methodName} is @Public() under /internal/* but carries no ` +
              `recognised platform service-token guard (@UseGuards(...)). A @Public() route with no guard is ` +
              `UNAUTHENTICATED. Add a dedicated guard (see InternalServiceTokenGuard / HarnessServiceTokenGuard / ` +
              `ServiceReleaseTokenGuard as examples) and register its class name in ` +
              `RECOGNISED_SERVICE_TOKEN_GUARD_NAMES.`,
          );
        }
      }
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map((o) => `  - ${o}`).join('\n');
    throw new Error(
      `TASK-708: refused to start — ${offenders.length} /internal/* route(s) are reachable off a platform service-token guard:\n${list}`,
    );
  }
}

function hasRecognisedServiceTokenGuard(methodRef: unknown, ControllerClass: new (...args: unknown[]) => unknown): boolean {
  const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, methodRef as object) as unknown[] | undefined) ?? [];
  const classGuards = (Reflect.getMetadata(GUARDS_METADATA, ControllerClass) as unknown[] | undefined) ?? [];
  return [...methodGuards, ...classGuards].some((guard) => RECOGNISED_SERVICE_TOKEN_GUARD_NAMES.has(guardName(guard)));
}

function guardName(guard: unknown): string {
  if (typeof guard === 'function') return guard.name;
  if (guard && typeof guard === 'object' && 'constructor' in guard) return (guard as { constructor: { name: string } }).constructor.name;
  return '';
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
