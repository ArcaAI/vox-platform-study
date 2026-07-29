/**
 * TDD screen tests screen 2 (AI Operations — Metrics): KPI strip
 * (median TTFT, avg tok/s, regeneration rate, gate pending), stop-reason / TTFT
 * charts from the generation-metrics aggregate, empty state, working-
 * tenant gate, and axe-cleanliness.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { AiOperationsMetricsScreen } from '../ai-operations-metrics-screen';

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

const GENERATION_AGGREGATE = {
  sampleCount: 2,
  ttftMedianMs: 160,
  ttftP95Ms: 196,
  tokensPerSecondAvg: 50,
  stopReasons: [
    { reason: 'length', count: 1 },
    { reason: 'stop', count: 1 },
  ],
};

const EMPTY_GENERATION = {
  sampleCount: 0,
  ttftMedianMs: null,
  ttftP95Ms: null,
  tokensPerSecondAvg: null,
  stopReasons: [],
};

const GATE_QUEUE = {
  items: [
    {
      consultationId: 'c-1',
      status: 'PENDING_REVIEW',
      pendingSince: '2026-07-01T00:00:00.000Z',
      ageSeconds: 60,
      generateCount: 3,
      regenCount: 1,
      slaDueAt: '2026-07-02T00:00:00.000Z',
      escalationDueAt: '2026-07-01T12:00:00.000Z',
      slaBreached: false,
      escalated: false,
    },
    {
      consultationId: 'c-2',
      status: 'PENDING_REVIEW',
      pendingSince: '2026-06-30T00:00:00.000Z',
      ageSeconds: 90,
      generateCount: 1,
      regenCount: 1,
      slaDueAt: '2026-07-02T00:00:00.000Z',
      escalationDueAt: '2026-07-01T12:00:00.000Z',
      slaBreached: false,
      escalated: false,
    },
  ],
  total: 2,
  slaBreachedCount: 0,
  escalatedCount: 0,
  gateSlaSeconds: 86400,
  gateEscalationSeconds: 43200,
  policySource: 'tenant',
};

interface StubConfig {
  session?: typeof SESSION;
  generation?: unknown;
  gate?: unknown;
}

function stubFetch({ session = SESSION, generation = GENERATION_AGGREGATE, gate = GATE_QUEUE }: StubConfig = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = String(input).split('?')[0];
      if (path === '/api/auth/session') return Response.json(session);
      if (path === '/api/hope/admin/agent-trajectory/metrics/generation') return Response.json(generation);
      if (path === '/api/hope/admin/harness/gate-queue') return Response.json(gate);
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AiOperationsMetricsScreen', () => {
  it('renders KPIs from the generation-metrics aggregate + the gate queue', async () => {
    stubFetch();
    renderWithProviders(<AiOperationsMetricsScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'AI Operations — Metrics' })).toBeDefined();
    // Median TTFT of the server aggregate = 160 ms (KPI card + the chart's sr-only table).
    expect((await screen.findAllByText('160 ms')).length).toBeGreaterThan(0);
    // Regen rate = 2 regens / 4 generations = 50%.
    expect(await screen.findByText('50%')).toBeDefined();
    // Stop-reason chart (role=img) exposes an sr-only data table with the reasons.
    expect(await screen.findByRole('img', { name: 'LLM stop-reason distribution across sampled steps' })).toBeDefined();
  });

  it('shows the empty state when the aggregate reports zero samples', async () => {
    stubFetch({ generation: EMPTY_GENERATION });
    renderWithProviders(<AiOperationsMetricsScreen />);

    expect(await screen.findByText('No agentic runs yet')).toBeDefined();
  });

  it('gates an elevated session without a working tenant behind the NoTenant empty state', async () => {
    stubFetch({ session: { ...SESSION, workingTenantId: null, workingTenantName: null, effectiveTenantId: null } });
    renderWithProviders(<AiOperationsMetricsScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
  });

  it('has no axe violations with the aggregate panels rendered', async () => {
    stubFetch();
    const { container } = renderWithProviders(<AiOperationsMetricsScreen />);
    await screen.findAllByText('160 ms');
    expect(await axe(container)).toHaveNoViolations();
  });
});
