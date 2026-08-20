/**
 * TASK-781 — the boot gate for `CASL_ENFORCED_PAIRS`.
 *
 * `assertCaslEnforcePairReachability` (unit-tested in `@arcaai/applications`)
 * decides reachability from a route table. THIS suite proves the audit builds
 * that table correctly from the live Nest container — the half that made
 * TASK-779 F-1 possible was not the rule, it was that nobody ever compared
 * the enforce list against the routes.
 *
 * The shipped enforce list is EMPTY, so the audit passes vacuously against the
 * real app. Every assertion here therefore drives the audit with an explicit
 * pair set, including a reconstruction of the exact F-1 shape.
 */
import { describe, it, expect } from 'vitest';
import { Controller, Get, Patch } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { CanRead, CanUpdate, CanAny, ResolveSubjectInstance } from '@arcaai/applications';

import { auditCaslEnforcePairReachability, collectEnforceRouteDescriptors } from '../casl-enforce-reachability-audit';

function buildFakeApp(controllers: Array<new (...args: never[]) => unknown>) {
  const wrappers = controllers.map((ControllerClass) => ({
    metatype: ControllerClass,
    instance: Object.create(ControllerClass.prototype) as Record<string, unknown>,
  }));
  const modulesContainer = new Map([['synthetic', { controllers: new Map(wrappers.map((w, i) => [i, w])) }]]);

  return {
    get: (token: unknown) => {
      if (token === ModulesContainer) return modulesContainer;
      if (token === Reflector) return new Reflector();
      throw new Error(`unexpected token: ${String(token)}`);
    },
  } as unknown as Parameters<typeof auditCaslEnforcePairReachability>[0];
}

const ownedResolver = async () => ({ tenantId: 't', userId: 'u' });

@Controller('admin/widgets')
class ReachableController {
  @Get(':id')
  @CanRead('Widget')
  @ResolveSubjectInstance(ownedResolver, { subject: 'Widget', enforceGrade: true })
  fetchById() {}

  @Get()
  @CanRead('Widget')
  fetchAll() {}
}

/** The TASK-779 F-1 shape: route + resolver present, resolver NOT enforce-grade. */
@Controller('admin/api-keys')
class F1ShapedController {
  @Get(':id')
  @CanRead('ApiKey')
  @ResolveSubjectInstance(ownedResolver)
  fetchById() {}
}

@Controller('admin/gadgets')
class OrModeController {
  @Patch(':id')
  @CanAny(['update', 'Gadget'], ['manage', 'Tenant'])
  @ResolveSubjectInstance(ownedResolver, { subject: 'Gadget', enforceGrade: true })
  update() {}
}

describe('auditCaslEnforcePairReachability (TASK-781)', () => {
  it('the REAL app passes — the shipped enforce list is empty, so nothing is claimed', async () => {
    // Imported lazily: the barrel pulls the whole applications package in.
    const { CASL_ENFORCED_PAIRS } = await import('@arcaai/applications');
    expect([...CASL_ENFORCED_PAIRS]).toEqual([]);
    expect(() => auditCaslEnforcePairReachability(buildFakeApp([ReachableController, F1ShapedController]))).not.toThrow();
  });

  it('accepts a pair backed by an AND-mode route with an enforce-grade resolver', () => {
    expect(() => auditCaslEnforcePairReachability(buildFakeApp([ReachableController]), new Set(['read:Widget']))).not.toThrow();
  });

  it('WOULD HAVE CAUGHT F-1: a pair whose resolver is not enforce-grade fails the boot', () => {
    expect(() => auditCaslEnforcePairReachability(buildFakeApp([F1ShapedController]), new Set(['read:ApiKey']))).toThrow(/read:ApiKey/);
  });

  it('R4: a pair declared on an OR-mode route fails the boot', () => {
    expect(() => auditCaslEnforcePairReachability(buildFakeApp([OrModeController]), new Set(['update:Gadget']))).toThrow(/OR mode/i);
  });

  it('a pair no route declares fails the boot', () => {
    expect(() => auditCaslEnforcePairReachability(buildFakeApp([ReachableController]), new Set(['delete:Ghost']))).toThrow(/no route declares/i);
  });

  it('collects class-level decorators too — Nest does not copy them onto handlers', () => {
    @Controller('admin/things')
    @CanRead('Thing')
    class ClassLevelController {
      @Get(':id')
      @ResolveSubjectInstance(ownedResolver, { subject: 'Thing', enforceGrade: true })
      fetchById() {}
    }

    const descriptors = collectEnforceRouteDescriptors(buildFakeApp([ClassLevelController]));
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].permissions).toEqual([{ action: 'read', subject: 'Thing' }]);
    expect(descriptors[0].resolver).toEqual({ subject: 'Thing', enforceGrade: true });
    expect(descriptors[0].mode).toBe('AND');
  });

  it('reads OR mode off @CanAny, and reports a bare resolver as not enforce-grade', () => {
    const [orRoute] = collectEnforceRouteDescriptors(buildFakeApp([OrModeController]));
    expect(orRoute.mode).toBe('OR');

    const [f1Route] = collectEnforceRouteDescriptors(buildFakeApp([F1ShapedController]));
    expect(f1Route.resolver).toEqual({ subject: undefined, enforceGrade: false });
  });
});
