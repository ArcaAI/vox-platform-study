'use client';

import * as React from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { Inbox, RotateCcw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/shadcn/button';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/shadcn/chart';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/shadcn/empty';
import { Skeleton } from '@/components/shadcn/skeleton';
import type { AsyncStateProps, BaseSurfaceProps } from '@/lib/shared';
import { cn } from '@/lib/utils';

/** Default series palette — the `--chart-1..5` tokens (light + dark in globals.css). */
const DEFAULT_CHART_VARS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

export type MetricChartKind = 'bar' | 'line' | 'area';

export interface MetricSeries {
  key: string;
  label: string;
  /** Defaults to `--chart-1..5` by series index. */
  colorVar?: string;
}

export interface MetricChartProps extends BaseSurfaceProps, AsyncStateProps {
  kind: MetricChartKind;
  data: Record<string, number | string>[];
  xKey: string;
  series: MetricSeries[];
  /** Override/extend the derived shadcn `ChartConfig`. */
  config?: ChartConfig;
  height?: number;
  valueFormatter?: (value: number) => string;
  showLegend?: boolean;
  showGrid?: boolean;
  onRetry?: () => void;
  'aria-label'?: string;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);
  return reduced;
}

/**
 * Bar / line / area chart (PHASE-2-PLAN §3.2). Wraps the shadcn `chart` shell
 * (`ChartContainer` + tooltip/legend) over `recharts`; series default to the
 * `--chart-1..5` tokens. The visual is `role="img"` with a descriptive label and is
 * paired with an offscreen data-table fallback for screen readers. Honors the
 * `AsyncStateProps` loading/empty/error contract and `prefers-reduced-motion`.
 */
export function MetricChart(props: MetricChartProps) {
  const {
    kind,
    data,
    xKey,
    series,
    config,
    height = 240,
    valueFormatter,
    showLegend = false,
    showGrid = true,
    onRetry,
    density = 'comfortable',
    className,
    isLoading,
    error,
    emptyState,
    errorState,
    loadingState,
  } = props;

  const reducedMotion = usePrefersReducedMotion();
  const ariaLabel = props['aria-label'] ?? `${series.map((s) => s.label).join(', ')} ${kind} chart`;

  const chartConfig = React.useMemo<ChartConfig>(() => {
    const derived: ChartConfig = {};
    series.forEach((s, i) => {
      derived[s.key] = { label: s.label, color: s.colorVar ?? DEFAULT_CHART_VARS[i % DEFAULT_CHART_VARS.length] };
    });
    return { ...derived, ...config };
  }, [series, config]);

  const wrapperProps = {
    'data-slot': 'metric-chart',
    'data-kind': kind,
    'data-density': density,
    className: cn('w-full', className),
  } as const;

  if (isLoading) {
    return (
      <div {...wrapperProps}>{loadingState ?? <Skeleton role="status" aria-label="Loading" className="w-full rounded-lg" style={{ height }} />}</div>
    );
  }

  if (error) {
    return (
      <div {...wrapperProps}>
        {errorState?.(error) ?? (
          <div role="alert" className="flex flex-col items-center justify-center gap-3 p-10 text-center" style={{ minHeight: height }}>
            <TriangleAlert className="size-10 text-destructive" />
            <div>
              <p className="font-medium">Couldn’t load this chart</p>
              <p className="text-sm text-muted-foreground">{error.message}</p>
            </div>
            {onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCcw className="size-4" />
                Retry
              </Button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div {...wrapperProps}>
        {emptyState ?? (
          <Empty style={{ minHeight: height }}>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>No data for this range</EmptyTitle>
              <EmptyDescription>Try a different date range or tenant filter.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    );
  }

  const grid = showGrid ? <CartesianGrid vertical={false} /> : null;
  const xAxis = <XAxis dataKey={xKey} tickLine={false} axisLine={false} tickMargin={8} />;
  const yAxis = <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={valueFormatter ? (v) => valueFormatter(Number(v)) : undefined} />;
  const tooltip = <ChartTooltip content={<ChartTooltipContent />} />;
  const legend = showLegend ? <ChartLegend content={<ChartLegendContent />} /> : null;
  const animate = !reducedMotion;

  let chart: React.ReactElement;
  if (kind === 'bar') {
    chart = (
      <BarChart data={data}>
        {grid}
        {xAxis}
        {yAxis}
        {tooltip}
        {legend}
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} radius={4} isAnimationActive={animate} />
        ))}
      </BarChart>
    );
  } else if (kind === 'line') {
    chart = (
      <LineChart data={data}>
        {grid}
        {xAxis}
        {yAxis}
        {tooltip}
        {legend}
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            dot={false}
            isAnimationActive={animate}
          />
        ))}
      </LineChart>
    );
  } else {
    chart = (
      <AreaChart data={data}>
        {grid}
        {xAxis}
        {yAxis}
        {tooltip}
        {legend}
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            stroke={`var(--color-${s.key})`}
            fill={`var(--color-${s.key})`}
            fillOpacity={0.2}
            strokeWidth={2}
            isAnimationActive={animate}
          />
        ))}
      </AreaChart>
    );
  }

  return (
    <div {...wrapperProps}>
      <div role="img" aria-label={ariaLabel}>
        <ChartContainer config={chartConfig} className="aspect-auto w-full" style={{ height }}>
          {chart}
        </ChartContainer>
      </div>
      <table data-slot="metric-chart-table" className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">{xKey}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i}>
              <th scope="row">{String(row[xKey])}</th>
              {series.map((s) => {
                const raw = row[s.key];
                const formatted = typeof raw === 'number' && valueFormatter ? valueFormatter(raw) : String(raw ?? '');
                return <td key={s.key}>{formatted}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
