/**
 * Rules + Explain tabs (TASK-785, frame 16).
 *
 * The precedence itself is pinned in the gateway; what matters here is that the
 * screen tells the truth about it — the rank badges, the platform-`*` guard the
 * gateway would otherwise have to reject, and the resolution trace.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { RateLimitExplainResult, RateLimitPlan, RateLimitRule, RouteCatalogEntry } from '../../api/types';
import { RateLimitExplainPanel } from '../rate-limit-explain-panel';
import { RateLimitPlansPanel } from '../rate-limit-plans-panel';
import { RateLimitRulesPanel } from '../rate-limit-rules-panel';

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const TENANT = '11111111-1111-1111-1111-111111111111';

const RULES: RateLimitRule[] = [
  {
    id: 'rule-platform',
    tenantId: SYSTEM,
    platform: true,
    routeMatch: 'POST:/api/v1/auth/login',
    matchKind: 'EXACT',
    limitValue: 5,
    windowMs: 60_000,
    active: true,
    version: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  },
  {
    id: 'rule-tenant-route',
    tenantId: TENANT,
    platform: false,
    routeMatch: 'POST:/api/v1/auth/login',
    matchKind: 'EXACT',
    limitValue: 50,
    windowMs: 60_000,
    active: true,
    version: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  },
  {
    id: 'rule-tenant-wide',
    tenantId: TENANT,
    platform: false,
    routeMatch: '*',
    matchKind: 'PREFIX',
    limitValue: 500,
    windowMs: 60_000,
    active: false,
    version: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  },
];

const CATALOG: RouteCatalogEntry[] = [
  {
    routeId: 'POST:/api/v1/auth/login',
    method: 'POST',
    path: '/api/v1/auth/login',
    controller: 'AuthController',
    handler: 'login',
    decoratorLimit: 5,
  },
];

const EXPLAIN: RateLimitExplainResult = {
  tenantId: TENANT,
  routeKey: 'POST:/api/v1/auth/login',
  effective: { limitValue: 50, windowMs: 60_000 },
  level: 'tenant-route',
  ruleId: 'rule-tenant-route',
  bucket: 'tenant',
  trace: [
    { level: 'tenant-route', limitValue: 50, windowMs: 60_000, ruleId: 'rule-tenant-route', active: true, winner: true },
    { level: 'plan', limitValue: 10, windowMs: 60_000, active: true, winner: false },
    { level: 'platform-route', limitValue: 5, windowMs: 60_000, ruleId: 'rule-platform', active: true, winner: false },
    { level: 'platform-base', limitValue: 100, windowMs: 60_000, active: true, winner: false },
  ],
};

function stubFetch(handler: (url: string, method: string, body: unknown) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      return handler(url, method, body);
    }),
  );
}

const PLANS: RateLimitPlan[] = [
  { id: 'p-starter', plan: 'STARTER', rateLimitTier: 'strict', rateLimitPerMinute: null, rateLimitWindowMs: null, version: 1 },
  { id: 'p-pro', plan: 'PRO', rateLimitTier: 'default', rateLimitPerMinute: null, rateLimitWindowMs: null, version: 3 },
  { id: 'p-ent', plan: 'ENTERPRISE', rateLimitTier: 'relaxed', rateLimitPerMinute: 5000, rateLimitWindowMs: 60_000, version: 2 },
];

const TENANTS = { data: [{ id: TENANT, name: 'ArcaAI' }] };

const routeAware = (url: string) => {
  if (url.includes('/rate-limit/plans')) return Response.json(PLANS);
  if (url.includes('admin/tenants')) return Response.json(TENANTS);
  if (url.includes('/rate-limit/routes')) return Response.json(CATALOG);
  if (url.includes('/rate-limit/rules')) return Response.json(RULES);
  if (url.includes('/rate-limit/explain')) return Response.json(EXPLAIN);
  return Response.json({});
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RateLimitRulesPanel', () => {
  it('labels each rule with the precedence rank it actually occupies', async () => {
    stubFetch(routeAware);
    renderWithProviders(<RateLimitRulesPanel />);

    // A tenant rule naming a route is rank 1; the same tenant's `*` rule is
    // rank 2; a SYSTEM rule is rank 4. That mapping is the whole mental model.
    expect(await screen.findByText('1. Tenant × route')).toBeDefined();
    expect(screen.getByText('2. Tenant')).toBeDefined();
    expect(screen.getByText('4. Platform route')).toBeDefined();
  });

  it('shows an inactive rule as exempting its scope, not as merely disabled', async () => {
    stubFetch(routeAware);
    renderWithProviders(<RateLimitRulesPanel />);

    expect(await screen.findByText('Exempt')).toBeDefined();
  });

  it('mirrors the loaded layout with skeletons while rules are in flight', () => {
    stubFetch(() => new Promise<Response>(() => {}));
    const { container } = renderWithProviders(<RateLimitRulesPanel />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('refuses a platform-scoped `*` rule in the form, before the gateway has to', async () => {
    stubFetch(routeAware);
    renderWithProviders(<RateLimitRulesPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    // Tenant left empty = platform scope; `*` = every route.
    fireEvent.change(screen.getByLabelText('Route'), { target: { value: '*' } });

    expect(screen.getByText(/platform rule cannot target every route/i)).toBeDefined();
    expect((screen.getByRole('button', { name: /Create rule/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers an empty state that names what to do rather than just reporting nothing', async () => {
    stubFetch((url) => (url.includes('/rate-limit/rules') ? Response.json([]) : routeAware(url)));
    renderWithProviders(<RateLimitRulesPanel />);

    expect(await screen.findByText('No rate-limit rules')).toBeDefined();
  });
});

describe('RateLimitExplainPanel', () => {
  it('asks for a route before resolving anything', () => {
    stubFetch(routeAware);
    renderWithProviders(<RateLimitExplainPanel />);

    expect(screen.getByText('Resolve a request')).toBeDefined();
  });

  it('reports the winning level, the effective limit and how the counter is bucketed', async () => {
    stubFetch(routeAware);
    renderWithProviders(<RateLimitExplainPanel />);

    fireEvent.change(screen.getByLabelText('Path'), { target: { value: '/api/v1/auth/login' } });
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'POST' } });
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));

    // The effective limit appears twice by design: once in the summary and once
    // on the winning trace row.
    await waitFor(() => expect(screen.getAllByText('50 / 60s').length).toBeGreaterThan(0));
    expect(screen.getByText('Effective limit')).toBeDefined();
    // "Counted per tenant" is the part that explains why two callers share a
    // budget — invisible from the limit alone.
    expect(screen.getByText('Counted per')).toBeDefined();
    expect(screen.getAllByText('Tenant').length).toBeGreaterThan(0);
    expect(screen.getByText('Applied')).toBeDefined();
  });

  it('shows every losing level too, so an admin can see what would apply instead', async () => {
    stubFetch(routeAware);
    renderWithProviders(<RateLimitExplainPanel />);

    fireEvent.change(screen.getByLabelText('Path'), { target: { value: '/api/v1/auth/login' } });
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));

    await waitFor(() => expect(screen.getByText('Subscription plan')).toBeDefined());
    expect(screen.getByText('Platform route')).toBeDefined();
    expect(screen.getByText('Platform base')).toBeDefined();
  });
});

describe('RateLimitPlansPanel (US-3)', () => {
  it('shows each plan and which of the two ways it states its limit', async () => {
    stubFetch(routeAware);
    renderWithProviders(<RateLimitPlansPanel />);

    expect(await screen.findByText('STARTER')).toBeDefined();
    // A plan naming a tier inherits whatever that tier is set to; a plan with an
    // absolute value does not. Conflating them is the mistake this row prevents.
    expect(screen.getAllByText('Named tier').length).toBe(2);
    expect(screen.getByText('Absolute')).toBeDefined();
    expect(screen.getByText('5000 / 60s')).toBeDefined();
  });

  it('sends the row version so a concurrent edit is rejected rather than silently overwritten', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (method === 'PATCH') return Response.json({ ...PLANS[1], rateLimitPerMinute: 250 });
        return routeAware(url);
      }),
    );
    renderWithProviders(<RateLimitPlansPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit PRO rate limit' }));
    fireEvent.click(screen.getByLabelText(/Absolute/));
    fireEvent.change(screen.getByLabelText('Requests'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /Save plan/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.url).toContain('/rate-limit/plans/PRO');
    expect((patch.body as { expectedVersion: number }).expectedVersion).toBe(3);
    expect((patch.body as { rateLimitPerMinute: number }).rateLimitPerMinute).toBe(250);
  });

  it('clears the absolute value explicitly when switching a plan back to a named tier', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ method, body });
        if (method === 'PATCH') return Response.json(PLANS[2]);
        return routeAware(String(input));
      }),
    );
    renderWithProviders(<RateLimitPlansPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit ENTERPRISE rate limit' }));
    fireEvent.click(screen.getByLabelText(/Named tier/));
    fireEvent.click(screen.getByRole('button', { name: /Save plan/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    // Omitting the field would leave the absolute value in force and the tier
    // choice would silently do nothing.
    expect((calls.find((call) => call.method === 'PATCH')!.body as { rateLimitPerMinute: number | null }).rateLimitPerMinute).toBeNull();
  });
});

describe('RateLimitRulesPanel — editing an existing rule', () => {
  it('edits a rule’s numbers without asking the admin to delete and recreate it', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (method === 'PATCH') return Response.json({ ...RULES[1], limitValue: 75 });
        if (url.includes('/rate-limit/rules/')) return Response.json(RULES[1], { headers: { ETag: '"1"' } });
        return routeAware(url);
      }),
    );
    renderWithProviders(<RateLimitRulesPanel />);

    fireEvent.click(await screen.findByRole('button', { name: `Edit tenant rule (${TENANT}) POST:/api/v1/auth/login` }));
    fireEvent.change(screen.getByLabelText('Requests'), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: /Save rule/ }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect((calls.find((call) => call.method === 'PATCH')!.body as { limitValue: number }).limitValue).toBe(75);
  });

  it('offers tenants by name rather than asking for a raw UUID', async () => {
    stubFetch(routeAware);
    renderWithProviders(<RateLimitRulesPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'ArcaAI' })).toBeDefined());
    // The default is platform scope — the least surprising, and the one that
    // does not silently target whichever tenant happens to be first.
    expect((screen.getByLabelText('Tenant') as HTMLSelectElement).value).toBe('');
  });
});
