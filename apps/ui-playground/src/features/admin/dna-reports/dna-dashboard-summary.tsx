import { Chart, StatsDisplay, type StatsDisplayProps } from '@arcaai/ui';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useDnaDashboard } from '@arcaai/vox';
import { Activity } from 'lucide-react';
import { useEffect } from 'react';

type StatItem = StatsDisplayProps['stats'][number];

/** Compact, locale-aware relative time for the recent-usage feed (e.g. "3h ago"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.round((then - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(diffSec) >= secs) return rtf.format(Math.round(diffSec / secs), unit);
  }
  return rtf.format(diffSec, 'second');
}

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
  const recent = recentActivity.latest ?? [];

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
      {/* TASK-331 doc-02 F9 — compact "Recent usage" feed from `recentActivity.latest`. */}
      {recent.length > 0 && (
        <div className="lg:col-span-2" data-testid="dna-recent-usage">
          <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">Recent usage</h3>
          <ul className="divide-border bg-card divide-y rounded-xl border">
            {recent.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 px-3 py-2 text-sm" data-testid="dna-recent-usage-item">
                <span className="bg-muted text-muted-foreground inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-mono text-xs">
                  v{entry.dnaVersionNumber ?? '—'}
                </span>
                <span className="text-foreground min-w-0 flex-1 truncate">
                  {entry.consultationId ? `Consultation ${entry.consultationId}` : `Report ${entry.dnaReportId}`}
                </span>
                <time className="text-muted-foreground shrink-0 text-xs" dateTime={entry.createdAt}>
                  {relativeTime(entry.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DashboardSkeleton() {
  // TASK-331 doc-02 F10 (rule 10) — mirror the loaded two-pane layout (stat strip
  // + chart) with <Skeleton/> placeholders instead of raw `animate-pulse` divs.
  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" data-testid="dna-dashboard-skeleton">
      <Skeleton className="h-36 rounded-xl" />
      <Skeleton className="h-36 rounded-xl" />
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
