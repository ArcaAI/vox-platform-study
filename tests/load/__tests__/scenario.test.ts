/**
 * The mix, and the aggregation the report is rendered from.
 */
import { describe, expect, it } from 'vitest';
import { add, createAggregate, mergeAggregate } from '../src/aggregate';
import { bindingCeiling } from '../src/report';
import { CONSOLE_SCREENS, MACHINE_SCREENS, pickScreen, routeTemplate, SHELL_STEPS, staticFallbackProfile, stepsFor } from '../src/scenario';
import { summarize } from '../src/stats';
import { mulberry32 } from '../src/thinktime';
import type { RequestSample } from '../src/types';

function sample(overrides: Partial<RequestSample> = {}): RequestSample {
  return {
    startedAtMs: 0,
    durationMs: 10,
    scheduleDelayMs: 0,
    method: 'GET',
    routeKey: 'GET admin/tenants',
    tenantId: 't-1',
    principalKind: 'human',
    status: 200,
    ok: true,
    cause: null,
    ...overrides,
  };
}

describe('the screen mix', () => {
  it('gives every console screen at least one query, or it models nothing', () => {
    for (const screen of [...CONSOLE_SCREENS, ...MACHINE_SCREENS]) {
      expect(screen.steps.length, screen.name).toBeGreaterThan(0);
      expect(screen.weight, screen.name).toBeGreaterThan(0);
    }
  });

  it('adds the shell tax to a human navigation and not to a machine one', () => {
    const screen = CONSOLE_SCREENS[0]!;
    expect(stepsFor(screen, 'human')).toHaveLength(SHELL_STEPS.length + screen.steps.length);
    expect(stepsFor(screen, 'api_key')).toHaveLength(screen.steps.length);
  });

  it("honours a step's principal restriction", () => {
    const adminRead = MACHINE_SCREENS.find((s) => s.name === 'integration-admin-read')!;
    // An API key can never reach `/admin/*` — every admin controller carries
    // `@ForbidApiKey()`. Issuing it anyway would fill the run with 403s that
    // look like a platform finding.
    expect(stepsFor(adminRead, 'api_key')).toHaveLength(0);
    expect(stepsFor(adminRead, 'service_account')).toHaveLength(1);
  });

  it('picks screens in proportion to their weight', () => {
    const random = mulberry32(5);
    const counts = new Map<string, number>();
    for (let i = 0; i < 40_000; i += 1) {
      const name = pickScreen(CONSOLE_SCREENS, random).name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    for (const screen of CONSOLE_SCREENS) {
      const expected = screen.weight / CONSOLE_SCREENS.reduce((sum, s) => sum + s.weight, 0);
      expect(Math.abs((counts.get(screen.name) ?? 0) / total - expected), screen.name).toBeLessThan(0.02);
    }
  });

  it('keys the mix on a route TEMPLATE, so the report cardinality stays bounded', () => {
    expect(routeTemplate('GET', 'admin/tenants?page=1&limit=25')).toBe('GET admin/tenants');
  });
});

describe('staticFallbackProfile', () => {
  it('labels itself as derived, so a run can never present it as a measurement', () => {
    const profile = staticFallbackProfile();
    expect(profile.source).toBe('static-fallback');
    expect(profile.notes[0]).toMatch(/NOT MEASURED/);
  });

  it('lands in the OD-1 range rather than the original 10 req/min model', () => {
    const profile = staticFallbackProfile();
    expect(profile.requestsPerMinute).toBeGreaterThan(30);
    expect(profile.requestsPerMinute).toBeLessThan(120);
    expect(profile.idleRequestsPerMinute).toBeGreaterThan(0);
  });

  it('produces a route mix that sums to 1', () => {
    const sum = Object.values(staticFallbackProfile().routeMix).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.01);
  });
});

describe('aggregate', () => {
  it('counts a success against the route, the tenant and the timeline', () => {
    const aggregate = createAggregate(0, 10);
    add(aggregate, sample({ rateLimit: { limit: 300 } }));
    expect(aggregate.total).toBe(1);
    expect(aggregate.ok).toBe(1);
    expect(aggregate.byRoute['GET admin/tenants']!.ok).toBe(1);
    expect(aggregate.byTenant['t-1']!.ok).toBe(1);
    expect(aggregate.timeline[0]!.ok).toBe(1);
    // Only a 2xx carries `X-RateLimit-Limit`, so this is the only place the
    // enforced limit can be observed at all.
    expect(aggregate.observedLimits['GET admin/tenants']).toBe(300);
  });

  it('records the first throttle offset — the effective budget, read straight off the run', () => {
    const aggregate = createAggregate(0, 60);
    add(aggregate, sample({ startedAtMs: 4_000 }));
    add(aggregate, sample({ startedAtMs: 9_500, status: 429, ok: false, cause: 'throttle_tenant', causeDetail: 'tier=default' }));
    add(aggregate, sample({ startedAtMs: 20_000, status: 429, ok: false, cause: 'throttle_tenant' }));
    expect(aggregate.firstThrottleAtMs).toBe(9_500);
    expect(aggregate.byCause['throttle_tenant']).toBe(2);
    expect(aggregate.byCauseDetail['throttle_tenant :: tier=default']).toBe(1);
    expect(aggregate.timeline[9]!.throttled).toBe(1);
  });

  it('keeps correlation ids for exactly the causes an operator must resolve in the log', () => {
    const aggregate = createAggregate(0, 10);
    add(aggregate, sample({ status: 500, ok: false, cause: 'db_pool_timeout_suspected', correlationId: 'c-1' }));
    add(aggregate, sample({ status: 500, ok: false, cause: 'server_error', correlationId: 'c-2' }));
    add(aggregate, sample({ status: 429, ok: false, cause: 'throttle_ip', correlationId: 'c-3' }));
    expect(aggregate.unattributedCorrelationIds).toEqual(['c-1', 'c-2']);
  });

  it('clamps a late sample into the last timeline bucket rather than dropping it', () => {
    const aggregate = createAggregate(0, 3);
    add(aggregate, sample({ startedAtMs: 99_000 }));
    expect(aggregate.timeline[2]!.requests).toBe(1);
    expect(aggregate.total).toBe(1);
  });

  it('merges shards without losing anything', () => {
    const a = createAggregate(0, 5);
    const b = createAggregate(0, 5);
    add(a, sample({ durationMs: 10 }));
    add(a, sample({ durationMs: 20, tenantId: 't-2' }));
    add(b, sample({ durationMs: 30, status: 429, ok: false, cause: 'throttle_ip', startedAtMs: 2_000 }));

    const merged = mergeAggregate(a, b);
    expect(merged.total).toBe(3);
    expect(merged.ok).toBe(2);
    expect(summarize(merged.latency).count).toBe(3);
    expect(merged.byTenant['t-1']!.total).toBe(2);
    expect(merged.byCause['throttle_ip']).toBe(1);
    expect(merged.firstThrottleAtMs).toBe(2_000);
  });
});

describe('bindingCeiling', () => {
  it('names the ceiling that refused the most work', () => {
    const aggregate = createAggregate(0, 5);
    for (let i = 0; i < 3; i += 1) add(aggregate, sample({ status: 429, ok: false, cause: 'throttle_tenant' }));
    add(aggregate, sample({ status: 502, ok: false, cause: 'downstream_5xx' }));
    expect(bindingCeiling(aggregate)).toEqual({ cause: 'throttle_tenant', count: 3 });
  });

  it('excludes harness faults, so a broken fixture cannot masquerade as a platform ceiling', () => {
    const aggregate = createAggregate(0, 5);
    for (let i = 0; i < 50; i += 1) add(aggregate, sample({ status: 403, ok: false, cause: 'auth' }));
    add(aggregate, sample({ status: 429, ok: false, cause: 'throttle_ip' }));
    expect(bindingCeiling(aggregate)).toEqual({ cause: 'throttle_ip', count: 1 });
  });

  it('returns null when nothing was refused — "no ceiling found" is not "plenty of headroom"', () => {
    const aggregate = createAggregate(0, 5);
    add(aggregate, sample());
    expect(bindingCeiling(aggregate)).toBeNull();
  });
});
