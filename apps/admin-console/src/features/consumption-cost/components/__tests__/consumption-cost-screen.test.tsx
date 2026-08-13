/**
 * Consumption & Cost screen: KPI strip (total cost, BYOK
 * notional, mean cost/encounter, encounters), cost-by-capability chart, usage
 * detail + cost-per-encounter + top-tenants tables, empty state, the working-
 * tenant gate, and axe-cleanliness.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { renderWithProviders } from '@/test/render';

import { ConsumptionCostScreen } from '../consumption-cost-screen';

const SESSION = {
  user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['GLOBAL_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1' as string | null,
};

const SUMMARY = {
  period: '2026-08',
  periodStart: '2026-08-01T00:00:00.000Z',
  periodEnd: '2026-09-01T00:00:00.000Z',
  lines: [
    { capability: 'LLM', provider: 'openai', model: 'gpt-x', unit: 'INPUT_TOKEN', quantity: '1000', costMicros: '2000000' },
    { capability: 'STT', provider: 'whisper_cpp', model: '', unit: 'AUDIO_SECOND', quantity: '300', costMicros: '1000000' },
  ],
  totalCostMicros: '3000000',
  byokNotionalCostMicrosByCapability: { LLM: '500000' },
};

const EMPTY_SUMMARY = { ...SUMMARY, lines: [], totalCostMicros: '0', byokNotionalCostMicrosByCapability: {} };

const COST_PER_ENCOUNTER = {
  period: '2026-08',
  periodStart: '2026-08-01T00:00:00.000Z',
  periodEnd: '2026-09-01T00:00:00.000Z',
  count: 12,
  p50Micros: '250000',
  p90Micros: '400000',
  p99Micros: '600000',
  meanMicros: '250000',
  totalMicros: '3000000',
};

const TOP_TENANTS = {
  period: '2026-08',
  periodStart: '2026-08-01T00:00:00.000Z',
  periodEnd: '2026-09-01T00:00:00.000Z',
  metric: 'cost',
  tenants: [{ tenantId: 'tnt-9', costMicros: '9000000' }],
};

interface StubConfig {
  session?: typeof SESSION;
  summary?: unknown;
}

function stubFetch({ session = SESSION, summary = SUMMARY }: StubConfig = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = String(input).split('?')[0];
      if (path === '/api/auth/session') return Response.json(session);
      if (path === '/api/hope/admin/usage/summary') return Response.json(summary);
      if (path === '/api/hope/admin/usage/cost-per-encounter') return Response.json(COST_PER_ENCOUNTER);
      if (path === '/api/hope/admin/usage/top-tenants') return Response.json(TOP_TENANTS);
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConsumptionCostScreen', () => {
  it('renders KPIs, the usage detail and the cost-by-capability chart', async () => {
    stubFetch();
    renderWithProviders(<ConsumptionCostScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Consumption & Cost' })).toBeDefined();
    // Total cost = 3,000,000 micros = $3.00 (KPI + the cost-per-encounter total row).
    expect((await screen.findAllByText('$3.00')).length).toBeGreaterThan(0);
    // BYOK notional = 500,000 micros = $0.50.
    expect(await screen.findByText('$0.50')).toBeDefined();
    // Capabilities appear in the usage detail table + the chart's sr-only table.
    expect((await screen.findAllByText('LLM')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('STT')).length).toBeGreaterThan(0);
    // The cost-by-capability chart exposes its accessible label.
    expect(await screen.findByRole('img', { name: 'INTERNAL-basis rated cost by AI capability for the working tenant this period' })).toBeDefined();
    // The cross-tenant top-spenders section.
    expect(await screen.findByText('tnt-9')).toBeDefined();
  });

  it('shows the empty state when the tenant has no metered usage this period', async () => {
    stubFetch({ summary: EMPTY_SUMMARY });
    renderWithProviders(<ConsumptionCostScreen />);

    expect(await screen.findByText('No metered usage this period')).toBeDefined();
  });

  it('gates an elevated session without a working tenant behind the NoTenant empty state', async () => {
    stubFetch({ session: { ...SESSION, workingTenantId: null, workingTenantName: null, effectiveTenantId: null } });
    renderWithProviders(<ConsumptionCostScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
  });

  it('has no axe violations with the cost panels rendered', async () => {
    stubFetch();
    const { container } = renderWithProviders(<ConsumptionCostScreen />);
    await screen.findAllByText('$3.00');
    expect(await axe(container)).toHaveNoViolations();
  });
});
