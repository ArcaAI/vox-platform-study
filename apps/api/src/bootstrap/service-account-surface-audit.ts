/**
 * Boot-time audits for the THIRD credential class
 *
 * The owner's non-mixing ruling ("we cannot mix the `/admin/*` and
 * `/internal/*` routes as they were designed for different purposes") is
 * currently satisfied by ACCIDENT OF IMPLEMENTATION rather than by an enforced
 * invariant — of the ticket verified that no `/admin/*` controller uses a
 * service-token guard, but nothing STOPS one from doing so tomorrow. These
 * audits make the ruling mechanical: the shortcut becomes a boot failure rather
 * than a code-review argument.
 *
 * Assertions implemented here (the letters are the table):
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
 * G — (strengthened by) every `admin/`-prefixed route declares
 *       either a `svc:*` scope or `@ForbidServiceAccount()`, and whatever it
 *       declares is self-consistent, registry-known and CASL-resolvable.
 *       Deny-by-default extended to the third class; mirrors
 *       `auditEveryApiKeyReachableRouteDeclaresScopes`. The business plane is
 *       deliberately exempt from the declaration requirement — see G's own
 *       header for where that boundary is drawn and why.
 * H — every controller stripped an `admin:<area>` scope
 *       from declares its `svc:admin:<area>` twin — and, on a method, at most
 *       that twin paired with its own `:read` sibling (decision O-3). Nothing
 *       else. G checks
 *       that a declared scope is well-formed and registry-known; it structurally
 *       CANNOT see a scope that is well-formed, registry-known and WRONG — the
 *       exact outcome of a 64-controller sweep applied by hand. H is the
 *       acceptance test for that sweep.
 *
 * Assertion A (no `admin/` controller declares `@RequiredScopes`) is
 * to add, once `@ForbidApiKey()` has actually been applied across the admin
 * plane — asserting it now would fail the boot on the 67 admin controllers that
 * legitimately still carry their `admin:*` scopes. It is deliberately NOT
 * implemented here; .
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
  AGENT_WORKFLOW_BUSINESS_PLANE_SVC_SCOPES,
  ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES,
  CONSULTATION_REALTIME_SVC_SCOPES,
  STANDALONE_FEATURE_SVC_SCOPES,
  resolveServiceAccountImpliedPermissions,
  serviceAccountPolicyRules,
  toServiceAccountScope,
} from '@arcaai/applications';

import './third-party-public-routes';
// The evidence fixture is EVIDENCE, not configuration: a mechanical
// transcription of the 64 class-level `@RequiredScopes('admin:<area>')`
// decorators commit 276f96a32 removed. Its own consistency test
// (`__tests__/task-773-admin-scope-map.test.ts`) proves every row still names a
// real class and a live registry scope; it is imported here rather than
// re-typed, because a second copy of the map in boot code is exactly the drift
// this audit exists to catch.
//
// It lives in `src/bootstrap/` and NOT under `__tests__/fixtures/`, where it
// started. `tsconfig.build.json` did compile it from there (its `__tests__`
// exclude only filters the ENTRY glob) — but `.dockerignore` strips
// `**/__tests__` from the image build context entirely, so the file simply did
// not exist in the container and `build-api` failed with TS2307 while every
// local build and every test passed. Boot code may not import out of a test
// directory; `no-production-imports-from-tests.test.ts` now enforces that.
import { TASK_773_ADMIN_SCOPE_MAP } from './task-773-admin-scope-map';

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
 * no revocation granularity. That is the specific shortcut exists as
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
          `The owner ruling forbids mixing the /admin/* and /internal/* mechanisms: the service token is ONE shared secret with ` +
          `no per-caller identity, scope or revocation, so granting it admin reach makes every peer service a platform administrator. ` +
          `Use a service account (/admin/service-accounts + @RequiredSvcScopes) instead.`,
      );
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `refused to start — ${offenders.length} admin controller(s) use a peer-service token guard:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
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
      `refused to start — ${offenders.length} internal route(s) declare a svc:* scope:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    );
  }
}

/**
 * Assertion D — no orphan scopes, no ungated admin areas, no ability-less scope.
 *
 * The registry DERIVES `svc:admin:<area>` from every concrete `admin:<area>`
 * scope, `svc:<feature>` from each named standalone business scope,
 * and ( / O-1) `svc:<area>` from each admin-plane area whose gating
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
 * The LAST check is addition and it pins a different failure
 * the one the seed note calls out. `hasServiceAccountScope` is pure
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
  // TASK-930 §3 — the fourth family (the agent/workflow business plane) is closed the same way.
  const missingBusinessPlane = AGENT_WORKFLOW_BUSINESS_PLANE_SVC_SCOPES.filter((s) => !SERVICE_ACCOUNT_SCOPE_REGISTRY[s]);
  // TASK-933 §3.1 — the fifth family (the realtime consultation plane) is closed the same way.
  const missingConsultationRealtime = CONSULTATION_REALTIME_SVC_SCOPES.filter((s) => !SERVICE_ACCOUNT_SCOPE_REGISTRY[s]);
  const declaredNonAdmin = new Set([
    ...STANDALONE_FEATURE_SVC_SCOPES,
    ...ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES,
    ...AGENT_WORKFLOW_BUSINESS_PLANE_SVC_SCOPES,
    ...CONSULTATION_REALTIME_SVC_SCOPES,
  ]);
  const unexpectedNonAdmin = svcNonAdminScopes.filter((s) => !declaredNonAdmin.has(s));
  const abilityless = Object.keys(SERVICE_ACCOUNT_SCOPE_REGISTRY).filter((s) => resolveServiceAccountImpliedPermissions(s).length === 0);

  const problems: string[] = [];
  if (uncovered.length > 0) problems.push(`admin areas with no svc:* scope: ${uncovered.join(', ')}`);
  if (orphans.length > 0) problems.push(`svc:admin:* scopes mapping to no live admin area: ${orphans.join(', ')}`);
  if (missingStandalone.length > 0) problems.push(`declared standalone-feature scopes missing from the registry: ${missingStandalone.join(', ')}`);
  if (missingPreConvention.length > 0)
    problems.push(`declared admin-plane pre-convention scopes missing from the registry: ${missingPreConvention.join(', ')}`);
  if (missingBusinessPlane.length > 0)
    problems.push(`declared agent/workflow business-plane scopes missing from the registry: ${missingBusinessPlane.join(', ')}`);
  if (missingConsultationRealtime.length > 0)
    problems.push(`declared realtime-consultation scopes missing from the registry: ${missingConsultationRealtime.join(', ')}`);
  if (unexpectedNonAdmin.length > 0)
    problems.push(
      `non-admin svc:* scopes declared in none of STANDALONE_FEATURE_SCOPE_SOURCES, ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES, ` +
        `AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES or CONSULTATION_REALTIME_SCOPE_SOURCES: ${unexpectedNonAdmin.join(', ')}. ` +
        `Add the source scope to the family it actually belongs to — standalone BUSINESS-plane features, an ADMIN-plane area whose gating scope ` +
        `predates the admin:<area> convention, the agent/workflow composition plane, or the realtime consultation plane — so the ability mapping ` +
        `is derived, never hand-written.`,
    );
  if (abilityless.length > 0)
    problems.push(
      `svc:* scopes that resolve to ZERO abilities: ${abilityless.join(', ')}. ` +
        `Such a scope passes the guard and is then refused by CASL — wire its implied permission or delete it.`,
    );

  if (problems.length > 0) {
    throw new Error(`refused to start — svc:* scope coverage is broken:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
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
      `refused to start — service-account issuance must exclude both other credential classes:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
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
    throw new Error('refused to start — the service-account token-exchange route (POST /auth/service-token) is not registered.');
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
    throw new Error(`refused to start — token-exchange route posture is wrong:\n${offenders.map((o) => `  - ${o}`).join('\n')}`);
  }
}

/**
 * Assertion G — deny-by-default on the admin plane, turned into an AUTHORING
 * error.
 *
 * `UnifiedAuthGuard.enforceServiceAccountScopes` already refuses an undeclared
 * route at request time. This turns that runtime refusal into a boot failure,
 * exactly as `auditEveryApiKeyReachableRouteDeclaresScopes` does for keys.
 *
 * ─── The invariant ──────────────────────────────────────────────────────────
 *
 *   Every `admin/`-prefixed route must declare EITHER a `svc:*` scope OR
 *   `@ForbidServiceAccount()`. Additionally, whatever it declares must be
 *   self-consistent: not both AT THE SAME LEVEL, only registry-known scopes,
 *   and — unit A5 — every declared scope must resolve through
 *   `serviceAccountPolicyRules` to at least one CASL ability.
 *
 * ─── "At the same level", and why it is not "at all" ────────────────────────
 *
 * This check originally rejected a scope and a `@ForbidServiceAccount()` on the
 * same ROUTE however they got there, because it read both keys through
 * `getAllAndOverride` and so could not see where each came from. That flattening
 * made one legitimate and useful shape unexpressible:
 *
 *   @RequiredSvcScopes('svc:admin:workflow-run:read') // on the CLASS
 *   class WorkflowRunController {
 *     @ForbidServiceAccount() // on ONE method
 *     approveRunGate() {} // "…except this one"
 *   }
 *
 * That is an OVERRIDE, not a conflict, and it is exactly what the runtime does:
 * `UnifiedAuthGuard` resolves FORBIDDEN with `getAllAndOverride([handler,
 * class])` — method first — and checks it BEFORE the scope gate, so the route is
 * closed to machines while its siblings stay open. Refusing the shape forced a
 * controller to be all-or-nothing for the machine class, which is wrong for
 * precisely the routes most worth closing: a single mutation on an otherwise
 * readable admin area (`approveRunGate` signs clinical content).
 *
 * So the audit now reads each key at BOTH levels and flags only a level that
 * declares both — which no resolution order can reconcile — while computing the
 * EFFECTIVE posture the same way the guard does. This is strictly more precise
 * than the old rule, not weaker: every same-level contradiction it used to catch
 * still fails the boot.
 *
 * ─── Where the admin/business boundary is drawn, and why ────────────────────
 *
 * This function's earlier `NOTE ON SCOPE` deferred the every-route form to
 * " admin-plane cutover, when `svc:*` declarations actually land".
 * They have now landed (assertion H), so the note is gone — but its REASONING
 * still decides the boundary, and the boundary is CHOSEN, not overlooked:
 *
 * **Admin plane — declaration required.** deliberately changed the
 *     default here: 64 controllers went from machine-unreachable to
 *     machine-reachable in one sweep. Silence on an admin route is therefore
 *     AMBIGUOUS — it could be a controller the sweep missed (which should be
 *     open, and is currently broken for every integrator) or a surface someone
 *     means to keep closed (which should say so). Only the author knows, so the
 *     boot demands the answer.
 *   - **Business plane — exempt, still deny-by-default.** Its default never
 *     changed. Silence there is UNAMBIGUOUS: the runtime denies every machine
 *     token already, so requiring `@ForbidServiceAccount()` on hundreds of
 *     consultation/user/streaming routes would fail the boot "for no security
 *     benefit" while adding a decorator that restates the default. The handful
 * of business routes opened say so explicitly with
 *     `@RequiredSvcScopes`, and every rule below except the missing-declaration
 *     one still applies to them.
 *
 * A `@Public()` admin route is skipped for the same reason the API-key audit
 * skips one: `UnifiedAuthGuard` returns before it ever reaches the machine
 * path, so no declaration could change its behaviour.
 *
 * ─── Why A5 lives HERE rather than in its own assertion ─────────────────────
 *
 * A5 asks a question about a ROUTE'S DECLARATION — the same subject, resolved
 * from the same `Reflector` read, in the same walk. A sibling assertion would
 * duplicate the walk to add one predicate, and would split "what is wrong with
 * this route's `svc:*` declaration?" across two boot failures. Assertion D asks
 * the same question of the REGISTRY and is separate precisely because it needs
 * no app at all.
 *
 * Honesty about what A5 catches TODAY: D proves no registry entry is
 * ability-less, and the unknown-scope check below proves every declared scope
 * is a registry entry, so A5 cannot currently fail on its own. Its value is
 * that it does not DEPEND on those two holding — narrow D with an exemption
 * list, or let a route declare a scope some other way, and A5 is what still
 * stands between an integrator and the failure mode (a credential that
 * passes the string-matching scope gate and is then 403'd by CASL, which is the
 * worst possible failure to debug). It also fails with the ROUTE's name, which
 * is what the person debugging that 403 is actually holding.
 *
 * Note the check is `every` declared scope, not `some`: `enforceServiceAccountScopes`
 * accepts a caller holding ANY ONE of the listed scopes (OR semantics), so each
 * one is independently sufficient to reach the route — and therefore each one
 * independently has to carry the abilities the route's `@CanXxx` decorators ask
 * for.
 */
export function auditServiceAccountReachableRoutesAreDeclared(app: INestApplicationContext): void {
  const reflector = app.get(Reflector);
  const offenders: string[] = [];

  for (const route of walkRoutes(app)) {
    // An EMPTY array is not a declaration: `enforceServiceAccountScopes` denies
    // on `required.length === 0` exactly as it does on absent metadata, so a
    // zero-arg `@RequiredSvcScopes()` typo must read as undeclared here too.
    // Read each key at BOTH levels rather than flattening with
    // `getAllAndOverride`, because the contradiction rule below has to tell an
    // OVERRIDE from a genuine conflict and a flattened read cannot. Assertion H
    // reads origin the same way and for the same reason.
    const methodScopesRaw = Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, route.methodRef) as unknown;
    const classScopesRaw = Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, route.ControllerClass) as unknown;
    const methodScopes = Array.isArray(methodScopesRaw) ? (methodScopesRaw as string[]) : undefined;
    const classScopes = Array.isArray(classScopesRaw) ? (classScopesRaw as string[]) : undefined;
    const methodForbid = Reflect.getMetadata(SERVICE_ACCOUNT_FORBIDDEN, route.methodRef) === true;
    const classForbid = Reflect.getMetadata(SERVICE_ACCOUNT_FORBIDDEN, route.ControllerClass) === true;

    // A single level declaring BOTH is incoherent — it says "machines may reach
    // this, using these scopes" and "no machine may reach this" in one breath,
    // and no resolution order can make sense of it. Checked per level, before
    // the effective posture is computed, so the offender names the level.
    const sameLevelConflict = (methodScopes && methodScopes.length > 0 && methodForbid) || (classScopes && classScopes.length > 0 && classForbid);
    if (sameLevelConflict) {
      const level = methodScopes && methodScopes.length > 0 && methodForbid ? 'the METHOD' : 'the CONTROLLER CLASS';
      const conflicting = methodScopes && methodScopes.length > 0 && methodForbid ? methodScopes : classScopes!;
      offenders.push(
        `${route.ControllerClass.name}.${route.methodName} (${route.fullPath}) declares @RequiredSvcScopes(${conflicting.join(', ')}) AND ` +
          `@ForbidServiceAccount() on ${level}. These contradict at the same level: the route advertises itself as machine-reachable while ` +
          `denying every machine token, and no resolution order can reconcile them. Remove one. (Declaring them at DIFFERENT levels is legal and ` +
          `means something else — see below.)`,
      );
      continue;
    }

    // Effective posture, mirroring `getAllAndOverride`'s first-defined-wins —
    // which is exactly what `UnifiedAuthGuard` resolves at request time, per key
    // and independently. A method-level `@ForbidServiceAccount()` over a
    // class-level scope is therefore a real, working OVERRIDE: "this controller
    // is machine-reachable EXCEPT this route". The guard honours it (it checks
    // FORBIDDEN before the scope gate, and resolves it method-first), so the
    // audit must too. Refusing that shape — as this assertion originally did —
    // forced a controller to be all-or-nothing for the machine class, which is
    // wrong for exactly the routes most worth closing: a single mutation on an
    // otherwise readable admin area.
    const forbidden = methodForbid || classForbid;
    const scopes = methodScopes ?? classScopes ?? [];

    if (scopes.length === 0 || forbidden) {
      if (forbidden) continue; // an explicit, deliberate "never"
      if (!isAdminPath(route.controllerPath)) continue; // business plane — implicit deny-by-default, see header
      if (isPublicRoute(reflector, route)) continue; // the guard returns before the machine path

      offenders.push(
        `${route.ControllerClass.name}.${route.methodName} (${route.fullPath}) declares nothing about service-account access. ` +
          `Since  the admin plane is the machine class's plane, so silence here is ambiguous rather than safe: this route currently ` +
          `REFUSES every service account at runtime (enforceServiceAccountScopes denies an undeclared route), which is either a gap the sweep ` +
          `missed or a deliberate closure nobody wrote down. Add @RequiredSvcScopes(toServiceAccountScope('admin:<area>')) if a machine identity ` +
          `legitimately administers this area, or @ForbidServiceAccount() if it is a human-only surface (record the decision in the comment, ` +
          `as MonitoringController does).`,
      );
      continue;
    }

    const unknown = scopes.filter((s) => !SERVICE_ACCOUNT_SCOPE_REGISTRY[s]);
    if (unknown.length > 0) {
      offenders.push(`${route.ControllerClass.name}.${route.methodName} (${route.fullPath}) declares unknown svc:* scope(s): ${unknown.join(', ')}`);
      continue;
    }

    // A5 — the per-ROUTE form of assertion D's registry-wide ability check.
    const abilityless = scopes.filter((s) => serviceAccountPolicyRules([s]).length === 0);
    if (abilityless.length > 0) {
      offenders.push(
        `${route.ControllerClass.name}.${route.methodName} (${route.fullPath}) declares svc:* scope(s) that resolve to ZERO CASL abilities: ${abilityless.join(', ')}. ` +
          `Any ONE declared scope is sufficient to pass enforceServiceAccountScopes (OR semantics), but abilities are built from the caller's ` +
          `scopes via serviceAccountPolicyRules — so a holder of this scope alone would clear the scope gate and then be refused by ` +
          `enforceServiceAccountAbilities on this route's @CanXxx declaration. Wire the scope's implied permission in its source registry entry, ` +
          `or declare a scope that carries one.`,
      );
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `refused to start — ${offenders.length} service-account route declaration(s) are missing or inconsistent:\n${offenders.map((o) => `  - ${o}`).join('\n')}`,
    );
  }
}

/**
 * Assertion H — the admin plane's machine declaration is COMPLETE
 * and CORRECT, row by row against the evidence fixture.
 *
 * swept one class-level `@RequiredScopes('admin:<area>')` off each of
 * 64 admin controllers, leaving them JWT-only. puts the machine
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
 *      a `svc:*` declaration that is one of exactly two permitted shapes.
 *      Not empty (the sweep missed it — the route is machine-unreachable), not
 *      a different twin (mis-assigned), and not an arbitrary superset.
 *   3. It does not simultaneously carry `@ForbidServiceAccount()`.
 *
 * ─── The two permitted shapes (widened by decision O-3, 2026-08-19) ─────────
 *
 *   a. `[svc:admin:<area>]` — the twin, alone. Permitted wherever the
 *      declaration comes from, and the ONLY shape permitted at CLASS level.
 *   b. `[svc:admin:<area>:read, svc:admin:<area>:write]` — the twin paired with
 *      its own `:read` sibling, and ONLY when the declaration comes from a
 *      METHOD. This is what makes a read-only grant reach a controller's GET
 *      routes: `enforceServiceAccountScopes` is `required.some(...)`, so
 *      declaring the `:read` scope ALONE would have revoked those routes from
 *      every existing `:write` holder, while the pair leaves `:write` reaching
 *      exactly what it reached before.
 *
 * Shape (b) is DERIVED, never listed: the sibling is this row's own twin with
 * its trailing `:write` swapped for `:read`, and it must already exist in
 * `SERVICE_ACCOUNT_SCOPE_REGISTRY`. A row whose twin has no `:read` sibling
 * (`admin:department:manage`, `admin:audit:read`, …) therefore has shape (a)
 * and nothing else — the widening cannot leak into an area with no read half
 * to express.
 *
 * Three things this deliberately does NOT become:
 *
 *   - **Not "any superset".** `[twin, svc:admin:tenant:write]` is still a boot
 *     failure. H exists to catch a mis-assignment, and "the twin plus anything"
 *     gives that up: a copy-pasted second scope would sail through while
 *     granting a different area's reach.
 *   - **Not "the pair anywhere".** At CLASS level the pair would put `:read` on
 *     the DELETE routes too, so a read-only token could mutate — the exact
 *     inversion of the least-privilege decision that motivated O-3. Origin is
 *     therefore read straight off the handler (`Reflect.getMetadata` on
 *     `methodRef`, no override walk) rather than inferred.
 *   - **Not "read is free".** Whether the `:read` scope's implied CASL ability
 *     actually satisfies the route's `@CanXxx` is a separate question this
 *     audit does not answer (G/A5 does, per declared scope). Two of the four
 *     O-3 candidates fail it and were deliberately left alone; see the ticket.
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
    // Shape (b), pre-sorted so the comparison below is an exact element-wise
    // match rather than a set-containment test. `undefined` for every area
    // whose twin has no registry-known `:read` sibling, which collapses the
    // permitted set back to shape (a) alone.
    const readSibling = readSiblingOf(expected);
    const permittedPair = readSibling ? [readSibling, expected].sort() : undefined;
    const routes = routesByClassName.get(row.controllerClass);

    if (!routes || routes.length === 0) {
      // A CONDITIONALLY-registered controller is absent by configuration, not by
      // regression. Treating that as an offender made this audit refuse to start
      // on every host running the default configuration — `PrismaStudioModule`
      // is imported only under `ENABLE_PRISMA_STUDIO=true`, so a production boot
      // died inside this very arm. An audit that fails on the default config is
      // a boot failure the audit INTRODUCED rather than one it caught.
      //
      // The declaration is still fully checked whenever the class IS registered
      // (this arm is the only thing skipped), so a mis-scoped route cannot hide
      // behind the flag — it simply has to be switched on to be seen, which is
      // also the only configuration in which it is reachable.
      if (row.conditionallyRegistered) continue;

      offenders.push(
        `${row.controllerClass} (${row.file}) is named by the  evidence fixture but is not registered by any module — ` +
          `no route was found for it. A rename or deletion silently REMOVES an admin area from this audit's coverage, so it fails the boot: ` +
          `update the fixture (and re-verify it against commit 276f96a32) in the same change that renames the class. ` +
          `If the class is instead registered CONDITIONALLY, record that on its fixture row via \`conditionallyRegistered\` rather than deleting the row.`,
      );
      continue;
    }

    // Collapse the controller's routes into the DISTINCT postures they resolve
    // to, so a class-level miss reports one line rather than one per route,
    // while a method-level override that differs still gets its own line.
    const byPosture = new Map<string, { declared: string[]; methodLevel: boolean; forbidden: boolean; methodForbid: boolean; routes: RouteInfo[] }>();
    for (const route of routes) {
      const raw = reflector.getAllAndOverride<string[]>(SERVICE_ACCOUNT_REQUIRED_SCOPES, [route.methodRef, route.ControllerClass]);
      const declared = Array.isArray(raw) ? [...new Set(raw)].sort() : [];
      // WHERE the declaration came from, read straight off the handler with no
      // override walk: `getAllAndOverride` above deliberately cannot tell a
      // method-level declaration from an inherited class-level one, and shape
      // (b) is permitted on a method ONLY.
      const methodLevel = Array.isArray(Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, route.methodRef));
      const forbidden = reflector.getAllAndOverride<boolean>(SERVICE_ACCOUNT_FORBIDDEN, [route.methodRef, route.ControllerClass]) === true;
      // Forbid ORIGIN, for the same reason the scope origin is read above. A
      // method-level `@ForbidServiceAccount()` OVERRIDES the class twin —
      // "machine-reachable except this route" — which the runtime honours and
      // assertion G permits. Only a CLASS declaring both is irreconcilable.
      const methodForbid = Reflect.getMetadata(SERVICE_ACCOUNT_FORBIDDEN, route.methodRef) === true;

      const key = `${forbidden ? 'forbidden' : 'open'}|${methodForbid ? 'm' : 'c'}|${methodLevel ? 'method' : 'class'}|${declared.join(',')}`;
      const bucket = byPosture.get(key);
      if (bucket) bucket.routes.push(route);
      else byPosture.set(key, { declared, methodLevel, forbidden, methodForbid, routes: [route] });
    }

    for (const { declared, methodLevel, forbidden, methodForbid, routes: affected } of byPosture.values()) {
      const isTwinAlone = declared.length === 1 && declared[0] === expected;
      const isPermittedPair =
        methodLevel &&
        permittedPair !== undefined &&
        declared.length === permittedPair.length &&
        declared.every((scope, index) => scope === permittedPair[index]);
      const correctScopes = isTwinAlone || isPermittedPair;
      // A METHOD-level forbid over a correct class twin is a deliberate,
      // working closure of one route, not a defect — see the note at
      // `methodForbid` above. A CLASS-level one alongside the twin still falls
      // through to the contradiction arm below.
      if (correctScopes && (!forbidden || methodForbid)) continue;

      const where = `${row.controllerClass}.${affected[0].methodName} (${affected[0].fullPath})${affected.length > 1 ? ` and ${affected.length - 1} further route(s) on the same controller` : ''}`;

      if (declared.length === 0) {
        offenders.push(
          `${where} declares NO svc:* scope.  removed this controller's @RequiredScopes('${row.adminScope}'); ` +
            ` requires its machine twin @RequiredSvcScopes(toServiceAccountScope('${row.adminScope}')) — expected exactly ['${expected}'], found none. ` +
            `Without it the administration area is unreachable by every service account, because enforceServiceAccountScopes denies an undeclared route.`,
        );
        continue;
      }

      if (!correctScopes) {
        const permitted = permittedPair
          ? `either exactly ['${expected}'] or — on a METHOD only — exactly ['${permittedPair.join("', '")}'] (the twin paired with its own :read sibling, decision O-3)`
          : `exactly ['${expected}']`;
        const pairHint = permittedPair
          ? ` The pair is permitted on a METHOD only: at class level it would put '${permittedPair[0]}' on this controller's writes too, so a read-only token could mutate.`
          : '';
        offenders.push(
          `${where} declares the WRONG svc:* scope — expected ${permitted} (the twin of '${row.adminScope}', which removed from this controller), found [${declared.map((s) => `'${s}'`).join(', ')}] at the ${methodLevel ? 'method' : 'class'} level. ` +
            `A registry-known but mis-assigned scope passes assertion G and every runtime check while granting machine identities the reach of a DIFFERENT admin area; ` +
            `derive it as toServiceAccountScope('${row.adminScope}') rather than typing it.${pairHint}`,
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
      `refused to start — ${offenders.length} admin controller(s) do not declare the service-account scope the evidence fixture requires ` +
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

/**
 * `@Public()` under both spellings the guard accepts (`SKIP_AUTH_KEY` and the
 * legacy `'isPublic'` string key), read in the guard's own override order.
 */
function isPublicRoute(reflector: Reflector, route: RouteInfo): boolean {
  return (
    reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [route.methodRef, route.ControllerClass]) === true ||
    reflector.getAllAndOverride<boolean>('isPublic', [route.methodRef, route.ControllerClass]) === true
  );
}

/**
 * The `:read` sibling of an area's `:write` twin — `svc:admin:apikey:write` →
 * `svc:admin:apikey:read` — or `undefined` when there is none.
 *
 * Registry membership is the gate, not string arithmetic: an area whose scopes
 * are `:manage` (or already `:read`) has no read half to pair with, so it keeps
 * the single permitted shape. Returning a string the registry does not know
 * would let assertion H bless a declaration `@RequiredSvcScopes` itself refuses
 * at decoration time.
 */
function readSiblingOf(twin: string): string | undefined {
  const suffix = ':write';
  if (!twin.endsWith(suffix)) return undefined;
  const sibling = `${twin.slice(0, -suffix.length)}:read`;
  return SERVICE_ACCOUNT_SCOPE_REGISTRY[sibling] ? sibling : undefined;
}

function isAdminPath(controllerPath: string): boolean {
  return normalizePath(controllerPath).startsWith('/admin');
}

function isInternalPath(controllerPath: string): boolean {
  return normalizePath(controllerPath).startsWith('/internal');
}
