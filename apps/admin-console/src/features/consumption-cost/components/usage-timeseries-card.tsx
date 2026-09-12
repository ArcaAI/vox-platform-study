'use client';

import { useMemo, useState } from 'react';

import { MetricChart } from '@arcaai/ui/components/metrics';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Label } from '@arcaai/ui/components/shadcn/label';

import { pickDefaultSeries } from '../api/aggregate';
import { useUsageTimeseries } from '../api/hooks';
import type { UsageSummaryLine } from '../api/types';

/**
 * TASK-959 — "Usage over time", the one series the screen already knows how
 * to pick (the highest-cost capability x unit, `pickDefaultSeries`) drawn
 * daily across the billing period, with the new compute/network/storage
 * figures as optional overlays for correlation — the backend's own framing
 * ("draws the selected series against the platform cost that moved with
 * it", `AdminUsageController.timeseries`'s summary).
 *
 * No timeseries chart existed on this screen before this ticket — `admin/
 * usage/timeseries` was wired by the gateway lane but never consumed here.
 * The base series (the tenant's own selected usage) is on by DEFAULT; every
 * new companion series starts OFF, per the ticket's ask.
 */

type SeriesKey = 'quantity' | 'gpuSeconds' | 'cpuSeconds' | 'workflowCpuSeconds' | 'storageGb';

interface SeriesToggle {
  key: SeriesKey;
  label: string;
  defaultOn: boolean;
}

const TOGGLES: SeriesToggle[] = [
  { key: 'quantity', label: 'Selected usage', defaultOn: true },
  { key: 'gpuSeconds', label: 'GPU seconds', defaultOn: false },
  { key: 'cpuSeconds', label: 'CPU seconds', defaultOn: false },
  { key: 'workflowCpuSeconds', label: 'Workflow CPU seconds', defaultOn: false },
  { key: 'storageGb', label: 'Storage (GB)', defaultOn: false },
];

interface ChartRow extends Record<string, string | number> {
  bucketStart: string;
  quantity: number;
  gpuSeconds: number;
  cpuSeconds: number;
  workflowCpuSeconds: number;
  storageGb: number;
}

export function UsageTimeseriesCard({
  lines,
  periodStart,
  periodEnd,
}: {
  lines: readonly UsageSummaryLine[];
  periodStart: string | undefined;
  periodEnd: string | undefined;
}) {
  const [enabled, setEnabled] = useState<Record<SeriesKey, boolean>>(() =>
    Object.fromEntries(TOGGLES.map((toggle) => [toggle.key, toggle.defaultOn])) as Record<SeriesKey, boolean>,
  );

  const defaultSeries = useMemo(() => pickDefaultSeries(lines), [lines]);
  const params = useMemo(
    () =>
      defaultSeries && periodStart && periodEnd
        ? { capability: defaultSeries.capability, unit: defaultSeries.unit, granularity: 'day' as const, from: periodStart, to: periodEnd }
        : undefined,
    [defaultSeries, periodStart, periodEnd],
  );

  const timeseries = useUsageTimeseries(!!params, params);

  const chartData = useMemo<ChartRow[]>(
    () =>
      (timeseries.data?.points ?? []).map((point) => ({
        bucketStart: point.bucketStart.slice(0, 10),
        quantity: Number(point.quantity),
        gpuSeconds: Number(point.computeSeconds.gpuSeconds),
        cpuSeconds: Number(point.computeSeconds.cpuSeconds),
        workflowCpuSeconds: Number(point.workflowCpuSeconds),
        storageGb: point.storageGb === null ? 0 : Number(point.storageGb),
      })),
    [timeseries.data],
  );

  const activeSeries = TOGGLES.filter((toggle) => enabled[toggle.key]).map((toggle) => ({
    key: toggle.key,
    label: toggle.key === 'quantity' && defaultSeries ? `${defaultSeries.capability} · ${defaultSeries.unit}` : toggle.label,
  }));

  // Nothing to chart until at least one usage line exists — the screen's own
  // "No metered usage this period" empty state already covers that case, so
  // this card renders nothing rather than a second, redundant empty panel.
  if (!defaultSeries) return null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm font-medium">Usage over time</h2>
        <p className="text-muted-foreground text-xs">
          {defaultSeries.capability} &middot; {defaultSeries.unit}, daily. Toggle the compute and storage series to see what moved alongside it.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <fieldset className="flex flex-wrap gap-4">
          <legend className="sr-only">Chart series</legend>
          {TOGGLES.map((toggle) => {
            const id = `usage-timeseries-toggle-${toggle.key}`;
            return (
              <div key={toggle.key} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={enabled[toggle.key]}
                  onCheckedChange={(checked) => setEnabled((prev) => ({ ...prev, [toggle.key]: checked === true }))}
                />
                <Label htmlFor={id} className="text-sm font-normal">
                  {toggle.label}
                </Label>
              </div>
            );
          })}
        </fieldset>
        <MetricChart
          kind="line"
          data={chartData}
          xKey="bucketStart"
          series={activeSeries}
          height={240}
          showLegend
          isLoading={timeseries.isPending}
          error={timeseries.error ?? undefined}
          onRetry={timeseries.refetch}
          aria-label={`${defaultSeries.capability} ${defaultSeries.unit} usage by day, with optional compute and storage overlays`}
        />
      </CardContent>
    </Card>
  );
}
