'use client';

import Link from 'next/link';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { IconChartLine, IconListCheck } from '@tabler/icons-react';
import { GUARDRAIL_CHECK_IDS, GUARDRAIL_DECISIONS } from '@arcaai/types';
import { MetricChart } from '@arcaai/ui/components/metrics/metric-chart';
import { StatCard } from '@arcaai/ui/components/metrics/stat-card';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { useGuardrailActivity, useGuardrailEvaluations, useGuardrailHealth, useGuardrailPerformance } from '../api/hooks';
import type { GuardrailActivity, GuardrailEvaluationItem, GuardrailMetricSample, GuardrailMetricsBucket, GuardrailMetricsWindow } from '../api/types';
import { ControlErrorState } from './control-states';
import { ResidencyTable } from './parameters-tab';

const RANGES = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 } as const;
type RangeKey = keyof typeof RANGES;
const DEFAULT_BUCKET: Record<RangeKey, GuardrailMetricsBucket> = { '24h': '1h', '7d': '1h', '30d': '1d' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CIRCUIT: Record<number, string> = { 0: 'closed', 1: 'half-open', 2: 'open' };

const pct = (ratio: number | null | undefined) => (ratio === null || ratio === undefined ? '—' : `${(ratio * 100).toFixed(1)}%`);
const ms = (seconds: number) => `${Math.round(seconds * 1000)} ms`;
const labelsOf = (sample: GuardrailMetricSample) =>
  Object.entries(sample.labels)
    .filter(([key]) => key !== '__name__')
    .map(([key, value]) => `${key}=${value}`)
    .join(' ') ||
  (sample.labels.__name__ ?? '—');

function windowFor(range: RangeKey, bucket: GuardrailMetricsBucket, tenantId: string): GuardrailMetricsWindow {
  const to = new Date();
  const from = new Date(to.getTime() - RANGES[range] * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString(), bucket, ...(tenantId ? { tenantId } : {}) };
}

/** Decisions per bucket (directions summed): one row per bucket, one column per decision — one axis, a count. */
export function decisionSeries(activity: GuardrailActivity): Record<string, number | string>[] {
  const byBucket = new Map<string, Record<string, number | string>>();
  for (const point of activity.series) {
    const row = byBucket.get(point.bucketStart) ?? { bucket: formatDateTime(point.bucketStart), allow: 0, warn: 0, block: 0, unverified: 0 };
    row[point.decision] = ((row[point.decision] as number | undefined) ?? 0) + point.count;
    byBucket.set(point.bucketStart, row);
  }
  return [...byBucket.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}

function SamplesTable({ label, samples, format }: { label: string; samples: GuardrailMetricSample[]; format: (value: number) => string }) {
  if (samples.length === 0) return <p className="text-muted-foreground text-xs">No series.</p>;
  return (
    <Table aria-label={label}>
      <TableBody>
        {samples.map((sample, index) => (
          <TableRow key={index}>
            <TableCell className="font-mono text-xs">{labelsOf(sample)}</TableCell>
            <TableCell className="text-right font-mono text-xs">{format(sample.value)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PerfCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="gap-2 p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </Card>
  );
}

function KpiSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-hidden>
      {[0, 1, 2, 3, 4, 5].map((card) => (
        <Skeleton key={card} className="h-24 w-full" />
      ))}
    </div>
  );
}

function ActivitySection({ window }: { window: GuardrailMetricsWindow }) {
  const query = useGuardrailActivity(window);
  if (query.isError) return <ControlErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const activity = query.data;
  if (!activity) {
    return (
      <div className="flex flex-col gap-4">
        <KpiSkeleton />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  const { totals } = activity;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Evaluations" value={formatNumber(totals.evaluations)} />
        <StatCard label="Flag rate" value={pct(totals.flagRate)} hint="(warn + block) / evaluations" />
        <StatCard label="Warn" value={formatNumber(totals.warn)} />
        <StatCard label="Block" value={formatNumber(totals.block)} />
        <StatCard label="Unverified" value={formatNumber(totals.unverified)} hint="a check could not decide" />
        <StatCard label="Overrides" value={formatNumber(totals.overrides)} hint="notices acknowledged" />
      </div>
      {totals.evaluations === 0 ? (
        <EmptyState icon={IconChartLine} title="No evaluations in this window" description="Nothing was screened for this range and tenant filter." />
      ) : (
        <>
          <MetricChart
            kind="line"
            aria-label="Guardrail decisions over time, per decision"
            data={decisionSeries(activity)}
            xKey="bucket"
            series={GUARDRAIL_DECISIONS.map((decision) => ({ key: decision, label: decision }))}
            height={260}
            showLegend
            valueFormatter={(value) => formatNumber(value)}
          />
          <div className="grid gap-4 xl:grid-cols-2">
            <Table aria-label="Per-check results">
              <TableHeader>
                <TableRow>
                  <TableHead>Check</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.checks.map((row) => (
                  <TableRow key={`${row.checkId}-${row.direction}-${row.verdict}-${row.actionTaken}`}>
                    <TableCell className="font-mono text-xs">{row.checkId}</TableCell>
                    <TableCell>{row.direction}</TableCell>
                    <TableCell>{row.verdict}</TableCell>
                    <TableCell>{row.actionTaken}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(row.count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Table aria-label="Top flagged categories">
              <TableHeader>
                <TableRow>
                  <TableHead>Check</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.topCategories.map((row) => (
                  <TableRow key={`${row.checkId}-${row.category}`}>
                    <TableCell className="font-mono text-xs">{row.checkId}</TableCell>
                    <TableCell className="font-mono text-xs">{row.category}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(row.count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Table aria-label="Per-tenant breakdown">
              <TableHeader>
                <TableRow>
                  <TableHead>Tenant</TableHead>
                  <TableHead className="text-right">Evaluations</TableHead>
                  <TableHead className="text-right">Warn</TableHead>
                  <TableHead className="text-right">Block</TableHead>
                  <TableHead className="text-right">Unverified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.perTenant.map((row) => (
                  <TableRow key={row.tenantId}>
                    <TableCell className="font-mono text-xs">{row.tenantId}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(row.evaluations)}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(row.warn)}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(row.block)}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(row.unverified)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Table aria-label="Per-model breakdown">
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Check</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Flags</TableHead>
                  <TableHead className="text-right">Undetermined</TableHead>
                  <TableHead className="text-right">Avg latency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.perModel.map((row) => (
                  <TableRow key={`${row.model}-${row.checkId}`}>
                    <TableCell className="font-mono text-xs">{row.model}</TableCell>
                    <TableCell className="font-mono text-xs">{row.checkId}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(row.calls)}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(row.flags)}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(row.undetermined)}</TableCell>
                    <TableCell className="text-right font-mono">{row.avgLatencyMs === null ? '—' : `${Math.round(row.avgLatencyMs)} ms`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

function PerformanceSection() {
  const query = useGuardrailPerformance();
  if (query.isError) return <ControlErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const perf = query.data;
  if (!perf) return <KpiSkeleton />;
  if (!perf.available) {
    return (
      <Alert>
        <IconChartLine aria-hidden />
        <AlertTitle>Prometheus answered nothing</AlertTitle>
        <AlertDescription>
          Performance series are unavailable right now. Activity and health above come from the database and residency.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Judge calls / s" value={perf.judgeCallsPerSecond === null ? '—' : perf.judgeCallsPerSecond.toFixed(2)} />
        <StatCard
          label="Evaluations missing"
          value={perf.evaluationsMissing === null ? '—' : formatNumber(perf.evaluationsMissing)}
          hint="reconciler gauge"
        />
        <StatCard label="Cache hit ratio" value={perf.windowCacheHitRatio.length === 0 ? '—' : pct(perf.windowCacheHitRatio[0]!.value)} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        <PerfCard title="Window latency p50 / p95">
          <SamplesTable label="Window latency p50" samples={perf.windowLatencyP50} format={ms} />
          <SamplesTable label="Window latency p95" samples={perf.windowLatencyP95} format={ms} />
        </PerfCard>
        <PerfCard title="Model latency p50 / p95">
          <SamplesTable label="Model latency p50" samples={perf.modelLatencyP50} format={ms} />
          <SamplesTable label="Model latency p95" samples={perf.modelLatencyP95} format={ms} />
        </PerfCard>
        <PerfCard title="Peer calls / s">
          <SamplesTable label="Peer calls per second" samples={perf.peerCallsPerSecond} format={(value) => value.toFixed(2)} />
        </PerfCard>
        <PerfCard title="Queue depth">
          <SamplesTable label="Queue depth" samples={perf.queueDepth} format={(value) => formatNumber(value)} />
        </PerfCard>
        <PerfCard title="Admission rejections / s">
          <SamplesTable label="Admission rejections per second" samples={perf.admissionRejectionsPerSecond} format={(value) => value.toFixed(2)} />
        </PerfCard>
        <PerfCard title="Circuit breakers">
          <SamplesTable label="Circuit breaker state" samples={perf.circuitBreakers} format={(value) => CIRCUIT[value] ?? String(value)} />
        </PerfCard>
        <PerfCard title="Peer failures / s">
          <SamplesTable label="Peer failures per second" samples={perf.peerFailuresPerSecond} format={(value) => value.toFixed(2)} />
        </PerfCard>
        <PerfCard title="Window cache hit ratio">
          <SamplesTable label="Window cache hit ratio" samples={perf.windowCacheHitRatio} format={pct} />
        </PerfCard>
        <PerfCard title="Evaluation outbox">
          <SamplesTable label="Evaluation outbox" samples={perf.outbox} format={(value) => formatNumber(value)} />
        </PerfCard>
      </div>
    </div>
  );
}

function HealthSection() {
  const query = useGuardrailHealth();
  if (query.isError) return <ControlErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const health = query.data;
  if (!health) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard label="Undetermined rate (1 h)" value={pct(health.undeterminedRate)} />
        <StatCard
          label="Last evaluation"
          value={health.lastEvaluationAt ? formatRelativeTime(health.lastEvaluationAt) : 'never'}
          hint={health.secondsSinceLastEvaluation === null ? undefined : `${formatNumber(health.secondsSinceLastEvaluation)} s ago`}
        />
      </div>
      <ResidencyTable models={health.models} />
      <Link href="/model-residency" className="text-primary text-sm underline underline-offset-4">
        Manage residency on Model residency
      </Link>
    </div>
  );
}

function EvaluationsSection({ window }: { window: GuardrailMetricsWindow }) {
  const uid = useId();
  const [decision, setDecision] = useState('');
  const [checkId, setCheckId] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const query = useGuardrailEvaluations({ ...window, decision, checkId, cursor: cursors.at(-1), limit: 50 });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-decision`} className="text-xs">
            Decision
          </Label>
          <NativeSelect
            id={`${uid}-decision`}
            value={decision}
            onChange={(event) => {
              setDecision(event.target.value);
              setCursors([]);
            }}
          >
            <NativeSelectOption value="">all</NativeSelectOption>
            {GUARDRAIL_DECISIONS.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-check`} className="text-xs">
            Check
          </Label>
          <NativeSelect
            id={`${uid}-check`}
            value={checkId}
            onChange={(event) => {
              setCheckId(event.target.value);
              setCursors([]);
            }}
          >
            <NativeSelectOption value="">all</NativeSelectOption>
            {GUARDRAIL_CHECK_IDS.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      {query.isError ? (
        <ControlErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <div className="flex flex-col gap-2" aria-hidden>
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} className="h-9 w-full" />
          ))}
        </div>
      ) : query.data.items.length === 0 ? (
        <EmptyState icon={IconListCheck} title="No evaluations match" description="Widen the range or clear a filter." />
      ) : (
        <>
          <Table aria-label={`Guardrail evaluations (${query.data.items.length}${query.data.hasMore ? '+' : ''})`}>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Caller</TableHead>
                <TableHead>Consultation</TableHead>
                <TableHead className="text-right">Checks</TableHead>
                <TableHead className="text-right">Notices</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.items.map((item: GuardrailEvaluationItem) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <time dateTime={item.at} title={formatDateTime(item.at)}>
                      {formatRelativeTime(item.at)}
                    </time>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{item.tenantId.slice(0, 8)}</TableCell>
                  <TableCell>{item.direction}</TableCell>
                  <TableCell>
                    <Badge variant={item.decision === 'block' ? 'destructive' : item.decision === 'allow' ? 'secondary' : 'outline'}>
                      {item.decision}
                    </Badge>
                    {item.hasWithheldContent ? (
                      <Badge variant="outline" className="ml-1">
                        withheld
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{item.caller}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.consultationId ? (
                      <Link href={`/consultations/${encodeURIComponent(item.consultationId)}`} className="text-primary underline underline-offset-4">
                        {item.consultationId.slice(0, 8)}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono">{item.checks.length}</TableCell>
                  <TableCell className="text-right font-mono">{item.noticeIds.length}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!query.data.hasMore || !query.data.nextCursor}
              onClick={() => setCursors([...cursors, query.data!.nextCursor as string])}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Monitoring (README §11.3 E): activity (DB), performance (fixed PromQL), health, and a content-free drill-down. */
export function MonitoringTab() {
  const uid = useId();
  const [range, setRange] = useState<RangeKey>('24h');
  const [bucket, setBucket] = useState<GuardrailMetricsBucket>('1h');
  const [tenantText, setTenantText] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [nonce, setNonce] = useState(0);
  // The window is fixed at selection time (and on Refresh) so the query key stays stable between renders.
  const metricsWindow = useMemo(() => {
    void nonce;
    return windowFor(range, bucket, tenantId);
  }, [range, bucket, tenantId, nonce]);
  const tenantInvalid = tenantText.trim() !== '' && !UUID.test(tenantText.trim());

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Monitoring filters">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-range`} className="text-xs">
            Range
          </Label>
          <NativeSelect
            id={`${uid}-range`}
            value={range}
            onChange={(event) => {
              const next = event.target.value as RangeKey;
              setRange(next);
              setBucket(DEFAULT_BUCKET[next]);
            }}
          >
            <NativeSelectOption value="24h">Last 24 hours</NativeSelectOption>
            <NativeSelectOption value="7d">Last 7 days</NativeSelectOption>
            <NativeSelectOption value="30d">Last 30 days</NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-bucket`} className="text-xs">
            Bucket
          </Label>
          <NativeSelect id={`${uid}-bucket`} value={bucket} onChange={(event) => setBucket(event.target.value as GuardrailMetricsBucket)}>
            <NativeSelectOption value="5m">5 minutes</NativeSelectOption>
            <NativeSelectOption value="1h">1 hour</NativeSelectOption>
            <NativeSelectOption value="1d">1 day</NativeSelectOption>
          </NativeSelect>
        </div>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!tenantInvalid) setTenantId(tenantText.trim());
          }}
        >
          <Label htmlFor={`${uid}-tenant`} className="text-xs">
            Tenant id (optional)
          </Label>
          <div className="flex gap-2">
            <Input
              id={`${uid}-tenant`}
              value={tenantText}
              placeholder="all tenants"
              aria-invalid={tenantInvalid || undefined}
              aria-describedby={tenantInvalid ? `${uid}-tenant-error` : undefined}
              className="w-80 font-mono text-xs"
              onChange={(event) => setTenantText(event.target.value)}
            />
            <Button type="submit" variant="outline" size="sm" disabled={tenantInvalid}>
              Apply
            </Button>
          </div>
          {tenantInvalid ? (
            <p id={`${uid}-tenant-error`} className="text-destructive text-xs">
              Enter a tenant UUID, or leave it empty for every tenant.
            </p>
          ) : null}
        </form>
        <Button type="button" variant="ghost" size="sm" onClick={() => setNonce(nonce + 1)}>
          Refresh
        </Button>
      </div>

      <section aria-labelledby="mon-activity" className="flex flex-col gap-3">
        <h2 id="mon-activity" className="text-base font-medium">
          Activity
        </h2>
        <ActivitySection window={metricsWindow} />
      </section>
      <section aria-labelledby="mon-performance" className="flex flex-col gap-3">
        <h2 id="mon-performance" className="text-base font-medium">
          Performance
        </h2>
        <PerformanceSection />
      </section>
      <section aria-labelledby="mon-health" className="flex flex-col gap-3">
        <h2 id="mon-health" className="text-base font-medium">
          Health
        </h2>
        <HealthSection />
      </section>
      <section aria-labelledby="mon-evaluations" className="flex flex-col gap-3">
        <h2 id="mon-evaluations" className="text-base font-medium">
          Evaluations
        </h2>
        <p className="text-muted-foreground text-sm">Per-check results only: the judged text is never shown here.</p>
        <EvaluationsSection window={metricsWindow} />
      </section>
    </div>
  );
}
