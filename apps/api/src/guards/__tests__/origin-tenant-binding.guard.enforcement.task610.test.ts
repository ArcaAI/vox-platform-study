// TASK-610 §4C — the binding guard is DORMANT while origin enforcement is off.
//
// `origin-tenant-binding.guard.task610.test.ts` pins the ENFORCING behaviour
// (and installs `setOriginEnforcementResolver(() => true)` to get it). This file
// pins the other half: with the switch off, a request whose tenant matches no
// grant on its origin must pass, not 404. §4C.3 states the consequence plainly:
// "a request from any origin may act on any tenant it can authenticate to".
// Authentication and tenancy remain the controls; the ORIGIN binding simply
// does not apply.
//
// "the switch off" is NO LONGER THE DEFAULT (TASK-641 FR-6 flipped
// `origin.enforcementEnabled` to default `true`). The cases below still hold
// unchanged, because they set the resolver explicitly — `null` here is this
// process's pre-boot state, not the platform posture. Only the wording changed.
import { ExecutionContext } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IOriginRegistry } from '@arcaai/applications';

import { setOriginEnforcementResolver } from '../../cors.config';
import { OriginTenantBindingGuard } from '../origin-tenant-binding.guard';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_C = '33333333-3333-3333-3333-333333333333';

/** Every lookup is a spy, so "never consulted" is observable. */
const spyRegistry = (): IOriginRegistry => ({
  tenantsFor: vi.fn(() => new Set([TENANT_A])),
  has: vi.fn(() => true),
  allows: vi.fn(() => false),
  refresh: vi.fn(async () => undefined),
  size: vi.fn(() => 1),
});

const createCls = (store: Record<string, unknown>): ClsService =>
  ({
    isActive: () => true,
    get: (key: string) => store[key],
  }) as unknown as ClsService;

const createContext = (headers: Record<string, unknown> = {}): ExecutionContext =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ headers, url: '/api/v1/consultations', method: 'GET' }) }),
    getHandler: () => 'handlerRef',
    getClass: () => 'classRef',
  }) as unknown as ExecutionContext;

describe('OriginTenantBindingGuard — enforcement disabled (TASK-610 §4C)', () => {
  let registry: IOriginRegistry;

  beforeEach(() => {
    setOriginEnforcementResolver(null);
    registry = spyRegistry();
  });

  afterEach(() => {
    setOriginEnforcementResolver(null);
    vi.restoreAllMocks();
  });

  it('passes a request whose tenant matches NO grant on its origin — the case that 404s when enforcement is on', () => {
    const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_C }), registry);

    expect(guard.canActivate(createContext({ origin: 'https://a.example' }))).toBe(true);
  });

  it('never consults the registry at all', () => {
    const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_C }), registry);

    guard.canActivate(createContext({ origin: 'https://evil.example.com' }));

    expect(registry.has).not.toHaveBeenCalled();
    expect(registry.allows).not.toHaveBeenCalled();
  });

  it('passes a resolver that THROWS — a broken settings cache must not start 404-ing traffic', () => {
    setOriginEnforcementResolver(() => {
      throw new Error('settings cache exploded');
    });
    const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_C }), registry);

    expect(guard.canActivate(createContext({ origin: 'https://a.example' }))).toBe(true);
    expect(registry.allows).not.toHaveBeenCalled();
  });

  it('resumes enforcing the moment the switch flips — no restart, same guard instance', () => {
    let enabled = false;
    setOriginEnforcementResolver(() => enabled);
    const guard = new OriginTenantBindingGuard(createCls({ tenantId: TENANT_C }), registry);

    expect(guard.canActivate(createContext({ origin: 'https://a.example' }))).toBe(true);

    enabled = true;
    expect(() => guard.canActivate(createContext({ origin: 'https://a.example' }))).toThrow();
  });
});
