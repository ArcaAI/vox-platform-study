/**
 * `RateLimitRuleService` — the governance the SCHEMA cannot express (TASK-785).
 *
 * The precedence itself is pinned in `rate-limit-resolver.test.ts`; this file
 * covers what the service adds on top: the per-scope caps, the duplicate guard,
 * the "a platform rule may not use `*`" rule, the CLS pin that makes a
 * super-admin write land on the rule's OWN tenant, the sys-events, and the
 * `explain` trace.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ResourceType, SysEventType } from '@arcaai/domains';
import { RateLimitRuleService } from '../rate-limit-rule.service';
import { MAX_PLATFORM_RULES, MAX_RULES_PER_TENANT, RATE_LIMIT_RULE_SYSTEM_TENANT_ID } from '../rate-limit-rule.constants';

const TENANT = '11111111-1111-1111-1111-111111111111';

interface StoredRule {
  id: string;
  tenantId: string;
  routeMatch: string;
  matchKind: string;
  limitValue: number;
  windowMs: number;
  active: boolean;
  description: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  hasChanges?: boolean;
}

let rows: StoredRule[] = [];
/** The CLS tenant visible at the moment the repository write ran. */
let tenantSeenByWrite: string | undefined;

const ruleRepository = {
  findAllForCache: vi.fn(async () => rows),
  findByTenant: vi.fn(async (tenantId: string) => rows.filter((r) => r.tenantId === tenantId)),
  findById: vi.fn(async (id: string) => {
    const found = rows.find((r) => r.id === id);
    if (!found) throw new Error('not found');
    return found;
  }),
  create: vi.fn(async (entity: StoredRule) => {
    tenantSeenByWrite = clsStore.tenantId;
    rows.push(entity);
    return entity;
  }),
  // Returns the entity unchanged: `version` is a getter on the real
  // `BaseEntity` (the DB owns it), so a double must not try to bump it.
  updateWithVersion: vi.fn(async (_id: string, entity: StoredRule) => {
    tenantSeenByWrite = clsStore.tenantId;
    return entity;
  }),
  softDelete: vi.fn(async (id: string) => {
    tenantSeenByWrite = clsStore.tenantId;
    rows = rows.filter((r) => r.id !== id);
  }),
};

const cache = { invalidate: vi.fn().mockResolvedValue(undefined), getRulesFor: vi.fn(() => []), getPlatformRules: vi.fn(() => []) };

const settings = { getTier: vi.fn(() => ({ limit: 100, ttl: 60_000 })) };
const entitlements = { getTenantRateLimitPolicy: vi.fn(async () => null) };
const eventEmitter = { emit: vi.fn() };

let clsStore: { tenantId?: string } = {};
const cls = {
  get: vi.fn((key: string) => (clsStore as Record<string, unknown>)[key]),
  set: vi.fn((key: string, value: unknown) => {
    (clsStore as Record<string, unknown>)[key] = value;
  }),
  run: vi.fn(async (_opts: unknown, fn?: () => unknown) => {
    const work = (typeof _opts === 'function' ? _opts : fn) as () => unknown;
    const outer = clsStore;
    clsStore = { ...outer };
    try {
      return await work();
    } finally {
      clsStore = outer;
    }
  }),
  // `exit` runs with NO active store — the tenant-scope extension passes through.
  exit: vi.fn(async (fn: () => unknown) => {
    const outer = clsStore;
    clsStore = {};
    try {
      return await fn();
    } finally {
      clsStore = outer;
    }
  }),
};

function makeService() {
  return new RateLimitRuleService(
    ruleRepository as never,
    cache as never,
    settings as never,
    entitlements as never,
    eventEmitter as never,
    cls as never,
  );
}

function seed(over: Partial<StoredRule> & Pick<StoredRule, 'routeMatch'>): StoredRule {
  const row: StoredRule = {
    id: `r-${rows.length}`,
    tenantId: TENANT,
    matchKind: 'EXACT',
    limitValue: 10,
    windowMs: 60_000,
    active: true,
    description: null,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  rows.push(row);
  return row;
}

beforeEach(() => {
  rows = [];
  clsStore = {};
  tenantSeenByWrite = undefined;
  vi.clearAllMocks();
});

describe('RateLimitRuleService — governance', () => {
  it('refuses the `*` (all routes) pattern on a PLATFORM rule', async () => {
    // Rank 5 (the named tier baselines) is the one platform-wide knob; a second
    // one here would silently outrank the tiers screen an admin just edited.
    await expect(makeService().create({ routeMatch: '*', matchKind: 'PREFIX', limitValue: 10, windowMs: 60_000 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts the `*` pattern on a TENANT rule — that is how rank 2 is expressed', async () => {
    const view = await makeService().create({ tenantId: TENANT, routeMatch: '*', matchKind: 'PREFIX', limitValue: 10, windowMs: 60_000 });
    expect(view.routeMatch).toBe('*');
    expect(view.platform).toBe(false);
  });

  it('requires PREFIX for the `*` pattern', async () => {
    await expect(
      makeService().create({ tenantId: TENANT, routeMatch: '*', matchKind: 'EXACT', limitValue: 10, windowMs: 60_000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a malformed routeMatch', async () => {
    await expect(makeService().create({ tenantId: TENANT, routeMatch: 'not-a-route', limitValue: 10, windowMs: 60_000 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a wildcard inside an EXACT rule', async () => {
    await expect(
      makeService().create({ tenantId: TENANT, routeMatch: 'GET:/api/v1/admin/*', matchKind: 'EXACT', limitValue: 10, windowMs: 60_000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-positive limit or window', async () => {
    const svc = makeService();
    await expect(svc.create({ tenantId: TENANT, routeMatch: 'GET:/a', limitValue: 0, windowMs: 60_000 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ tenantId: TENANT, routeMatch: 'GET:/a', limitValue: 10, windowMs: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a duplicate scope + pattern rather than silently shadowing one', async () => {
    seed({ routeMatch: 'GET:/api/v1/x' });
    await expect(makeService().create({ tenantId: TENANT, routeMatch: 'GET:/api/v1/x', limitValue: 5, windowMs: 60_000 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses a write past the per-tenant cap instead of truncating silently', async () => {
    for (let i = 0; i < MAX_RULES_PER_TENANT; i++) seed({ routeMatch: `GET:/api/v1/r${i}` });
    await expect(makeService().create({ tenantId: TENANT, routeMatch: 'GET:/api/v1/new', limitValue: 5, windowMs: 60_000 })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('gives the platform scope its own, larger cap', () => {
    expect(MAX_PLATFORM_RULES).toBeGreaterThan(MAX_RULES_PER_TENANT);
  });
});

describe('RateLimitRuleService — tenant pinning', () => {
  it('writes a platform rule under the SYSTEM tenant even when the caller has a working tenant selected', async () => {
    // A super admin's request carries `X-Tenant-Id`, so CLS holds a CUSTOMER
    // tenant. Without the pin the tenant-scope extension would stamp that tenant
    // onto a row meant to be platform-wide — the TASK-771 failure mode.
    clsStore = { tenantId: TENANT };

    const view = await makeService().create({ routeMatch: 'GET:/api/v1/x', limitValue: 5, windowMs: 60_000 });

    expect(view.tenantId).toBe(RATE_LIMIT_RULE_SYSTEM_TENANT_ID);
    expect(view.platform).toBe(true);
    expect(tenantSeenByWrite).toBe(RATE_LIMIT_RULE_SYSTEM_TENANT_ID);
  });

  it('writes a tenant rule under THAT tenant, not the caller’s working tenant', async () => {
    clsStore = { tenantId: 'some-other-working-tenant' };

    await makeService().create({ tenantId: TENANT, routeMatch: 'GET:/api/v1/x', limitValue: 5, windowMs: 60_000 });

    expect(tenantSeenByWrite).toBe(TENANT);
  });

  it('restores the caller’s CLS scope after the pinned write', async () => {
    clsStore = { tenantId: TENANT };
    await makeService().create({ routeMatch: 'GET:/api/v1/x', limitValue: 5, windowMs: 60_000 });
    expect(clsStore.tenantId).toBe(TENANT);
  });
});

describe('RateLimitRuleService — lifecycle', () => {
  it('invalidates the throttler cache on every mutation, so a change is live with no redeploy', async () => {
    const svc = makeService();
    const created = await svc.create({ tenantId: TENANT, routeMatch: 'GET:/api/v1/x', limitValue: 5, windowMs: 60_000 });
    expect(cache.invalidate).toHaveBeenCalledTimes(1);

    await svc.update(created.id, { limitValue: 7 });
    expect(cache.invalidate).toHaveBeenCalledTimes(2);

    await svc.remove(created.id);
    expect(cache.invalidate).toHaveBeenCalledTimes(3);
  });

  it('broadcasts a sys-event under its own ResourceType on every mutation', async () => {
    const svc = makeService();
    const created = await svc.create({ tenantId: TENANT, routeMatch: 'GET:/api/v1/x', limitValue: 5, windowMs: 60_000 });
    await svc.update(created.id, { limitValue: 7 });
    await svc.remove(created.id);

    const types = eventEmitter.emit.mock.calls.map((call) => call[0]);
    expect(types).toEqual([SysEventType.ResourceCreated, SysEventType.ResourceUpdated, SysEventType.ResourceDeleted]);
    for (const call of eventEmitter.emit.mock.calls) {
      expect((call[1] as { resourceType?: string }).resourceType).toBe(ResourceType.RateLimitRule);
    }
  });

  it('answers 404 — never 403 — for a rule that is not there', async () => {
    await expect(makeService().getById('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is a no-op when an update changes nothing', async () => {
    const created = await makeService().create({ tenantId: TENANT, routeMatch: 'GET:/api/v1/x', limitValue: 5, windowMs: 60_000 });
    vi.clearAllMocks();

    await makeService().update(created.id, {});
    expect(ruleRepository.updateWithVersion).not.toHaveBeenCalled();
  });
});

describe('RateLimitRuleService — explain (AC-8)', () => {
  it('names the winning level, the rule, and how the counter is bucketed', async () => {
    cache.getRulesFor.mockReturnValue([
      { id: 'rule-1', tenantId: TENANT, routeMatch: 'POST:/api/v1/auth/login', matchKind: 'EXACT', limitValue: 3, windowMs: 60_000, active: true },
    ] as never);

    const result = await makeService().explain(TENANT, 'POST', '/api/v1/auth/login');

    expect(result.level).toBe('tenant-route');
    expect(result.ruleId).toBe('rule-1');
    expect(result.effective).toEqual({ limitValue: 3, windowMs: 60_000 });
    // The bucket is the answer to "why do these callers share a budget?".
    expect(result.bucket).toBe('tenant');
    expect(result.trace.find((o) => o.winner)?.level).toBe('tenant-route');
  });

  it('reports the platform base and IP bucketing when nothing else has an opinion', async () => {
    cache.getRulesFor.mockReturnValue([] as never);
    cache.getPlatformRules.mockReturnValue([] as never);

    const result = await makeService().explain(null, 'GET', '/api/v1/health');

    expect(result.level).toBe('platform-base');
    expect(result.bucket).toBe('ip');
    expect(result.effective).toEqual({ limitValue: 100, windowMs: 60_000 });
  });

  it('treats an entitlements failure as "rank 3 has no opinion", never an error', async () => {
    cache.getRulesFor.mockReturnValue([] as never);
    cache.getPlatformRules.mockReturnValue([] as never);
    entitlements.getTenantRateLimitPolicy.mockRejectedValueOnce(new Error('db down') as never);

    const result = await makeService().explain(TENANT, 'GET', '/api/v1/x');
    expect(result.level).toBe('platform-base');
  });
});
