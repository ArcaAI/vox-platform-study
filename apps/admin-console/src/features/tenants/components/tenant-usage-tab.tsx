'use client';

import { Card } from '@arcaai/ui/components/shadcn/card';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatBytes, formatNumber, formatPercent } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useTenantStorageBreakdown, useTenantUsage } from '../api/hooks';

/** TASK-959 — fixed-point decimal-string GB -> "1.23 GB"; extra precision under 1 GB so a small figure doesn't round to "0.00 GB". */
function formatDecimalGb(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  const decimals = Math.abs(n) < 1 ? 4 : 2;
  return `${n.toFixed(decimals)} GB`;
}

/** Frame 12.1 usage tab: stat tiles + storage quota bar. */
export function TenantUsageTab({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useTenantUsage(id);
  // TASK-959 — a SEPARATE, silently-degrading read: the per-class split is a
  // nicety beside the primary `Media.size` figure above, never a reason to
  // block this tab on a caller without `manage:UsageAnalytics`.
  const storageBreakdown = useTenantStorageBreakdown(id);

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
    );
  }
  if (error || !data) {
    return <ErrorState error={error} onRetry={() => refetch()} />;
  }

  const tiles = [
    { label: 'Users', value: formatNumber(data.totalUsers) },
    { label: 'Departments', value: formatNumber(data.totalDepartments) },
    { label: 'Consultations', value: formatNumber(data.totalConsultations) },
    { label: 'Transcription minutes', value: formatNumber(data.transcriptionMinutes) },
    { label: 'Summaries (24h)', value: formatNumber(data.summaries24h) },
    { label: 'Prompt templates', value: formatNumber(data.totalPromptTemplates) },
    { label: 'Pipelines', value: formatNumber(data.totalPipelines) },
  ];
  const quota = data.storageQuotaBytes;
  const usedPercent = quota ? (data.storageUsedBytes / quota) * 100 : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Card key={tile.label} className="gap-1 p-4">
            <div className="text-muted-foreground text-xs font-medium">{tile.label}</div>
            <div className="text-2xl font-medium tabular-nums">{tile.value}</div>
          </Card>
        ))}
      </div>
      <Card className="gap-2 p-4">
        <div className="text-muted-foreground text-xs font-medium">Storage used</div>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-2xl font-medium tabular-nums">{formatBytes(data.storageUsedBytes)}</span>
          <span className="text-muted-foreground text-sm">
            {quota ? `of ${formatBytes(quota)} quota (${formatPercent(usedPercent)})` : 'no quota set'}
          </span>
        </div>
        {usedPercent !== null ? <Progress aria-label="Storage used" value={Math.min(usedPercent, 100)} /> : null}
        {storageBreakdown.data?.storage ? (
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-xs">
            <span>Media {formatDecimalGb(storageBreakdown.data.storage.mediaGb)}</span>
            <span>Text {formatDecimalGb(storageBreakdown.data.storage.textGb)}</span>
            <span>Claim-check {formatDecimalGb(storageBreakdown.data.storage.claimCheckGb)}</span>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
