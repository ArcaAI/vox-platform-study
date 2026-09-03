/**
 * the boot audits for the third credential class.
 *
 * Each assertion is proved twice: it THROWS on a synthetic violating module,
 * and it PASSES on the real controllers. A boot audit that has never been seen
 * to fail proves nothing — and assertion B in particular passes VACUOUSLY today
 * (no admin controller uses a service-token guard), so the synthetic
 * violation is the only evidence that it would catch one.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { Controller, Get, Injectable, Post, UseGuards } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import {
  ForbidApiKey,
  ForbidServiceAccount,
  Public,
  RequiredSvcScopes,
  SERVICE_ACCOUNT_FORBIDDEN,
  SERVICE_ACCOUNT_SCOPE_REGISTRY,
  ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES,
  STANDALONE_FEATURE_SVC_SCOPES,
  resolveServiceAccountImpliedPermissions,
  toServiceAccountScope,
} from '@arcaai/applications';

import {
  auditAdminControllersDeclareCorrectSvcScope,
  auditNoAdminControllerUsesServiceTokenGuard,
  auditNoInternalControllerDeclaresSvcScopes,
  auditServiceAccountControllerForbidsBothClasses,
  auditServiceAccountReachableRoutesAreDeclared,
  auditSvcScopeCoverage,
  auditTokenExchangeRouteIsPublicAndGuarded,
} from '../service-account-surface-audit';
import { TASK_773_ADMIN_SCOPE_MAP, type AdminScopeMapRow } from '../task-773-admin-scope-map';
import { ServiceAccountController } from '../../modules/service-account/service-account.controller';
import { ServiceAccountTokenController } from '../../modules/service-account/service-account-token.controller';
// The six admin-prefixed controllers deliberately absent from the fixture —
// imported REAL, so this test breaks if one is later given a svc:* scope
// without a fixture row (or a fixture row without the decorator).
import { WebhookController } from '../../modules/webhook/webhook.controller';
import { MonitoringController } from '../../modules/monitoring/monitoring.controller';
import { AdminHealthServicesController } from '../../modules/health/admin-health-services.controller';
import { AdminImpersonationController } from '../../modules/auth/admin-impersonation.controller';
import { ConsentGrantController } from '../../modules/consent/consent.controller';

/** Same shortcut the sibling audit tests use: real metadata, no DI graph. */
function fakeApp(controllers: Array<new (...args: never[]) => unknown>) {
  const wrappers = controllers.map((ControllerClass) => ({
    metatype: ControllerClass,
    instance: Object.create(ControllerClass.prototype),
  }));
  const modulesContainer = new Map([['synthetic', { controllers: new Map(wrappers.map((w, i) => [String(i), w])) }]]);
  const reflector = new Reflector();

  return {
    get(token: unknown) {
      if (token === ModulesContainer) return modulesContainer;
      if (token === Reflector) return reflector;
      throw new Error('unexpected token');
    },
  } as never;
}

// The real guard classes are matched BY NAME, so a stand-in with the same name
// is indistinguishable to the audit — which is the point: the audit must catch
// the pattern, not one specific import.
@Injectable()
class InternalServiceTokenGuard implements CanActivate {
  canActivate() {
    return true;
  }
}

describe('B — no admin controller may use a peer-service token guard', () => {
  it('THROWS on an admin controller that reaches for the service token', () => {
    @Controller('admin/shortcut')
    @UseGuards(InternalServiceTokenGuard)
    class OffendingAdminController {
      @Get()
      list() {}
    }

    expect(() => auditNoAdminControllerUsesServiceTokenGuard(fakeApp([OffendingAdminController]))).toThrow(/owner ruling forbids mixing/);
  });

  it('THROWS when the guard is applied at the METHOD level rather than the class', () => {
    @Controller('admin/shortcut')
    class MethodOffender {
      @Get()
      @UseGuards(InternalServiceTokenGuard)
      list() {}
    }

    expect(() => auditNoAdminControllerUsesServiceTokenGuard(fakeApp([MethodOffender]))).toThrow(/refused to start/);
  });

  it('passes for an admin controller with no service-token guard (the real posture)', () => {
    expect(() => auditNoAdminControllerUsesServiceTokenGuard(fakeApp([ServiceAccountController]))).not.toThrow();
  });

  it('does NOT object to a service-token guard on an /internal/* controller — that is its correct home', () => {
    @Controller('internal/peer')
    @UseGuards(InternalServiceTokenGuard)
    class LegitimateInternalController {
      @Post()
      callback() {}
    }

    expect(() => auditNoAdminControllerUsesServiceTokenGuard(fakeApp([LegitimateInternalController]))).not.toThrow();
  });
});

describe('C — no internal route may declare a svc:* scope', () => {
  it('THROWS on an internal controller declaring one', () => {
    @Controller('internal/leaky')
    class LeakyInternalController {
      @Post()
      @RequiredSvcScopes('svc:admin:department:manage')
      handle() {}
    }

    expect(() => auditNoInternalControllerDeclaresSvcScopes(fakeApp([LeakyInternalController]))).toThrow(
      /svc:\* namespace belongs to the \/admin\/\* plane/,
    );
  });

  it('passes for an internal controller with no svc:* declaration', () => {
    @Controller('internal/peer')
    class CleanInternalController {
      @Post()
      handle() {}
    }

    expect(() => auditNoInternalControllerDeclaresSvcScopes(fakeApp([CleanInternalController]))).not.toThrow();
  });
});

describe('D — svc:* scope coverage', () => {
  it('passes against the real registries (coverage holds by construction)', () => {
    expect(() => auditSvcScopeCoverage()).not.toThrow();
  });

  // widened D from "admin coverage" to three checks; (O-1)
  // added the pre-convention family as a SECOND non-admin source list, each
  // reconciled against its own constant so an undeclared scope names the family
  // it should have joined. The registry derives everything, so none of these can
  // be provoked without mutating it — assert the properties D now depends on
  // instead, so a future hand-added entry that breaks one is caught here as well
  // as at boot.
  it('the non-admin svc: scopes are exactly the two declared source families', () => {
    const nonAdmin = Object.keys(SERVICE_ACCOUNT_SCOPE_REGISTRY)
      .filter((s) => !s.endsWith(':*') && !s.startsWith('svc:admin:'))
      .sort();
    expect(nonAdmin).toEqual([...STANDALONE_FEATURE_SVC_SCOPES, ...ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES].sort());
  });

  it('the two non-admin families are disjoint — every scope has exactly one justification', () => {
    for (const scope of ADMIN_PLANE_PRE_CONVENTION_SVC_SCOPES) {
      expect(STANDALONE_FEATURE_SVC_SCOPES).not.toContain(scope);
    }
  });

  it('no registry scope — wildcards included — resolves to zero abilities', () => {
    for (const scope of Object.keys(SERVICE_ACCOUNT_SCOPE_REGISTRY)) {
      expect(resolveServiceAccountImpliedPermissions(scope).length, `${scope} would pass the guard and be denied by CASL`).toBeGreaterThan(0);
    }
  });
});

describe('E — machine-identity issuance excludes both other credential classes', () => {
  it('passes for the real ServiceAccountController', () => {
    expect(() => auditServiceAccountControllerForbidsBothClasses(fakeApp([ServiceAccountController]))).not.toThrow();
  });

  it('THROWS when @ForbidServiceAccount() is missing — self-replication would be possible', () => {
    @Controller('admin/service-accounts')
    @ForbidApiKey()
    class HalfGuarded {
      @Post()
      create() {}
    }

    expect(() => auditServiceAccountControllerForbidsBothClasses(fakeApp([HalfGuarded]))).toThrow(/@ForbidServiceAccount\(\)/);
  });

  it('THROWS when @ForbidApiKey() is missing — a key path into machine issuance', () => {
    @Controller('admin/service-accounts')
    @ForbidServiceAccount()
    class OtherHalfGuarded {
      @Post()
      create() {}
    }

    expect(() => auditServiceAccountControllerForbidsBothClasses(fakeApp([OtherHalfGuarded]))).toThrow(/@ForbidApiKey\(\)/);
  });
});

describe('F — the token-exchange route is public AND guarded', () => {
  it('passes for the real ServiceAccountTokenController', () => {
    expect(() => auditTokenExchangeRouteIsPublicAndGuarded(fakeApp([ServiceAccountTokenController]))).not.toThrow();
  });

  it('THROWS when the route is public but UNGUARDED', () => {
    @Controller('auth')
    class UnguardedExchange {
      @Post('service-token')
      @Public()
      exchange() {}
    }

    expect(() => auditTokenExchangeRouteIsPublicAndGuarded(fakeApp([UnguardedExchange]))).toThrow(/public must never mean unguarded/);
  });

  it('THROWS when the route is missing entirely', () => {
    @Controller('auth')
    class NoExchange {
      @Post('login')
      login() {}
    }

    expect(() => auditTokenExchangeRouteIsPublicAndGuarded(fakeApp([NoExchange]))).toThrow(/is not registered/);
  });
});

describe('G — svc:* route declarations are self-consistent', () => {
  it('THROWS when the METHOD declares both a svc:* scope and @ForbidServiceAccount()', () => {
    @Controller('admin/contradiction')
    class Contradiction {
      @Get()
      @RequiredSvcScopes('svc:admin:department:manage')
      @ForbidServiceAccount()
      list() {}
    }

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([Contradiction]))).toThrow(/contradict at the same level/);
    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([Contradiction]))).toThrow(/on the METHOD/);
  });

  it('THROWS when the CONTROLLER CLASS declares both', () => {
    @Controller('admin/class-contradiction')
    @RequiredSvcScopes('svc:admin:department:manage')
    @ForbidServiceAccount()
    class ClassContradiction {
      @Get()
      list() {}
    }

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([ClassContradiction]))).toThrow(/contradict at the same level/);
    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([ClassContradiction]))).toThrow(/on the CONTROLLER CLASS/);
  });

  it('PASSES when a method-level @ForbidServiceAccount() overrides a class-level scope', () => {
    // The shape the old flattened rule could not express: "this controller is
    // machine-reachable EXCEPT this route". The runtime honours it —
    // UnifiedAuthGuard resolves FORBIDDEN method-first and checks it before the
    // scope gate — so the audit must not refuse it. Real instance:
    // WorkflowRunController.approveRunGate, which signs clinical content.
    @Controller('admin/workflow-runs')
    @RequiredSvcScopes('svc:admin:workflow-run:read')
    class PartiallyClosed {
      @Get()
      list() {}

      @Post(':id/approve')
      @ForbidServiceAccount()
      approve() {}
    }

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([PartiallyClosed]))).not.toThrow();
  });

  it('PASSES when a method-level scope opts back in under a class-level forbid', () => {
    // The mirror image, legal for the same reason: the class closes the surface
    // and one route re-opens it. Also an override, also resolvable.
    @Controller('admin/mostly-closed')
    @ForbidServiceAccount()
    class MostlyClosed {
      @Get()
      list() {}

      @Get('open')
      @RequiredSvcScopes('svc:admin:department:manage')
      open() {}
    }

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([MostlyClosed]))).not.toThrow();
  });

  it('passes for a well-formed machine-reachable route', () => {
    @Controller('admin/departments')
    class WellFormed {
      @Get()
      @RequiredSvcScopes('svc:admin:department:manage')
      list() {}
    }

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([WellFormed]))).not.toThrow();
  });

  it('passes for the real credential-issuance controllers', () => {
    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([ServiceAccountController, ServiceAccountTokenController]))).not.toThrow();
  });
});

// ─── G, strengthened ───────────────────────────────

describe('G (A3) — every admin-plane route declares its machine posture', () => {
  it('THROWS on an admin route that declares NEITHER a svc:* scope nor @ForbidServiceAccount()', () => {
    @Controller('admin/undeclared')
    class UndeclaredAdmin {
      @Get()
      list() {}
    }

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([UndeclaredAdmin]))).toThrow(/declares nothing about service-account access/);
  });

  it('passes when the admin route declares a svc:* scope (OPEN)', () => {
    @Controller('admin/departments')
    @RequiredSvcScopes('svc:admin:department:manage')
    class OpenAdmin {
      @Get()
      list() {}
    }

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([OpenAdmin]))).not.toThrow();
  });

  it('passes when the admin route declares @ForbidServiceAccount() (CLOSED)', () => {
    @Controller('admin/closed')
    @ForbidServiceAccount()
    class ClosedAdmin {
      @Get()
      list() {}
    }

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([ClosedAdmin]))).not.toThrow();
  });

  it('treats an EMPTY @RequiredSvcScopes() as no declaration — the guard does', () => {
    // `enforceServiceAccountScopes` denies on `required.length === 0` exactly as
    // it does on absent metadata, so a zero-arg typo must not read as declared.
    @Controller('admin/typo')
    class EmptyDeclaration {
      @Get()
      list() {}
    }
    RequiredSvcScopes()(EmptyDeclaration);

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([EmptyDeclaration]))).toThrow(/declares nothing about service-account access/);
  });

  it('does NOT fail a BUSINESS-plane route that declares neither — this is the chosen boundary', () => {
    // The business plane keeps relying on implicit deny-by-default: the runtime
    // already refuses every machine token there, so demanding an explicit
    // @ForbidServiceAccount() on hundreds of routes would buy no security. The
    // admin plane is different only because deliberately changed its
    // default, which makes silence there ambiguous rather than safe.
    @Controller('consultations')
    class BusinessPlane {
      @Get()
      list() {}
    }

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([BusinessPlane]))).not.toThrow();
  });

  it('does NOT fail a @Public() admin route — the guard returns before the machine path', () => {
    @Controller('admin/public-thing')
    class PublicAdmin {
      @Get()
      @Public()
      list() {}
    }

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([PublicAdmin]))).not.toThrow();
  });

  it('passes for the whole swept admin plane plus the six controllers absent from the fixture', () => {
    // The real-tree proof at unit scale: every fixture row declares its twin,
    // and all six non-fixture admin controllers — including the two that owner
    // decision D-3 requires be machine-CLOSED — carry a posture of their own.
    const absent = [
      WebhookController,
      MonitoringController,
      AdminHealthServicesController,
      ServiceAccountController,
      AdminImpersonationController,
      ConsentGrantController,
    ] as unknown as Array<new (...args: never[]) => unknown>;

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([...sweptAdminPlane(), ...absent]))).not.toThrow();
  });

  it('D-3: AdminImpersonationController and ConsentGrantController are machine-CLOSED', () => {
    // Asserted on the REAL classes, through the same Reflector override order
    // the guard uses — the decorator, not a comment, is what closes them.
    const reflector = new Reflector();
    for (const Closed of [AdminImpersonationController, ConsentGrantController]) {
      expect(reflector.get<boolean>(SERVICE_ACCOUNT_FORBIDDEN, Closed), `${Closed.name} must carry @ForbidServiceAccount()`).toBe(true);
    }
  });
});

describe('G (A5) — every scope a route declares resolves to at least one CASL ability', () => {
  const ABILITYLESS = 'svc:admin:task-773-abilityless-probe';

  /**
   * The trap cannot be reached through the real registry — assertion D already
   * proves no registry entry is ability-less — so the probe injects one. That
   * is the point of A5: it is the check that stays true if D's registry-wide
   * claim is ever narrowed, and it names the ROUTE rather than the registry row.
   */
  beforeEach(() => {
    SERVICE_ACCOUNT_SCOPE_REGISTRY[ABILITYLESS] = { description: 'probe', category: 'Admin', implies: [] };
  });
  afterEach(() => {
    delete SERVICE_ACCOUNT_SCOPE_REGISTRY[ABILITYLESS];
  });

  it('THROWS on a route declaring a registry-known scope that yields NO abilities', () => {
    @Controller('admin/probe')
    class AbilitylessRoute {
      @Get()
      list() {}
    }
    RequiredSvcScopes(ABILITYLESS)(AbilitylessRoute);

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([AbilitylessRoute]))).toThrow(/resolve to ZERO CASL abilities/);
  });

  it('THROWS even when ANOTHER declared scope on the same route does resolve — OR semantics make each one sufficient', () => {
    @Controller('admin/probe')
    class MixedRoute {
      @Get()
      list() {}
    }
    RequiredSvcScopes('svc:admin:department:manage', ABILITYLESS)(MixedRoute);

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([MixedRoute]))).toThrow(/resolve to ZERO CASL abilities/);
  });

  it('passes for every scope the swept admin plane actually declares', () => {
    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp(sweptAdminPlane()))).not.toThrow();
  });
});

// ─── H ───────────────────────────────────────────────────────────

/**
 * The synthetic module set for H is built FROM the fixture rather than from a
 * handful of hand-picked controllers, because H's whole subject IS the fixture:
 * a test that only ever exercised two rows would not notice the audit silently
 * skipping the other 62.
 *
 * Each synthetic controller extends one decorated base — so it carries real
 * `@Controller`/`@Get` metadata through the prototype chain, which is what
 * `walkRoutes` and `Reflector` read — and is given the fixture row's class
 * NAME, the key the audit joins on. The `svc:*` declaration is applied with the
 * REAL `RequiredSvcScopes` decorator, including its decoration-time registry
 * validation; metadata is never written by hand here.
 */
@Controller('admin/synthetic')
class SyntheticAdminBase {}

/**
 * `scopes` declares at CLASS level (the sweep's own shape); `methodScopes`
 * declares on the HANDLER, which is the only place H's O-3 pair is permitted.
 * Both may be set at once — that is the real controllers' shape: the class
 * carries the `:write` twin as the default and a read route adds the pair.
 */
type SyntheticPosture = { scopes?: string[]; methodScopes?: string[]; forbid?: boolean };

function syntheticController(row: AdminScopeMapRow, posture: SyntheticPosture = {}) {
  const scopes = posture.scopes ?? [toServiceAccountScope(row.adminScope)];
  const named = { [row.controllerClass]: class extends SyntheticAdminBase {} };
  const ControllerClass = named[row.controllerClass];

  // Each synthetic controller gets its OWN decorated handler rather than
  // inheriting one shared function object: method-level metadata is written
  // onto `descriptor.value`, so a shared handler would leak one row's
  // declaration into all 64.
  const proto = ControllerClass.prototype as Record<string, unknown>;
  proto.list = function list() {};
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'list') as PropertyDescriptor;
  Get()(proto, 'list', descriptor);

  if (scopes.length > 0) RequiredSvcScopes(...scopes)(ControllerClass);
  if (posture.methodScopes) RequiredSvcScopes(...posture.methodScopes)(proto, 'list', descriptor);
  if (posture.forbid) ForbidServiceAccount()(ControllerClass);

  return ControllerClass as unknown as new (...args: never[]) => unknown;
}

/** The whole fixture, correctly swept — with `overrides` replacing named rows. */
function sweptAdminPlane(overrides: Record<string, SyntheticPosture | 'omit'> = {}) {
  const controllers: Array<new (...args: never[]) => unknown> = [];
  for (const row of TASK_773_ADMIN_SCOPE_MAP) {
    const override = overrides[row.controllerClass];
    if (override === 'omit') continue;
    controllers.push(syntheticController(row, override ?? {}));
  }
  return controllers;
}

/** The offender lines of a thrown audit error — one per problem found. */
function offenderLines(run: () => void): string[] {
  try {
    run();
  } catch (error) {
    return (error as Error).message.split('\n').slice(1);
  }
  throw new Error('expected the audit to throw, but it passed');
}

describe('H — every swept admin controller declares its svc:admin:<area> twin', () => {
  it('PASSES on a correctly swept plane — the audit is not merely always-failing', () => {
    expect(() => auditAdminControllersDeclareCorrectSvcScope(fakeApp(sweptAdminPlane()))).not.toThrow();
  });

  it('THROWS when the sweep MISSED a controller (no svc:* scope at all)', () => {
    const lines = offenderLines(() => auditAdminControllersDeclareCorrectSvcScope(fakeApp(sweptAdminPlane({ TenantController: { scopes: [] } }))));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('TenantController');
    expect(lines[0]).toContain('declares NO svc:* scope');
    expect(lines[0]).toContain("expected exactly ['svc:admin:tenant:write']");
  });

  it('THROWS when the sweep MIS-ASSIGNED a scope — a registry-known twin belonging to a DIFFERENT admin area', () => {
    // The realistic copy-paste: TenantController keeps the line it was pasted
    // from, so it ends up gated by the DEPARTMENT area's twin. Every string
    // here is real — `svc:admin:department:manage` is in the registry, resolves
    // to abilities, and satisfies `@RequiredSvcScopes`'s own validation.
    const misassigned = { TenantController: { scopes: [toServiceAccountScope('admin:department:manage')] } };
    const lines = offenderLines(() => auditAdminControllersDeclareCorrectSvcScope(fakeApp(sweptAdminPlane(misassigned))));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('TenantController');
    expect(lines[0]).toContain('declares the WRONG svc:* scope');
    expect(lines[0]).toContain("expected either exactly ['svc:admin:tenant:write']");
    expect(lines[0]).toContain("found ['svc:admin:department:manage']");
  });

  it('and assertion G is BLIND to that same mis-assignment — which is why H exists', () => {
    const misassigned = { TenantController: { scopes: [toServiceAccountScope('admin:department:manage')] } };
    const app = fakeApp(sweptAdminPlane(misassigned));

    // G sees a registry-known scope on a route that does not forbid machines,
    // and is satisfied. It has no notion of WHICH area a controller belongs to.
    expect(() => auditServiceAccountReachableRoutesAreDeclared(app)).not.toThrow();
    expect(() => auditAdminControllersDeclareCorrectSvcScope(app)).toThrow(/WRONG svc:\* scope/);
  });

  it('THROWS when a controller WIDENS beyond its own twin (correct scope plus a second area)', () => {
    const widened = {
      WorkflowRunController: { scopes: [toServiceAccountScope('admin:workflow-run:read'), toServiceAccountScope('admin:tenant:write')] },
    };
    const lines = offenderLines(() => auditAdminControllersDeclareCorrectSvcScope(fakeApp(sweptAdminPlane(widened))));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WorkflowRunController');
    expect(lines[0]).toContain('declares the WRONG svc:* scope');
    expect(lines[0]).toContain('svc:admin:tenant:write');
  });

  // ── O-3: the METHOD-level {read, write} pair ──────────────────────────────

  it('PASSES when a READ route pairs the twin with its own :read sibling at the METHOD level (O-3)', () => {
    // The shipped shape: ApiKeyController keeps `svc:admin:apikey:write` at
    // class level and its four GET routes add the pair, so a `:read`-only grant
    // reaches them WITHOUT any `:write` holder losing a route (OR semantics).
    const paired = {
      ApiKeyController: { methodScopes: ['svc:admin:apikey:read', 'svc:admin:apikey:write'] },
      RolesController: { methodScopes: ['svc:admin:role:read', 'svc:admin:role:write'] },
    };

    expect(() => auditAdminControllersDeclareCorrectSvcScope(fakeApp(sweptAdminPlane(paired)))).not.toThrow();
  });

  it('accepts the pair in EITHER declaration order — the audit sorts before comparing', () => {
    const reversed = { ApiKeyController: { methodScopes: ['svc:admin:apikey:write', 'svc:admin:apikey:read'] } };

    expect(() => auditAdminControllersDeclareCorrectSvcScope(fakeApp(sweptAdminPlane(reversed)))).not.toThrow();
  });

  it('THROWS when the pair is declared at CLASS level — that would let a :read token MUTATE', () => {
    // The inversion O-3 exists to prevent: at class level the `:read` scope
    // covers the DELETE/PATCH routes too, so "read-only" would grant writes.
    const lines = offenderLines(() =>
      auditAdminControllersDeclareCorrectSvcScope(
        fakeApp(sweptAdminPlane({ ApiKeyController: { scopes: ['svc:admin:apikey:read', 'svc:admin:apikey:write'] } })),
      ),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ApiKeyController');
    expect(lines[0]).toContain('declares the WRONG svc:* scope');
    expect(lines[0]).toContain('at the class level');
    expect(lines[0]).toContain('permitted on a METHOD only');
  });

  it('THROWS when a method declares the :read sibling ALONE — that REVOKES the route from every :write grant', () => {
    const lines = offenderLines(() =>
      auditAdminControllersDeclareCorrectSvcScope(fakeApp(sweptAdminPlane({ ApiKeyController: { methodScopes: ['svc:admin:apikey:read'] } }))),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ApiKeyController');
    expect(lines[0]).toContain('declares the WRONG svc:* scope');
    expect(lines[0]).toContain("found ['svc:admin:apikey:read']");
  });

  it('THROWS when a method pairs the twin with ANOTHER area\'s :read scope — the widening is not "any superset"', () => {
    const lines = offenderLines(() =>
      auditAdminControllersDeclareCorrectSvcScope(
        fakeApp(sweptAdminPlane({ ApiKeyController: { methodScopes: ['svc:admin:apikey:write', 'svc:admin:tenant:read'] } })),
      ),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ApiKeyController');
    expect(lines[0]).toContain('svc:admin:tenant:read');
  });

  it('THROWS when an area whose twin has NO :read sibling tries the pair — shape (b) is derived, not available everywhere', () => {
    // `admin:department:manage` has no `:write`/`:read` split at all, so the
    // permitted set collapses to the single twin and a pair of ANY kind fails.
    const lines = offenderLines(() =>
      auditAdminControllersDeclareCorrectSvcScope(
        fakeApp(sweptAdminPlane({ DepartmentController: { methodScopes: ['svc:admin:department:manage', 'svc:admin:apikey:read'] } })),
      ),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('DepartmentController');
    expect(lines[0]).toContain("expected exactly ['svc:admin:department:manage']");
  });

  it('THROWS when a controller declares the twin AND @ForbidServiceAccount()', () => {
    const lines = offenderLines(() =>
      auditAdminControllersDeclareCorrectSvcScope(fakeApp(sweptAdminPlane({ AuditLogController: { forbid: true } }))),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('AuditLogController');
    expect(lines[0]).toContain('@ForbidServiceAccount()');
    expect(lines[0]).toContain('contradict');
  });

  it('THROWS when the fixture names a controller no module registers (a rename or deletion)', () => {
    const lines = offenderLines(() => auditAdminControllersDeclareCorrectSvcScope(fakeApp(sweptAdminPlane({ DepartmentController: 'omit' }))));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('DepartmentController');
    expect(lines[0]).toContain('is not registered by any module');
  });

  it('does NOT throw when a CONDITIONALLY-registered controller is absent (the default configuration)', () => {
    // Regression: `PrismaStudioModule` is imported only under
    // `ENABLE_PRISMA_STUDIO=true`, so on an ordinary host — production included —
    // `PrismaStudioController` is registered by no module. Before its fixture row
    // carried `conditionallyRegistered`, this arm refused the boot on the default
    // configuration: a boot failure the audit INTRODUCED rather than caught.
    const conditionalRows = TASK_773_ADMIN_SCOPE_MAP.filter((row) => row.conditionallyRegistered);
    expect(conditionalRows.length, 'fixture should still mark at least one conditionally-registered controller').toBeGreaterThan(0);

    const omitted = Object.fromEntries(conditionalRows.map((row) => [row.controllerClass, 'omit' as const]));

    expect(() => auditAdminControllersDeclareCorrectSvcScope(fakeApp(sweptAdminPlane(omitted)))).not.toThrow();
  });

  it('STILL validates a conditionally-registered controller when it IS registered', () => {
    // The flag suppresses only the absence check. A mis-scoped route must not be
    // able to hide behind it — switching the studio on is also the only
    // configuration in which those routes are reachable at all.
    const [conditional] = TASK_773_ADMIN_SCOPE_MAP.filter((row) => row.conditionallyRegistered);
    expect(conditional, 'fixture should still mark at least one conditionally-registered controller').toBeDefined();

    const lines = offenderLines(() =>
      auditAdminControllersDeclareCorrectSvcScope(fakeApp(sweptAdminPlane({ [conditional.controllerClass]: { scopes: ['svc:admin:department:manage'] } }))),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(conditional.controllerClass);
    expect(lines[0]).toContain(toServiceAccountScope(conditional.adminScope));
  });

  it('reports EVERY offender in one boot failure, not just the first', () => {
    const lines = offenderLines(() =>
      auditAdminControllersDeclareCorrectSvcScope(
        fakeApp(
          sweptAdminPlane({
            TenantController: { scopes: [] },
            UserController: { scopes: [toServiceAccountScope('admin:department:manage')] },
            AuditLogController: 'omit',
          }),
        ),
      ),
    );

    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain('TenantController');
    expect(lines.join('\n')).toContain('UserController');
    expect(lines.join('\n')).toContain('AuditLogController');
  });

  it('IGNORES the six admin controllers deliberately absent from the fixture', () => {
    // Three had no `admin:*` scope to renamespace and were settled by owner
    // decision O-1 (WebhookController OPEN on the pre-convention family;
    // MonitoringController and AdminHealthServicesController CLOSED); three are
    // machine-CLOSED by owner decision D-3. None may be required to carry a
    // svc:admin:<area> scope, and the fixture-driven loop must not invent one
    // for them just because their path starts with `admin/`. (That they each
    // declare SOMETHING is assertion G's job, proved just above.)
    const absent = [
      WebhookController,
      MonitoringController,
      AdminHealthServicesController,
      ServiceAccountController,
      AdminImpersonationController,
      ConsentGrantController,
    ] as unknown as Array<new (...args: never[]) => unknown>;

    for (const Absent of absent) {
      expect(TASK_773_ADMIN_SCOPE_MAP.some((row) => row.controllerClass === Absent.name)).toBe(false);
    }

    expect(() => auditAdminControllersDeclareCorrectSvcScope(fakeApp([...sweptAdminPlane(), ...absent]))).not.toThrow();
  });
});
