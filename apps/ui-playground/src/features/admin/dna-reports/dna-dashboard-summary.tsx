import { Chart, StatsDisplay, type StatsDisplayProps } from '@arcaai/ui';
import { useDnaDashboard } from '@arcaai/vox';
import { Activity } from 'lucide-react';
import { useEffect } from 'react';

type StatItem = StatsDisplayProps['stats'][number];

/**
 * TASK-328 A5 — DNA aggregate dashboard strip.
 *
 * Sits ABOVE the report browser. Reads `useDnaDashboard` (@arcaai/vox) and shows
 * a stat strip + a daily-usage chart. Tenant scoping is server-side: a global
 * admin passes `tenantId`; a tenant admin's CLS tenant wins (the arg is ignored).
 */
export function DnaDashboardSummary({ tenantId }: { tenantId?: string }) {
  const { dashboard, isLoading, error, fetchDashboard } = useDnaDashboard();

  useEffect(() => {
    // Errors are surfaced via the `error` state below; swallow the rejection so
    // an unhandled promise doesn't escape the effect.
    void fetchDashboard(tenantId || undefined).catch(() => undefined);
  }, [fetchDashboard, tenantId]);

  if (isLoading && !dashboard) {
    return <DashboardSkeleton />;
  }

  // A soft failure must not block the report browser below — degrade to a
  // lightweight notice rather than throwing.
  if (error && !dashboard) {
    return <DashboardNotice message="Couldn't load DNA usage metrics." />;
  }

  if (!dashboard) {
    return null;
  }

  const { usersWithStyle, avgVersions, recentActivity } = dashboard;
  const hasData = usersWithStyle > 0 || recentActivity.total > 0;

  if (!hasData) {
    return <DashboardNotice message="No DNA writing-style activity yet." />;
  }

  const stats: StatItem[] = [
    { key: 'usersWithStyle', label: 'Doctors with a style', value: usersWithStyle, format: { kind: 'number' } },
    { key: 'avgVersions', label: 'Avg versions / style', value: avgVersions, format: { kind: 'number', decimals: 2 } },
    { key: 'recentUsage', label: `Usage (last ${recentActivity.windowDays}d)`, value: recentActivity.total, format: { kind: 'number' } },
  ];

  // `MM-DD` keeps the x-axis readable; the full date stays in the tooltip key.
  const chartData = recentActivity.dailyCounts.map((point) => ({ date: point.date.slice(5), count: point.count }));

  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" data-testid="dna-dashboard">
      <StatsDisplay id="dna-dashboard-stats" title="DNA Writing Styles" stats={stats} />
      {chartData.length > 0 ? (
        <Chart
          id="dna-usage-chart"
          type="bar"
          title="Recent usage"
          description={`Daily DNA-style usage over the last ${recentActivity.windowDays} days`}
          data={chartData}
          xKey="date"
          series={[{ key: 'count', label: 'Usage' }]}
        />
      ) : (
        <DashboardNotice message="No usage in the recent window." />
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" data-testid="dna-dashboard-skeleton">
      <div className="bg-muted/40 h-36 animate-pulse rounded-xl border" />
      <div className="bg-muted/40 h-36 animate-pulse rounded-xl border" />
    </div>
  );
}

function DashboardNotice({ message }: { message: string }) {
  return (
    <div
      className="bg-muted/20 text-muted-foreground mb-6 flex items-center gap-2 rounded-xl border border-dashed p-4 text-sm"
      data-testid="dna-dashboard-empty"
    >
      <Activity className="size-4" />
      {message}
    </div>
  );
}
