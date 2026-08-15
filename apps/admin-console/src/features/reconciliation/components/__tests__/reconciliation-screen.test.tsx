/**
 * Provider-reconciliation audit trail screen.
 *
 * What is worth pinning here is the SEMANTICS the trail exists for: a skipped
 * run must show WHY (that is the actionable part today, since no vendor
 * credential is provisioned), null must never render as 0, and a breach must be
 * visible without reading the number.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { renderWithProviders } from '@/test/render';

import { ReconciliationScreen } from '../reconciliation-screen';

const SESSION = {
  user: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1' as string | null,
  workingTenantName: 'ArcaAI' as string | null,
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'super_admin', email: 'admin@arca.ai', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1' as string | null,
};

const SKIPPED = {
  id: 'r-1',
  provider: 'openai',
  window: '2026-08-05',
  windowStart: '2026-08-05T00:00:00.000Z',
  windowEnd: '2026-08-06T00:00:00.000Z',
  status: 'skipped',
  reason: 'no credential at OPENAI_ADMIN_API_KEY (read-only scope)',
  ledgerQuantity: null,
  providerQuantity: null,
  providerUnit: null,
  relativeDrift: null,
  breachedThreshold: false,
  thresholdPct: 2,
  runAt: '2026-08-08T09:00:00.000Z',
};

const BREACHED = {
  ...SKIPPED,
  id: 'r-2',
  provider: 'anthropic',
  status: 'reconciled',
  reason: null,
  ledgerQuantity: '1000',
  providerQuantity: '1500',
  providerUnit: 'tokens',
  relativeDrift: '0.5',
  breachedThreshold: true,
};

const runCalls: string[] = [];

function stubFetch(runs: unknown[] = [SKIPPED, BREACHED]) {
  runCalls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).split('?')[0];
      if (path === '/api/auth/session') return Response.json(SESSION);
      if (path === '/api/hope/admin/usage/reconciliation/latest') return Response.json([BREACHED]);
      if (path === '/api/hope/admin/usage/reconciliation/runs') return Response.json(runs);
      if (path === '/api/hope/admin/usage/reconciliation/run') {
        runCalls.push(String(init?.method));
        return Response.json({ window: '2026-08-05', reconciled: 1, skipped: 3, failed: 0, breaches: 1 });
      }
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReconciliationScreen', () => {
  it('shows WHY a run was skipped — the actionable part while no credential exists', async () => {
    stubFetch();
    renderWithProviders(<ReconciliationScreen />);

    expect(await screen.findByText(/no credential at OPENAI_ADMIN_API_KEY/)).toBeDefined();
    expect(screen.getAllByText('skipped').length).toBeGreaterThan(0);
  });

  it('renders an em-dash, never 0, where no comparison happened', async () => {
    stubFetch([SKIPPED]);
    renderWithProviders(<ReconciliationScreen />);

    await screen.findByText(/no credential at OPENAI_ADMIN_API_KEY/);
    // A rendered "0" would read as "the vendor billed nothing" — a different claim.
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('marks a threshold breach visibly, with the threshold that was in force', async () => {
    stubFetch();
    renderWithProviders(<ReconciliationScreen />);

    // Appears twice by design: the per-provider status board and the run row.
    expect((await screen.findAllByText('+50.0%')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/\(>2%\)/).length).toBeGreaterThan(0);
  });

  it('triggers a sweep on "Run now" and reports the outcome', async () => {
    stubFetch();
    renderWithProviders(<ReconciliationScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(runCalls).toEqual(['POST']));
  });

  it('explains the empty state instead of showing a blank table', async () => {
    stubFetch([]);
    renderWithProviders(<ReconciliationScreen />);

    expect(await screen.findByText('No reconciliation runs yet')).toBeDefined();
  });

  it('has no axe violations', async () => {
    stubFetch();
    const { container } = renderWithProviders(<ReconciliationScreen />);
    await screen.findAllByText('+50.0%');

    expect(await axe(container)).toHaveNoViolations();
  });
});
