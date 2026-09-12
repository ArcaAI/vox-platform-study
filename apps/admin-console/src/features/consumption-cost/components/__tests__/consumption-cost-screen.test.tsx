/**
 * Consumption & Cost screen: KPI strip (total cost, BYOK
 * notional, mean cost/encounter, encounters), cost-by-capability chart, usage
 * detail + cost-per-encounter + top-tenants tables, empty state, the working-
 * tenant gate, and axe-cleanliness.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  // TASK-959 — compute, network and storage (§10.2 wire contract).
  computeSeconds: { gpuSeconds: '12.500000', cpuSeconds: '3.250000' },
  workflowCpuSeconds: '0.750000',
  thirdPartyBytes: { egressBytes: '1073741824.000000', ingressBytes: '2147483648.000000' },
  storage: { mediaGb: '1.500000', textGb: '0.250000', claimCheckGb: '0.010000', totalGb: '1.760000', asOf: '2026-08-30T23:59:59.999Z' },
};

const EMPTY_SUMMARY = { ...SUMMARY, lines: [], totalCostMicros: '0', byokNotionalCostMicrosByCapability: {} };

/** GET admin/usage/timeseries for SUMMARY's default series (LLM's only line, INPUT_TOKEN). */
const TIMESERIES = {
  capability: 'LLM',
  unit: 'INPUT_TOKEN',
  granularity: 'day',
  from: SUMMARY.periodStart,
  to: SUMMARY.periodEnd,
  points: [
    {
      bucketStart: '2026-08-01T00:00:00.000Z',
      quantity: '500',
      costMicros: '1000000',
      computeSeconds: { gpuSeconds: '12.500000', cpuSeconds: '3.250000' },
      workflowCpuSeconds: '0.750000',
      thirdPartyBytes: { egressBytes: '1073741824.000000', ingressBytes: '2147483648.000000' },
      storageGb: '1.760000',
    },
  ],
};

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
  timeseries?: unknown;
}

function stubFetch({ session = SESSION, summary = SUMMARY, timeseries = TIMESERIES }: StubConfig = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = String(input).split('?')[0];
      if (path === '/api/auth/session') return Response.json(session);
      if (path === '/api/hope/admin/usage/summary') return Response.json(summary);
      if (path === '/api/hope/admin/usage/cost-per-encounter') return Response.json(COST_PER_ENCOUNTER);
      if (path === '/api/hope/admin/usage/top-tenants') return Response.json(TOP_TENANTS);
      if (path === '/api/hope/admin/usage/timeseries') return Response.json(timeseries);
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
 * TASK-959 — the compute/network/storage cards and the usage-over-time
 * chart. All four figures ride on `UsageSummaryResponse` fields this ticket
 * added (§10.2); the fixtures above already carry them for every other test
 * in this file, which is itself a regression check that the new fields
 * don't disturb the existing KPIs/tables/chart.
 */
describe('ConsumptionCostScreen — compute, network and storage (959)', () => {
  it('renders the Compute, Third-party network and Storage cards from the summary', async () => {
    stubFetch();
    renderWithProviders(<ConsumptionCostScreen />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Compute' })).toBeDefined();
    expect(await screen.findByText('12.500 s')).toBeDefined(); // GPU seconds
    expect(screen.getByText('3.250 s')).toBeDefined(); // CPU seconds
    expect(screen.getByText('0.750 s')).toBeDefined(); // workflow-worker CPU, its own line

    expect(screen.getByRole('heading', { level: 2, name: 'Third-party network' })).toBeDefined();
    expect(await screen.findByText('1 GB')).toBeDefined(); // egress, 1 GiB
    expect(screen.getByText('2 GB')).toBeDefined(); // ingress, 2 GiB

    expect(screen.getByRole('heading', { level: 2, name: 'Storage' })).toBeDefined();
    expect(await screen.findByText('1.50 GB')).toBeDefined(); // media
    expect(screen.getByText('0.2500 GB')).toBeDefined(); // text — sub-1GB precision
    expect(screen.getByText('0.0100 GB')).toBeDefined(); // claim-check
    expect(screen.getByText('1.76 GB')).toBeDefined(); // total
  });

  it('shows the byte formatter\'s raw value on hover', async () => {
    stubFetch();
    renderWithProviders(<ConsumptionCostScreen />);

    const egress = await screen.findByText('1 GB');
    expect(egress.getAttribute('title')).toBe('1073741824.000000 bytes');
  });

  it('renders "No snapshot yet" instead of a blank card when storage is null', async () => {
    stubFetch({ summary: { ...SUMMARY, storage: null } });
    renderWithProviders(<ConsumptionCostScreen />);

    expect(await screen.findByText('No snapshot yet')).toBeDefined();
    // The rows that WOULD have rendered from a real snapshot must not appear.
    expect(screen.queryByText('1.50 GB')).toBeNull();
  });

  it('shows the usage-over-time chart with only the selected series on by default, and toggles a new series on', async () => {
    stubFetch();
    renderWithProviders(<ConsumptionCostScreen />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Usage over time' })).toBeDefined();
    const table = await screen.findByRole('table', { name: /usage by day/i });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['bucketStart', 'LLM · INPUT_TOKEN']);

    // The new compute/storage series start OFF — checked here BEFORE any click.
    expect(screen.getByRole('checkbox', { name: 'GPU seconds' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('checkbox', { name: 'Selected usage' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('checkbox', { name: 'GPU seconds' }));

    await waitFor(() => {
      const updated = screen.getByRole('table', { name: /usage by day/i });
      expect(within(updated).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['bucketStart', 'LLM · INPUT_TOKEN', 'GPU seconds']);
    });
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
const SYSTEM_TENANT = '00000000-0000-0000-0000-000000000000';

const SUMMARY_WITH_CONNECTIONS = {
  ...SUMMARY,
  lines: [
    { capability: 'LLM', provider: 'openai', model: 'gpt-x', unit: 'INPUT_TOKEN', quantity: '1000', costMicros: '2000000', connectionId: 'conn-2' },
    { capability: 'LLM', provider: 'openai', model: 'gpt-x', unit: 'INPUT_TOKEN', quantity: '500', costMicros: '500000', connectionId: 'conn-unknown-id-7f3a' },
    { capability: 'STT', provider: 'whisper_cpp', model: '', unit: 'AUDIO_SECOND', quantity: '300', costMicros: '1000000', connectionId: null },
  ],
};

/**
 * A PLATFORM-funded line. The ledger stamps the SYSTEM row's `connectionId` on
 * it — only a self-hosted engine yields `null` — so a platform-funded generation
 * arrives as an id like any other, and resolving it against the TENANT's lists
 * alone leaves it unnamed.
 */
const SUMMARY_WITH_PLATFORM_LINE = {
  ...SUMMARY,
  lines: [
    { capability: 'LLM', provider: 'openai', model: 'gpt-x', unit: 'INPUT_TOKEN', quantity: '1000', costMicros: '2000000', connectionId: 'conn-2' },
    { capability: 'LLM', provider: 'openai', model: 'gpt-x', unit: 'INPUT_TOKEN', quantity: '400', costMicros: '400000', connectionId: 'conn-sys-openai-9d21' },
    { capability: 'TTS', provider: 'azure', model: 'neural', unit: 'CHARACTER', quantity: '900', costMicros: '90000', connectionId: 'conn-sys-azure-4b07' },
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

/**
 * `GET admin/providers/:service/platform-defaults` — the SYSTEM tier's rows for
 * this service, annotated with the cascade's verdict. A placeholder (`version: 0`,
 * no `id`) is what the platform has no row for, and it names nothing.
 */
const PLATFORM_DEFAULTS: Record<string, unknown> = {
  llm: {
    service: 'llm',
    tenantId: 'tnt-1',
    entitled: true,
    connections: [
      { id: 'conn-sys-openai-9d21', tenantId: SYSTEM_TENANT, service: 'llm', provider: 'openai', slug: 'openai', name: null, version: 3, resolution: 'inherited' },
      { tenantId: SYSTEM_TENANT, service: 'llm', provider: 'anthropic', slug: 'anthropic', name: null, version: 0, resolution: 'not-configured' },
    ],
  },
  tts: {
    service: 'tts',
    tenantId: 'tnt-1',
    entitled: true,
    connections: [
      { id: 'conn-sys-azure-4b07', tenantId: SYSTEM_TENANT, service: 'tts', provider: 'azure', slug: 'azure', name: null, version: 2, resolution: 'inherited' },
    ],
  },
  stt: { service: 'stt', tenantId: 'tnt-1', entitled: true, connections: [] },
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
      if (path.endsWith('/platform-defaults')) {
        const service = path.replace('/api/hope/admin/providers/', '').replace('/platform-defaults', '');
        return Response.json(PLATFORM_DEFAULTS[service] ?? { connections: [] });
      }
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

/**
 * TASK-958 (wire review #6) — a PLATFORM credential is not an unnamed tenant one.
 *
 * A platform-funded generation carries the SYSTEM row's `connectionId`; only a
 * self-hosted engine yields `null`. Resolving that id against the tenant's own
 * lists finds nothing, so the column fell back to 8 characters of a UUID — which
 * reads as "a connection of yours we could not name" for a row the tenant does
 * not own and cannot name. The platform-defaults list is the other half of the
 * cascade the column is describing, so it is read alongside.
 */
describe('ConsumptionCostScreen — a platform-funded line says so (958 wire review #6)', () => {
  it('names the SYSTEM row as the platform, not as an unresolved id', async () => {
    stubFetchWithConnections(SUMMARY_WITH_PLATFORM_LINE);
    renderWithProviders(<ConsumptionCostScreen />);

    const table = await screen.findByRole('table', { name: /Usage detail/ });
    await waitFor(() => expect(within(table).getByText('Platform · openai')).toBeDefined());
    // The second capability proves the read is per-service, not an llm-only patch.
    expect(within(table).getByText('Platform · azure')).toBeDefined();
    // The tenant's own row keeps the name the tenant gave it.
    expect(within(table).getByText('Research account')).toBeDefined();
    // And neither platform id leaks as a truncated UUID.
    expect(within(table).queryByText('conn-sys')).toBeNull();
  });

  it('still shortens an id that belongs to NEITHER tier', async () => {
    stubFetchWithConnections();
    renderWithProviders(<ConsumptionCostScreen />);

    const table = await screen.findByRole('table', { name: /Usage detail/ });
    await waitFor(() => expect(within(table).getByText('Research account')).toBeDefined());
    expect(within(table).getByText('conn-unk')).toBeDefined();
  });

  it('reads the platform defaults only when a line carries a connection', async () => {
    const paths = stubFetchWithConnections(SUMMARY);
    renderWithProviders(<ConsumptionCostScreen />);
    await screen.findByRole('table', { name: /Usage detail/ });

    expect(paths.some((path) => path.endsWith('/platform-defaults'))).toBe(false);
  });
});
