/**
 * Consumption & Cost screen: KPI strip (total cost, BYOK
 * notional, mean cost/encounter, encounters), cost-by-capability chart, usage
 * detail + cost-per-encounter + top-tenants tables, empty state, the working-
 * tenant gate, and axe-cleanliness.
 */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { renderWithProviders } from '@/test/render';

import { ConsumptionCostScreen } from '../consumption-cost-screen';

const SESSION = {
  user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'Sunrise Medical Group' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
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

/**
 * TASK-958 D-7 — with two accounts of one vendor on a tenant, `provider` is no
 * longer an answer to "which key did this spend?". The usage line carries
 * `connectionId` and the table resolves it to the connection a tenant admin
 * named.
 *
 * The column is rendered ONLY when the field is PRESENT: a gateway that does not
 * yet serve it (Lane B2 is not merged) must not grow a column of dashes, and an
 * absent field is not the same answer as a platform-funded null.
 */
const SUMMARY_WITH_CONNECTIONS = {
  ...SUMMARY,
  lines: [
    { capability: 'LLM', provider: 'openai', model: 'gpt-x', unit: 'INPUT_TOKEN', quantity: '1000', costMicros: '2000000', connectionId: 'conn-2' },
    { capability: 'LLM', provider: 'openai', model: 'gpt-x', unit: 'INPUT_TOKEN', quantity: '500', costMicros: '500000', connectionId: 'conn-unknown-id-7f3a' },
    { capability: 'STT', provider: 'whisper_cpp', model: '', unit: 'AUDIO_SECOND', quantity: '300', costMicros: '1000000', connectionId: null },
  ],
};

const CONNECTIONS: Record<string, unknown[]> = {
  llm: [
    { id: 'conn-1', tenantId: 'tnt-1', service: 'llm', provider: 'openai', slug: 'openai', name: 'Production account', isDefault: true },
    { id: 'conn-2', tenantId: 'tnt-1', service: 'llm', provider: 'openai', slug: 'openai-research', name: 'Research account', isDefault: false },
  ],
  stt: [],
  tts: [],
};

function stubFetchWithConnections(summary: unknown = SUMMARY_WITH_CONNECTIONS) {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = String(input).split('?')[0]!;
      paths.push(path);
      if (path === '/api/auth/session') return Response.json(SESSION);
      if (path === '/api/hope/admin/usage/summary') return Response.json(summary);
      if (path === '/api/hope/admin/usage/cost-per-encounter') return Response.json(COST_PER_ENCOUNTER);
      if (path === '/api/hope/admin/usage/top-tenants') return Response.json(TOP_TENANTS);
      if (path.startsWith('/api/hope/admin/providers/')) {
        return Response.json(CONNECTIONS[path.replace('/api/hope/admin/providers/', '')] ?? []);
      }
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
  return paths;
}

describe('ConsumptionCostScreen — which connection spent this (958 D-7)', () => {
  it('names the connection on a BYO line, and says "platform" where none funded it', async () => {
    stubFetchWithConnections();
    renderWithProviders(<ConsumptionCostScreen />);

    const table = await screen.findByRole('table', { name: /Usage detail/ });
    await waitFor(() => expect(within(table).getByText('Research account')).toBeDefined());
    expect(within(table).getByRole('columnheader', { name: 'Connection' })).toBeDefined();
    // An id the provider lists do not carry still identifies the row — 8 chars
    // of the id beat an em dash, which would read as "platform-funded".
    expect(within(table).getByText('conn-unk')).toBeDefined();
    // `connectionId: null` IS an answer: the platform's own credential served it.
    expect(within(table).getAllByText('Platform').length).toBe(1);
  });

  it('renders NO Connection column when the gateway does not carry the field', async () => {
    stubFetch();
    renderWithProviders(<ConsumptionCostScreen />);

    const table = await screen.findByRole('table', { name: /Usage detail/ });
    expect(within(table).queryByRole('columnheader', { name: 'Connection' })).toBeNull();
  });

  it('does not read the provider lists at all when no line carries a connection', async () => {
    const paths = stubFetchWithConnections(SUMMARY);
    renderWithProviders(<ConsumptionCostScreen />);
    await screen.findByRole('table', { name: /Usage detail/ });

    expect(paths.some((path) => path.startsWith('/api/hope/admin/providers/'))).toBe(false);
  });
});
