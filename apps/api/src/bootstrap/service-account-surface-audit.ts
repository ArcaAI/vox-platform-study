/**
 * Boot-time audits for the THIRD credential class (TASK-762 §5.7).
 *
 * The owner's TASK-708 §6 non-mixing ruling ("we cannot mix the `/admin/*` and
 * `/internal/*` routes as they were designed for different purposes") is
 * currently satisfied by ACCIDENT OF IMPLEMENTATION rather than by an enforced
 * invariant — §2.1 of the ticket verified that no `/admin/*` controller uses a
 * service-token guard, but nothing STOPS one from doing so tomorrow. These
 * audits make the ruling mechanical: the shortcut becomes a boot failure rather
 * than a code-review argument.
 *
 * Assertions implemented here (the letters are the ticket's §5.7 table):
 *
 *   B — no `admin/`-prefixed controller uses a recognised service-token guard.
 *       Today this passes vacuously. Pinning it is the entire point.
 *   C — no `internal/`-prefixed controller declares a `svc:*` scope. The mirror
 *       of B: the new class must not leak onto the peer-service plane either.
 *   D — every `svc:*` registry scope maps to a live admin area and vice-versa.
 *   E — `admin/service-accounts` carries BOTH `@ForbidApiKey()` and
 *       `@ForbidServiceAccount()`. No key-path escalation into machine
 *       issuance, and no self-replication.
 *   F — the token-exchange route is `@Public()` AND carries its own guard.
 *       Public must never mean unguarded.
 *   G — every route reachable by a service-account token declares either a
 *       `svc:*` scope or `@ForbidServiceAccount()`. Deny-by-default extended to
 *       the third class; mirrors `auditEveryApiKeyReachableRouteDeclaresScopes`.
 *   H — (TASK-773) every controller TASK-757 stripped an `admin:<area>` scope
 *       from declares its `svc:admin:<area>` twin, and NOTHING ELSE. G checks
 *       that a declared scope is well-formed and registry-known; it structurally
 *       CANNOT see a scope that is well-formed, registry-known and WRONG — the
 *       exact outcome of a 64-controller sweep applied by hand. H is the
 *       acceptance test for that sweep.
 *
 * Assertion A (no `admin/` controller declares `@RequiredScopes`) is TASK-757's
 * to add, once `@ForbidApiKey()` has actually been applied across the admin
 * plane — asserting it now would fail the boot on the 67 admin controllers that
 * legitimately still carry their `admin:*` scopes. It is deliberately NOT
 * implemented here; see the ticket README.
 *
 * Reads metadata through the app's own `Reflector` with
 * `getAllAndOverride([methodRef, ControllerClass])`, so it sees exactly what
 * `UnifiedAuthGuard` sees at request time — including class-level decorators,
 * which Nest does NOT copy onto route handlers.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import {
  API_KEY_FORBIDDEN,
  SERVICE_ACCOUNT_FORBIDDEN,
  SERVICE_ACCOUNT_REQUIRED_SCOPES,
  SERVICE_ACCOUNT_SCOPE_REGISTRY,
  SKIP_AUTH_KEY,
  API_KEY_SCOPE_REGISTRY,
  ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES,
  STANDALONE_FEATURE_SVC_SCOPES,
  resolveServiceAccountImpliedPermissions,
  toServiceAccountScope,
} from '@arcaai/applications';

import './third-party-public-routes';
// The TASK-773 evidence fixture is EVIDENCE, not configuration: a mechanical
// transcription of the 64 class-level `@RequiredScopes('admin:<area>')`
// decorators commit 276f96a32 removed. It lives beside its own consistency test
// (`__tests__/task-773-admin-scope-map.test.ts`, which proves every row still
// names a real class and a live registry scope) and is imported here rather
// than re-typed, because a second copy of the map in boot code is exactly the
// drift this audit exists to catch. It is pure data — no test framework, no
// runtime dependency — and `tsconfig.build.json` compiles it as a normal import
// of `src/**` despite the `__tests__` exclude, which only filters the ENTRY
// glob.
import { TASK_773_ADMIN_SCOPE_MAP } from './__tests__/fixtures/task-773-admin-scope-map';

/**
 * The service-token guard class NAMES the audit recognises. Matched by name,
 * not by identity, so the audit does not have to import three guard classes
 * from three feature modules (and so a FOURTH one added later is caught by
 * adding one string here rather than a new import graph).
 */
const SERVICE_TOKEN_GUARD_NAMES = new Set(['InternalServiceTokenGuard', 'HarnessServiceTokenGuard', 'ServiceReleaseTokenGuard']);

interface RouteInfo {
  ControllerClass: new (...args: never[]) => unknown;
  controllerPath: string;
  methodName: string;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Reflector.getAllAndOverride's target tuple is typed `Type | Function`; this mirrors it.
  methodRef: Function;
  fullPath: string;
}

function walkRoutes(app: INestApplicationContext): RouteInfo[] {
  const modulesContainer = app.get(ModulesContainer);
  const metadataScanner = new MetadataScanner();
  const routes: RouteInfo[] = [];

  for (const moduleRef of modulesContainer.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const ControllerClass = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!ControllerClass || !instance) continue;

      const proto = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!proto) continue;

      const controllerPath = readPath(ControllerClass);

      for (const methodName of metadataScanner.getAllMethodNames(proto)) {
        const methodRef = proto[methodName];
        if (typeof methodRef !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, methodRef) === undefined) continue;

        routes.push({
          ControllerClass,
          controllerPath,
          methodName,
          methodRef: methodRef as (...args: never[]) => unknown,
          fullPath: joinPath(controllerPath, readPath(methodRef)),
        });
      }
    }
  }
  return routes;
}

/**
 * Assertion B — the owner's non-mixing ruling, made mechanical.
 *
 * An `/admin/*` controller that reached for a service-token guard would be
 * granting every Python peer service platform-administrator reach through ONE
 * shared devops-set secret with no per-caller identity, no per-caller scope and
 * no revocation granularity. That is the specific shortcut TASK-762 exists as
 * an alternative to, so it fails the boot rather than review.
 */
export function auditNoAdminControllerUsesServiceTokenGuard(app: INestApplicationContext): void {
  const offenders: string[] = [];
  const seen = new Set<string>();

  for (const route of walkRoutes(app)) {
    if (!isAdminPath(route.controllerPath)) continue;
    if (seen.has(route.ControllerClass.name)) continue;

    const classGuards = readGuardNames(route.ControllerClass);
    const methodGuards = readGuardNames(route.methodRef);
    const forbidden = [...classGuards, ...methodGuards].filter((name) => SERVICE_TOKEN_GUARD_NAMES.has(name));

    if (forbidden.length > 0) {
      seen.add(route.ControllerClass.name);
      offenders.push(
        `${route.ControllerClass.name} (${route.controllerPath}) uses ${forbidden.join(', ')}. ` +
          `The TASK-708 §6 owner ruling forbids mixing the /admin/* and /internal/* mechanisms: the service token is ONE shared secret with ` +
          `no per-caller identity, scope or revocation, so granting it admin reach makes every peer service a platform administrator. ` +
          `Use a service account (/admin/service-accounts + @RequiredSvcScopes) instead.`,
      );
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `TASK-762: refused to start — ${offenders.length} admin controller(s) use a peer-service token guard:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    );
  }
}

/**
 * Assertion C — the mirror of B. `svc:*` is the ADMIN-plane machine vocabulary;
 * an `/internal/*` route declaring one would be pulling the third class onto
 * the peer-service plane, mixing in the other direction.
 */
export function auditNoInternalControllerDeclaresSvcScopes(app: INestApplicationContext): void {
  const reflector = app.get(Reflector);
  const offenders: string[] = [];

  for (const route of walkRoutes(app)) {
    if (!isInternalPath(route.controllerPath)) continue;

    const scopes = reflector.getAllAndOverride<string[]>(SERVICE_ACCOUNT_REQUIRED_SCOPES, [route.methodRef, route.ControllerClass]);
    if (Array.isArray(scopes) && scopes.length > 0) {
      offenders.push(
        `${route.ControllerClass.name}.${route.methodName} (${route.fullPath}) declares svc:* scope(s) ${scopes.join(', ')}. ` +
          `The svc:* namespace belongs to the /admin/* plane; /internal/* is peer-service territory and stays on the service-token guard.`,
      );
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `TASK-762: refused to start — ${offenders.length} internal route(s) declare a svc:* scope:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    );
  }
}

/**
 * Assertion D — no orphan scopes, no ungated admin areas, no ability-less scope.
 *
 * The registry DERIVES `svc:admin:<area>` from every concrete `admin:<area>`
 * scope, (TASK-767) `svc:<feature>` from each named standalone business scope,
 * and (TASK-773 / O-1) `svc:<area>` from each admin-plane area whose gating
 * scope predates the `admin:<area>` convention — today just
 * `webhook:event:write` at `admin/webhooks`. The first two checks normally hold
 * by construction. They are
 * asserted anyway because "holds by construction" is a property of today's
 * `buildRegistry()`: the day someone hand-adds a `svc:*` entry, this is what
 * catches it.
 *
 * Each non-admin family is checked against its OWN closed source list rather
 * than against their union-as-a-blob, so a `svc:` scope that belongs to neither
 * still fails the boot with the name of the constant it should have been
 * declared in. That separation is the point: it is what stops "somewhere in a
 * sources list" becoming the justification for a machine grant.
 *
 * The LAST check is TASK-767's addition and it pins a different failure —
 * the one the TASK-766 seed note calls out. `hasServiceAccountScope` is pure
 * string matching, so a registered scope carrying NO implied ability still
 * satisfies `enforceServiceAccountScopes`, while `serviceAccountPolicyRules`
 * contributes nothing for it and `enforceServiceAccountAbilities` then denies
 * any route that declares a permission pair. A credential that passes the
 * scope gate and fails the ability gate is the worst of both worlds to debug,
 * so it fails the boot instead.
 */
export function auditSvcScopeCoverage(): void {
  const adminScopes = Object.keys(API_KEY_SCOPE_REGISTRY).filter((s) => s.startsWith('admin:') && !s.endsWith(':*'));
  const svcScopes = Object.keys(SERVICE_ACCOUNT_SCOPE_REGISTRY).filter((s) => !s.endsWith(':*'));
  const svcAdminScopes = svcScopes.filter((s) => s.startsWith(toServiceAccountScope('admin:')));
  const svcNonAdminScopes = svcScopes.filter((s) => !s.startsWith(toServiceAccountScope('admin:')));

  const uncovered = adminScopes.filter((s) => !SERVICE_ACCOUNT_SCOPE_REGISTRY[toServiceAccountScope(s)]);
  const orphans = svcAdminScopes.filter((s) => !adminScopes.includes(s.slice('svc:'.length)));
  // Both non-admin families are closed: exactly the declared sources, nothing else.
  const missingStandalone = STANDALONE_FEATURE_SVC_SCOPES.filter((s) => !SERVICE_ACCOUNT_SCOPE_REGISTRY[s]);
  const missingPreConvention = ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES.filter((s) => !SERVICE_ACCOUNT_SCOPE_REGISTRY[s]);
  const declaredNonAdmin = new Set([...STANDALONE_FEATURE_SVC_SCOPES, ...ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES]);
  const unexpectedNonAdmin = svcNonAdminScopes.filter((s) => !declaredNonAdmin.has(s));
  const abilityless = Object.keys(SERVICE_ACCOUNT_SCOPE_REGISTRY).filter((s) => resolveServiceAccountImpliedPermissions(s).length === 0);

  const problems: string[] = [];
  if (uncovered.length > 0) problems.push(`admin areas with no svc:* scope: ${uncovered.join(', ')}`);
  if (orphans.length > 0) problems.push(`svc:admin:* scopes mapping to no live admin area: ${orphans.join(', ')}`);
  if (missingStandalone.length > 0) problems.push(`declared standalone-feature scopes missing from the registry: ${missingStandalone.join(', ')}`);
  if (missingPreConvention.length > 0)
    problems.push(`declared admin-plane pre-convention scopes missing from the registry: ${missingPreConvention.join(', ')}`);
  if (unexpectedNonAdmin.length > 0)
    problems.push(
      `non-admin svc:* scopes declared in neither STANDALONE_FEATURE_SCOPE_SOURCES nor ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES: ${unexpectedNonAdmin.join(', ')}. ` +
        `Add the source scope to the family it actually belongs to — standalone BUSINESS-plane features, or an ADMIN-plane area whose gating scope ` +
        `predates the admin:<area> convention — so the ability mapping is derived, never hand-written.`,
    );
  if (abilityless.length > 0)
    problems.push(
      `svc:* scopes that resolve to ZERO abilities: ${abilityless.join(', ')}. ` +
        `Such a scope passes the guard and is then refused by CASL — wire its implied permission or delete it.`,
    );

  if (problems.length > 0) {
    throw new Error(`TASK-762/767/773: refused to start — svc:* scope coverage is broken:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

/**
 * Assertion E — machine-identity issuance excludes BOTH other credential
 * classes. `@ForbidApiKey()` stops a key-path escalation into minting;
 * `@ForbidServiceAccount()` stops self-replication.
 */
export function auditServiceAccountControllerForbidsBothClasses(app: INestApplicationContext): void {
  const reflector = app.get(Reflector);
  const offenders: string[] = [];

  for (const route of walkRoutes(app)) {
    if (!normalizePath(route.controllerPath).startsWith('/admin/service-accounts')) continue;

    const apiKeyForbidden = reflector.getAllAndOverride<boolean>(API_KEY_FORBIDDEN, [route.methodRef, route.ControllerClass]);
    const svcForbidden = reflector.getAllAndOverride<boolean>(SERVICE_ACCOUNT_FORBIDDEN, [route.methodRef, route.ControllerClass]);

    const missing: string[] = [];
    if (apiKeyForbidden !== true) missing.push('@ForbidApiKey()');
    if (svcForbidden !== true) missing.push('@ForbidServiceAccount()');
    if (missing.length > 0) {
      offenders.push(`${route.ControllerClass.name}.${route.methodName} (${route.fullPath}) is missing ${missing.join(' and ')}`);
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `TASK-762: refused to start — service-account issuance must exclude both other credential classes:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    );
  }
}

/**
 * Assertion F — the token-exchange route is `@Public()` (it establishes a
 * credential, so it cannot require one) AND carries its own guard. Same
 * invariant the `/internal/*` audit already enforces: public never means
 * unguarded.
 */
export function auditTokenExchangeRouteIsPublicAndGuarded(app: INestApplicationContext): void {
  const reflector = app.get(Reflector);
  const matches = walkRoutes(app).filter((r) => normalizePath(r.fullPath) === '/auth/service-token');

  if (matches.length === 0) {
    throw new Error('TASK-762: refused to start — the service-account token-exchange route (POST /auth/service-token) is not registered.');
  }

  const offenders: string[] = [];
  for (const route of matches) {
    const isPublic =
      reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [route.methodRef, route.ControllerClass]) === true ||
      reflector.getAllAndOverride<boolean>('isPublic', [route.methodRef, route.ControllerClass]) === true;
    const guards = [...readGuardNames(route.ControllerClass), ...readGuardNames(route.methodRef)];

    if (!isPublic)
      offenders.push(`${route.ControllerClass.name}.${route.methodName} must be @Public() — it is the route that establishes a credential`);
    if (guards.length === 0)
      offenders.push(`${route.ControllerClass.name}.${route.methodName} is @Public() with NO guard — public must never mean unguarded`);
  }

  if (offenders.length > 0) {
    throw new Error(`TASK-762: refused to start — token-exchange route posture is wrong:\n${offenders.map((o) => `  - ${o}`).join('\n')}`);
  }
}

/**
 * Assertion G — deny-by-default, extended to the third class.
 *
 * `UnifiedAuthGuard.enforceServiceAccountScopes` already refuses an undeclared
 * route at request time. This turns that runtime refusal into an authoring
 * error, exactly as `auditEveryApiKeyReachableRouteDeclaresScopes` does for
 * keys.
 *
 * NOTE ON SCOPE: right now no route in the tree declares `@RequiredSvcScopes`,
 * so requiring an explicit `@ForbidServiceAccount()` on every one of the
 * platform's routes would fail the boot on hundreds of them for no security
 * benefit — the runtime already denies them all. This audit therefore enforces
 * the invariant where it can bite: any route that DOES declare a `svc:*` scope
 * must not simultaneously forbid machines (a contradiction that would read as
 * "reachable" while denying every request). The full every-route form belongs
 * with TASK-757's admin-plane cutover, when `svc:*` declarations actually land.
 */
export function auditServiceAccountReachableRoutesAreDeclared(app: INestApplicationContext): void {
  const reflector = app.get(Reflector);
  const offenders: string[] = [];

  for (const route of walkRoutes(app)) {
    const scopes = reflector.getAllAndOverride<string[]>(SERVICE_ACCOUNT_REQUIRED_SCOPES, [route.methodRef, route.ControllerClass]);
    if (!Array.isArray(scopes) || scopes.length === 0) continue;

    const forbidden = reflector.getAllAndOverride<boolean>(SERVICE_ACCOUNT_FORBIDDEN, [route.methodRef, route.ControllerClass]);
    if (forbidden === true) {
      offenders.push(
        `${route.ControllerClass.name}.${route.methodName} (${route.fullPath}) declares @RequiredSvcScopes(${scopes.join(', ')}) AND @ForbidServiceAccount(). ` +
          `These contradict: the route advertises itself as machine-reachable while denying every machine token. Remove one.`,
      );
      continue;
    }

    const unknown = scopes.filter((s) => !SERVICE_ACCOUNT_SCOPE_REGISTRY[s]);
    if (unknown.length > 0) {
      offenders.push(`${route.ControllerClass.name}.${route.methodName} (${route.fullPath}) declares unknown svc:* scope(s): ${unknown.join(', ')}`);
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `TASK-762: refused to start — ${offenders.length} service-account route declaration(s) are inconsistent:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    );
  }
}

/**
 * Assertion H (TASK-773) — the admin plane's machine declaration is COMPLETE
 * and CORRECT, row by row against the evidence fixture.
 *
 * TASK-757 swept one class-level `@RequiredScopes('admin:<area>')` off each of
 * 64 admin controllers, leaving them JWT-only. TASK-773 puts the machine
 * declaration back as `@RequiredSvcScopes(toServiceAccountScope('admin:<area>'))`
 * — the SAME area, renamespaced. That sweep is applied controller by controller,
 * which is precisely the kind of work that mis-assigns one row.
 *
 * ─── Why G is not enough ────────────────────────────────────────────────────
 *
 * {@link auditServiceAccountReachableRoutesAreDeclared} checks a declared scope
 * for two properties: that it is registry-known, and that it does not coexist
 * with `@ForbidServiceAccount()`. A copy-paste that gives `TenantController`
 * `svc:admin:department:manage` satisfies BOTH — the scope is real, the registry
 * knows it, nothing contradicts it — while handing every machine identity
 * holding department reach the ability to write tenants. G has no notion of
 * WHICH area a controller belongs to, so it cannot see this class of error at
 * all. H supplies that notion from the fixture, and it is the only assertion in
 * this file that does.
 *
 * ─── What it enforces, per fixture row ──────────────────────────────────────
 *
 *   1. The named controller class is still registered in some module. A rename
 *      or deletion that leaves the fixture stale would otherwise SHRINK
 *      coverage silently — the loop would simply stop checking that area.
 *   2. Every route on it resolves (through the app's own `Reflector`, with the
 *      `[methodRef, ControllerClass]` override order `UnifiedAuthGuard` uses) to
 *      a `svc:*` declaration that is EXACTLY `[svc:admin:<area>]`. Not empty
 *      (the sweep missed it — the route is machine-unreachable), not a different
 *      twin (mis-assigned), and not a superset (a method-level widening).
 *   3. It does not simultaneously carry `@ForbidServiceAccount()`.
 *
 * ─── Deliberately NOT covered ───────────────────────────────────────────────
 *
 * Three `admin/`-prefixed controllers had no `admin:*` scope to renamespace and
 * stay absent from the fixture, which records the 64-controller sweep only.
 * Owner decision **O-1** (2026-08-19) settled them separately: `WebhookController`
 * (`admin/webhooks`) is OPEN, declaring `svc:webhook:event:write` from the
 * pre-convention family (`ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES`, reconciled
 * by assertion D); `MonitoringController` and `AdminHealthServicesController`
 * are CLOSED with `@ForbidServiceAccount()`. Three more are machine-CLOSED by
 * owner decision D-3 and must never
 * appear here: `ServiceAccountController` (no self-replication),
 * `AdminImpersonationController`, `ConsentGrantController`. Because this audit
 * is driven ENTIRELY by the fixture's rows, all six are ignored by construction
 * — it never enumerates admin controllers itself.
 */
export function auditAdminControllersDeclareCorrectSvcScope(app: INestApplicationContext): void {
  const reflector = app.get(Reflector);

  const routesByClassName = new Map<string, RouteInfo[]>();
  for (const route of walkRoutes(app)) {
    const existing = routesByClassName.get(route.ControllerClass.name);
    if (existing) existing.push(route);
    else routesByClassName.set(route.ControllerClass.name, [route]);
  }

  const offenders: string[] = [];

  for (const row of TASK_773_ADMIN_SCOPE_MAP) {
    const expected = toServiceAccountScope(row.adminScope);
    const routes = routesByClassName.get(row.controllerClass);

    if (!routes || routes.length === 0) {
      offenders.push(
        `${row.controllerClass} (${row.file}) is named by the TASK-773 evidence fixture but is not registered by any module — ` +
          `no route was found for it. A rename or deletion silently REMOVES an admin area from this audit's coverage, so it fails the boot: ` +
          `update the fixture (and re-verify it against commit 276f96a32) in the same change that renames the class.`,
      );
      continue;
    }

    // Collapse the controller's routes into the DISTINCT postures they resolve
    // to, so a class-level miss reports one line rather than one per route,
    // while a method-level override that differs still gets its own line.
    const byPosture = new Map<string, { declared: string[]; forbidden: boolean; routes: RouteInfo[] }>();
    for (const route of routes) {
      const raw = reflector.getAllAndOverride<string[]>(SERVICE_ACCOUNT_REQUIRED_SCOPES, [route.methodRef, route.ControllerClass]);
      const declared = Array.isArray(raw) ? [...new Set(raw)].sort() : [];
      const forbidden = reflector.getAllAndOverride<boolean>(SERVICE_ACCOUNT_FORBIDDEN, [route.methodRef, route.ControllerClass]) === true;

      const key = `${forbidden ? 'forbidden' : 'open'}|${declared.join(',')}`;
      const bucket = byPosture.get(key);
      if (bucket) bucket.routes.push(route);
      else byPosture.set(key, { declared, forbidden, routes: [route] });
    }

    for (const { declared, forbidden, routes: affected } of byPosture.values()) {
      const correctScopes = declared.length === 1 && declared[0] === expected;
      if (correctScopes && !forbidden) continue;

      const where = `${row.controllerClass}.${affected[0].methodName} (${affected[0].fullPath})${affected.length > 1 ? ` and ${affected.length - 1} further route(s) on the same controller` : ''}`;

      if (declared.length === 0) {
        offenders.push(
          `${where} declares NO svc:* scope. TASK-757 removed this controller's @RequiredScopes('${row.adminScope}'); ` +
            `TASK-773 requires its machine twin @RequiredSvcScopes(toServiceAccountScope('${row.adminScope}')) — expected exactly ['${expected}'], found none. ` +
            `Without it the administration area is unreachable by every service account, because enforceServiceAccountScopes denies an undeclared route.`,
        );
        continue;
      }

      if (!correctScopes) {
        offenders.push(
          `${where} declares the WRONG svc:* scope — expected exactly ['${expected}'] (the twin of '${row.adminScope}', which TASK-757 removed from this controller), found [${declared.map((s) => `'${s}'`).join(', ')}]. ` +
            `A registry-known but mis-assigned scope passes assertion G and every runtime check while granting machine identities the reach of a DIFFERENT admin area; ` +
            `derive it as toServiceAccountScope('${row.adminScope}') rather than typing it.`,
        );
        continue;
      }

      offenders.push(
        `${where} declares @RequiredSvcScopes('${expected}') AND @ForbidServiceAccount(). ` +
          `These contradict: the fixture records this controller as a machine-reachable admin area, so it cannot also deny every machine token. ` +
          `If this area is genuinely machine-CLOSED (as ServiceAccountController, AdminImpersonationController and ConsentGrantController are, by owner decision D-3), ` +
          `remove its row from the fixture with that decision recorded — do not carry both decorators.`,
      );
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `TASK-773: refused to start — ${offenders.length} admin controller(s) do not declare the service-account scope the evidence fixture requires ` +
        `(${TASK_773_ADMIN_SCOPE_MAP.length} rows checked):\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    );
  }
}

/** Run every service-account boot audit. Called from `main.ts`. */
export function auditServiceAccountSurface(app: INestApplicationContext): void {
  auditNoAdminControllerUsesServiceTokenGuard(app);
  auditNoInternalControllerDeclaresSvcScopes(app);
  auditSvcScopeCoverage();
  auditServiceAccountControllerForbidsBothClasses(app);
  auditTokenExchangeRouteIsPublicAndGuarded(app);
  auditServiceAccountReachableRoutesAreDeclared(app);
  auditAdminControllersDeclareCorrectSvcScope(app);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function readGuardNames(target: unknown): string[] {
  const guards = Reflect.getMetadata(GUARDS_METADATA, target as object);
  if (!Array.isArray(guards)) return [];
  return guards
    .map((g: unknown) => (typeof g === 'function' ? (g as { name: string }).name : (g as object)?.constructor?.name))
    .filter(Boolean) as string[];
}

function readPath(target: unknown): string {
  const raw = Reflect.getMetadata(PATH_METADATA, target as object);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return '';
}

function normalizePath(path: string): string {
  if (!path) return '/';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

function joinPath(controllerPath: string, methodPath: string): string {
  const a = normalizePath(controllerPath).replace(/\/$/, '');
  const b = methodPath ? normalizePath(methodPath).replace(/\/$/, '') : '';
  return `${a}${b}` || '/';
}

function isAdminPath(controllerPath: string): boolean {
  return normalizePath(controllerPath).startsWith('/admin');
}

function isInternalPath(controllerPath: string): boolean {
  return normalizePath(controllerPath).startsWith('/internal');
}
