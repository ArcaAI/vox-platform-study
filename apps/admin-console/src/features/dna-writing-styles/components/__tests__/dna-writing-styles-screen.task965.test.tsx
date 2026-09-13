/**
 * TASK-965 WS-1 (HV-9) — the DNA grid lists every report row a doctor ever had (the admin list
 * has no `isLatest` filter), but the drawer can only read the doctor's LATEST report. Clicking a
 * superseded row therefore opened a different record than the one clicked, silently. A superseded
 * row now says so and refuses to impersonate the latest one.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { DnaDashboard, DnaReport } from '../../api/types';
import { DnaWritingStylesScreen } from '../dna-writing-styles-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function report(overrides: Partial<DnaReport> = {}): DnaReport {
  return {
    id: 'rep-1',
    doctorId: 'doc-1',
    styleText: 'Formal, concise clinical prose.',
    isLatest: true,
    currentVersionNumber: 3,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    resourceStatus: 'ENABLED',
    version: 3,
    ...overrides,
  };
}

/** Two rows for ONE doctor: the current report and the one it superseded. */
const REPORTS: DnaReport[] = [report(), report({ id: 'rep-0', currentVersionNumber: 1, isLatest: false, version: 1, updatedAt: '2026-04-01T10:00:00.000Z' })];
const DASHBOARD: DnaDashboard = { usersWithStyle: 1, avgVersions: 2, recentActivity: { dailyCounts: [], latest: [], total: 2, windowDays: 30 } };

const SESSION = {
  user: { id: 'u-1', username: 'g_admin', email: 'g_admin@hope.local', roles: ['SUPER_ADMIN'] },
  isElevated: true,
  workingTenantId: 'tnt-1',
  workingTenantName: 'Sunrise Medical Group',
  impersonatingUserId: null,
  impersonatingUsername: null,
  effectiveUser: { id: 'u-1', username: 'g_admin', email: 'g_admin@hope.local', roles: ['SUPER_ADMIN'], tenantId: null, departmentId: null },
  effectiveIsElevated: true,
  effectiveTenantId: 'tnt-1',
};

function stubFetch(): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url, 'http://test.local').pathname;
      paths.push(`${init?.method ?? 'GET'} ${path}`);
      if (url.includes('/users/me/settings')) return Response.json([]);
      if (path === '/api/auth/session') return Response.json(SESSION);
      if (path === '/api/hope/admin/dna-writing-styles') return Response.json({ data: REPORTS, count: REPORTS.length, limit: 25, page: 1 });
      if (path === '/api/hope/admin/dna-writing-styles/dashboard') return Response.json(DASHBOARD);
      if (path === '/api/hope/admin/dna-writing-styles/doctor/doc-1') return Response.json(report(), { headers: { etag: '"3"' } });
      if (path === '/api/hope/admin/dna-writing-styles/rep-1/versions') return Response.json([]);
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
  return paths;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DnaWritingStylesScreen — superseded rows (TASK-965 WS-1, HV-9)', () => {
  it('marks a superseded report and refuses to open the latest one in its place', async () => {
    const paths = stubFetch();
    renderWithProviders(<DnaWritingStylesScreen />);

    // Both rows belong to doc-1; the grid lists the latest first, the superseded one second.
    const rows = await screen.findAllByText('doc-1');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Superseded')).toBeTruthy();

    fireEvent.click(rows[1]);

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/superseded/i)));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(paths.some((path) => path.endsWith('/doctor/doc-1'))).toBe(false);
  });

  it('still opens the latest report from its own row', async () => {
    stubFetch();
    renderWithProviders(<DnaWritingStylesScreen />);

    const rows = await screen.findAllByText('doc-1');
    fireEvent.click(rows[0]);

    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});
