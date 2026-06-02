/**
 * DnaDashboardSummary smoke test (TASK-328 A5)
 *
 * Verifies the dashboard strip renders stats + chart with data, shows a
 * skeleton while loading, and an empty state when there is no activity.
 *
 * `@arcaai/vox` and `@arcaai/ui` are stubbed by the playground vitest config,
 * so we provide explicit test doubles.
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchDashboard = vi.fn().mockResolvedValue(undefined);
const useDnaDashboard = vi.fn();

vi.mock('@arcaai/vox', () => ({
  useDnaDashboard: () => useDnaDashboard(),
}));

vi.mock('@arcaai/ui', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  StatsDisplay: ({ id, stats }: any) => (
    <div data-testid="stats-display" data-id={id}>
      {stats.map((stat: { key: string; label: string; value: unknown }) => (
        <div key={stat.key} data-testid={`stat-${stat.key}`}>
          {stat.label}: {String(stat.value)}
        </div>
      ))}
    </div>
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Chart: ({ id, data }: any) => (
    <div data-testid="chart" data-id={id} data-points={data.length} />
  ),
}));

import { DnaDashboardSummary } from '../dna-dashboard-summary';

const dashboardWithData = {
  usersWithStyle: 7,
  avgVersions: 2.5,
  recentActivity: {
    dailyCounts: [
      { date: '2026-02-17', count: 3 },
      { date: '2026-02-18', count: 5 },
    ],
    latest: [],
    total: 8,
    windowDays: 30,
  },
};

const emptyDashboard = {
  usersWithStyle: 0,
  avgVersions: 0,
  recentActivity: { dailyCounts: [], latest: [], total: 0, windowDays: 30 },
};

describe('DnaDashboardSummary (TASK-328 A5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a skeleton while loading (no data yet)', () => {
    useDnaDashboard.mockReturnValue({ dashboard: null, isLoading: true, error: null, fetchDashboard });

    render(<DnaDashboardSummary tenantId="tenant-1" />);

    expect(screen.getByTestId('dna-dashboard-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  it('shows an empty state when there is no activity', () => {
    useDnaDashboard.mockReturnValue({ dashboard: emptyDashboard, isLoading: false, error: null, fetchDashboard });

    render(<DnaDashboardSummary tenantId="tenant-1" />);

    expect(screen.getByTestId('dna-dashboard-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('stats-display')).not.toBeInTheDocument();
  });

  it('renders the stat strip and chart when data is present', () => {
    useDnaDashboard.mockReturnValue({ dashboard: dashboardWithData, isLoading: false, error: null, fetchDashboard });

    render(<DnaDashboardSummary tenantId="tenant-1" />);

    expect(screen.getByTestId('dna-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('stats-display')).toBeInTheDocument();
    expect(screen.getByTestId('stat-usersWithStyle')).toHaveTextContent('Doctors with a style: 7');
    expect(screen.getByTestId('stat-avgVersions')).toHaveTextContent('Avg versions / style: 2.5');
    const chart = screen.getByTestId('chart');
    expect(chart).toBeInTheDocument();
    expect(chart).toHaveAttribute('data-points', '2');
  });

  it('fetches the dashboard for the provided tenant on mount', () => {
    useDnaDashboard.mockReturnValue({ dashboard: dashboardWithData, isLoading: false, error: null, fetchDashboard });

    render(<DnaDashboardSummary tenantId="tenant-9" />);

    expect(fetchDashboard).toHaveBeenCalledWith('tenant-9');
  });

  it('degrades to a notice when the fetch errors', () => {
    useDnaDashboard.mockReturnValue({ dashboard: null, isLoading: false, error: new Error('boom'), fetchDashboard });

    render(<DnaDashboardSummary tenantId="tenant-1" />);

    expect(screen.getByTestId('dna-dashboard-empty')).toBeInTheDocument();
  });
});
