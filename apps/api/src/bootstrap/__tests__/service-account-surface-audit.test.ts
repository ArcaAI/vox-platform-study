/**
 * TASK-762 §5.7 — the boot audits for the third credential class.
 *
 * Each assertion is proved twice: it THROWS on a synthetic violating module,
 * and it PASSES on the real controllers. A boot audit that has never been seen
 * to fail proves nothing — and assertion B in particular passes VACUOUSLY today
 * (§2.1: no admin controller uses a service-token guard), so the synthetic
 * violation is the only evidence that it would catch one.
 */
import { describe, it, expect } from 'vitest';
import { Controller, Get, Injectable, Post, UseGuards } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { ForbidApiKey, ForbidServiceAccount, Public, RequiredSvcScopes } from '@arcaai/applications';

import {
  auditNoAdminControllerUsesServiceTokenGuard,
  auditNoInternalControllerDeclaresSvcScopes,
  auditServiceAccountControllerForbidsBothClasses,
  auditServiceAccountReachableRoutesAreDeclared,
  auditSvcScopeCoverage,
  auditTokenExchangeRouteIsPublicAndGuarded,
} from '../service-account-surface-audit';
import { ServiceAccountController } from '../../modules/service-account/service-account.controller';
import { ServiceAccountTokenController } from '../../modules/service-account/service-account-token.controller';

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

    expect(() => auditNoAdminControllerUsesServiceTokenGuard(fakeApp([OffendingAdminController]))).toThrow(/TASK-708 §6 owner ruling forbids mixing/);
  });

  it('THROWS when the guard is applied at the METHOD level rather than the class', () => {
    @Controller('admin/shortcut')
    class MethodOffender {
      @Get()
      @UseGuards(InternalServiceTokenGuard)
      list() {}
    }

    expect(() => auditNoAdminControllerUsesServiceTokenGuard(fakeApp([MethodOffender]))).toThrow(/TASK-762/);
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
  it('THROWS on a route that both declares a svc:* scope and forbids machines', () => {
    @Controller('admin/contradiction')
    class Contradiction {
      @Get()
      @RequiredSvcScopes('svc:admin:department:manage')
      @ForbidServiceAccount()
      list() {}
    }

    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([Contradiction]))).toThrow(/These contradict/);
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

  it('passes for the real controllers (no svc:* declarations yet — TASK-757 lands them)', () => {
    expect(() => auditServiceAccountReachableRoutesAreDeclared(fakeApp([ServiceAccountController, ServiceAccountTokenController]))).not.toThrow();
  });
});
