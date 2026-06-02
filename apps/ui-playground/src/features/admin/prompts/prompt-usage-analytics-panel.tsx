import { Skeleton } from '@arcaai/ui/skeleton';
import { BarChart3 } from 'lucide-react';

import { usePromptUsageAnalytics } from '../api/prompts';

interface PromptUsageAnalyticsPanelProps {
  tenantId: string;
  /** Optional: scope analytics to a single template. */
  promptTemplateId?: string;
}

interface BarRow {
  label: string;
  count: number;
}

function BarGroup({ title, rows }: { title: string; rows: BarRow[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;
  return (
    <div className="rounded-lg border p-3">
      <h5 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h5>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">No usage recorded.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-xs" title={r.label}>
                {r.label}
              </span>
              <div className="bg-muted/40 relative h-4 flex-1 overflow-hidden rounded">
                <div
                  className="bg-primary/70 absolute inset-y-0 left-0 rounded"
                  style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }}
                  role="meter"
                  aria-valuenow={r.count}
                  aria-valuemin={0}
                  aria-valuemax={max}
                  aria-label={`${r.label}: ${r.count}`}
                />
              </div>
              <span className="w-8 shrink-0 text-right text-xs font-medium tabular-nums">{r.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * TASK-328 A4 — usage analytics grouped by department / doctor / day.
 * A dependency-free horizontal bar view (recharts renders empty in jsdom,
 * so plain `@arcaai/ui`+tailwind bars keep the view testable + portable).
 */
export function PromptUsageAnalyticsPanel({ tenantId, promptTemplateId }: PromptUsageAnalyticsPanelProps) {
  const { data, isLoading, isError } = usePromptUsageAnalytics(tenantId, promptTemplateId);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border p-4" aria-busy="true">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border p-4">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <BarChart3 className="size-4" /> Usage Analytics
        </h4>
        <p className="text-muted-foreground mt-2 text-sm">Unable to load usage analytics.</p>
      </div>
    );
  }

  const byDepartment: BarRow[] = data.byDepartment.map((d) => ({ label: d.departmentId ?? 'Unassigned', count: d.count }));
  const byDoctor: BarRow[] = data.byDoctor.map((d) => ({ label: d.doctorId ?? 'Unattributed', count: d.count }));
  const byDay: BarRow[] = data.byDay.map((d) => ({ label: d.day, count: d.count }));

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <BarChart3 className="size-4" /> Usage Analytics
        </h4>
        <span className="text-muted-foreground text-xs">{data.totalUsages} total uses</span>
      </div>

      {data.totalUsages === 0 ? (
        <p className="text-muted-foreground text-sm">No usage has been recorded for this prompt yet.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          <BarGroup title="By Department" rows={byDepartment} />
          <BarGroup title="By Doctor" rows={byDoctor} />
          <BarGroup title="By Day" rows={byDay} />
        </div>
      )}
    </div>
  );
}
