'use client';

import { useState } from 'react';
import { IconChartBar } from '@tabler/icons-react';
import { MetricChart } from '@arcaai/ui/components/metrics/metric-chart';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorBanner } from '@/shared/state/error-state';
import { useConsultationAggregate } from '../api';

/** Frame 40 default window: the last ~90 days (server rolls >70d up to months). */
const RANGE_DAYS = 90;

function isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export function defaultAggregateRange(now: Date = new Date()): { from: string; to: string } {
    return { from: isoDay(new Date(now.getTime() - RANGE_DAYS * 86_400_000)), to: isoDay(now) };
}

type GranularityChoice = 'day' | 'month' | undefined;

function GranularityToggle({ value, onChange }: { value: GranularityChoice; onChange: (next: GranularityChoice) => void }) {
    return (
        <div role="group" aria-label="Aggregate granularity" className="flex items-center gap-1">
            {(['day', 'month'] as const).map((option) => (
                <Button
                    key={option}
                    type="button"
                    variant={value === option ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={value === option}
                    onClick={() => onChange(value === option ? undefined : option)}
                >
                    {option === 'day' ? 'Day' : 'Month'}
                </Button>
            ))}
        </div>
    );
}

/**
 * Frame 40 (a) — new-vs-revisit aggregate over the last ~90 days, rendered
 * with the house MetricChart (frame 06) like the platform dashboard. The
 * series are distinguishable beyond color: the legend labels + the sr-only
 * data table MetricChart pairs with the visual. Granularity is auto (server
 * heuristic) unless the day/month toggle forces one; a failed refetch keeps
 * the last loaded buckets behind a stale banner.
 */
export function AggregateChartCard({ className }: { className?: string }) {
    // Computed once per mount so the query key stays stable across renders.
    const [range] = useState(() => defaultAggregateRange());
    const [granularity, setGranularity] = useState<GranularityChoice>(undefined);
    const aggregate = useConsultationAggregate({ ...range, ...(granularity ? { granularity } : {}) });

    const data = aggregate.data;
    const chartData = (data?.buckets ?? []).map((bucket) => ({ label: bucket.label, newVisits: bucket.newVisits, revisits: bucket.revisits }));
    const isLoading = aggregate.isPending || (aggregate.isError && aggregate.isFetching);

    return (
        <Card className={className ? `gap-4 ${className}` : 'gap-4'}>
            <CardHeader>
                <h2 className="text-sm leading-none font-semibold">New vs revisit {'\u00b7'} aggregate</h2>
                <CardAction>
                    <GranularityToggle value={granularity} onChange={setGranularity} />
                </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
                {aggregate.isError && data ? <ErrorBanner error={aggregate.error} onRetry={() => void aggregate.refetch()} /> : null}
                <MetricChart
                    kind="bar"
                    data={chartData}
                    xKey="label"
                    series={[
                        { key: 'newVisits', label: 'New' },
                        { key: 'revisits', label: 'Revisit' },
                    ]}
                    height={240}
                    showLegend
                    isLoading={isLoading}
                    error={aggregate.isError && !data ? aggregate.error : undefined}
                    onRetry={() => void aggregate.refetch()}
                    valueFormatter={(value) => formatNumber(value)}
                    aria-label="New vs revisit consultations"
                    emptyState={
                        <EmptyState
                            icon={IconChartBar}
                            title="No aggregate data"
                            description="Buckets fill in as consultations are created in the range."
                        />
                    }
                />
                {data ? (
                    <p className="text-muted-foreground text-sm">
                        {formatNumber(data.totals.newVisits)} new {'\u00b7'} {formatNumber(data.totals.revisits)} revisit {'\u00b7'}{' '}
                        {formatNumber(data.totals.total)} total
                        <span className="font-mono text-xs">
                            {' \u00b7 '}
                            {data.granularity} buckets {'\u00b7'} last {RANGE_DAYS} days {'\u00b7'} refreshed {formatRelativeTime(data.refreshedAt)}
                        </span>
                    </p>
                ) : null}
            </CardContent>
        </Card>
    );
}
