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
import { Reflector } from '@nestjs/core';
import { API_KEY_REQUIRED_SCOPES } from '@arcaai/applications';
import { SmrCompatController } from '../modules/text-compat/text-compat.controller';
import { ConsultationController } from '../modules/consultation/consultation.controller';
import { ConsultationJobController } from '../modules/consultation/consultation-job.controller';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- constructor signature is intentionally unconstrained; only prototype methods are ever read off it
type ControllerClass = new (...args: any[]) => unknown;

interface ScopedRoute {
  controller: ControllerClass;
  method: string;
}

/** The HOPE Node SDK's day-1 surface. */
export const SDK_DAY1_SCOPED_ROUTES: ScopedRoute[] = [
  { controller: SmrCompatController, method: 'summarySync' },
  { controller: SmrCompatController, method: 'presummary' },
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
