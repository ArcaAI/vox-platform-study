'use client';

import type { ReactNode } from 'react';
import { IconChartHistogram, IconClockBolt } from '@tabler/icons-react';
import { MetricChart } from '@arcaai/ui/components/metrics/metric-chart';
import { StatCard } from '@arcaai/ui/components/metrics/stat-card';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { formatNumber, formatPercent } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useGateMetrics, useGenerationMetrics } from '../api';

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-sm leading-none font-medium">{children}</h2>;
}

function msLabel(value: number | null): ReactNode {
  return value === null ? null : `${formatNumber(Math.round(value))} ms`;
}

/** Top KPI strip — each card owns its loading/error state (monitoring pattern). */
function KpiStrip({ generation, gate }: { generation: ReturnType<typeof useGenerationMetrics>; gate: ReturnType<typeof useGateMetrics> }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Median TTFT"
        value={msLabel(generation.aggregate.ttftMedianMs)}
        hint={`${formatNumber(generation.aggregate.sampleCount)} LLM steps sampled`}
        icon={IconClockBolt}
        isLoading={generation.isPending}
        error={generation.error ?? undefined}
      />
      <StatCard
        label="Avg tokens / s"
        value={generation.aggregate.tokensPerSecondAvg === null ? null : generation.aggregate.tokensPerSecondAvg.toFixed(1)}
        isLoading={generation.isPending}
        error={generation.error ?? undefined}
      />
      <StatCard
        label="Regeneration rate"
        value={gate.aggregate ? formatPercent(gate.aggregate.regenRatePct) : null}
        hint={gate.aggregate ? `${formatNumber(gate.aggregate.totalRegen)} / ${formatNumber(gate.aggregate.totalGenerate)} generations` : undefined}
        deltaIntent="negative"
        isLoading={gate.isPending}
        error={gate.error ?? undefined}
      />
      <StatCard
        label="Gate pending"
        value={gate.aggregate ? formatNumber(gate.aggregate.pending) : null}
        hint={gate.aggregate ? `${formatNumber(gate.aggregate.escalated)} escalated` : undefined}
        accent={gate.aggregate && gate.aggregate.escalated > 0 ? 'warning' : 'default'}
        isLoading={gate.isPending}
        error={gate.error ?? undefined}
      />
    </div>
  );
}

function StopReasonCard({ generation }: { generation: ReturnType<typeof useGenerationMetrics> }) {
  const data = generation.aggregate.stopReasons.map((row) => ({ reason: row.reason, count: row.count }));
  return (
    <Card className="gap-4">
      <CardHeader>
        <SectionTitle>Stop-reason distribution</SectionTitle>
      </CardHeader>
      <CardContent>
        <MetricChart
          kind="bar"
          data={data}
          xKey="reason"
          series={[{ key: 'count', label: 'Steps' }]}
          height={240}
          isLoading={generation.isPending}
          error={generation.error ?? undefined}
          onRetry={generation.refetch}
          valueFormatter={(value) => formatNumber(value)}
          aria-label="LLM stop-reason distribution across sampled steps"
          emptyState={
            <EmptyState
              icon={IconChartHistogram}
              title="No generation stats yet"
              description="LLM_CALL steps report ttft, tokens/s and stop reason as agentic runs complete."
            />
          }
        />
      </CardContent>
    </Card>
  );
}

function LatencyCard({ generation }: { generation: ReturnType<typeof useGenerationMetrics> }) {
  const { ttftMedianMs, ttftP95Ms, tokensPerSecondAvg } = generation.aggregate;
  const data = [
    { bucket: 'p50 TTFT', ms: ttftMedianMs === null ? 0 : Math.round(ttftMedianMs) },
    { bucket: 'p95 TTFT', ms: ttftP95Ms === null ? 0 : Math.round(ttftP95Ms) },
  ];
  const hasData = ttftMedianMs !== null;
  return (
    <Card className="gap-4">
      <CardHeader>
        <SectionTitle>Time-to-first-token</SectionTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <MetricChart
          kind="bar"
          data={hasData ? data : []}
          xKey="bucket"
          series={[{ key: 'ms', label: 'TTFT (ms)' }]}
          height={200}
          isLoading={generation.isPending}
          error={generation.error ?? undefined}
          onRetry={generation.refetch}
          valueFormatter={(value) => `${formatNumber(value)} ms`}
          aria-label="Median and p95 time-to-first-token across sampled steps"
          emptyState={
            <EmptyState icon={IconClockBolt} title="No latency samples" description="TTFT fills in as LLM_CALL steps report GenerationStats." />
          }
        />
        <p className="text-muted-foreground text-xs">
          Avg throughput {tokensPerSecondAvg === null ? '\u2014' : `${tokensPerSecondAvg.toFixed(1)} tok/s`}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * AI Operations — Metrics (/ai-operations/metrics, tier 10-19). TTFT / tok-s /
 * stop-reason from the generation-metrics aggregate; regeneration rate
 * from the harness gate queue. Tenant-scoped behind the working-tenant gate.
 */
export function AiOperationsMetricsScreen() {
  return (
    <WorkingTenantGate
      title="AI Operations — Metrics"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/agent-trajectory/metrics/generation + /admin/harness/gate-queue
        </span>
      }
      description="Generation telemetry is tenant-scoped. Pick a working tenant from the top-bar switcher to load its metrics."
    >
      <MetricsBody />
    </WorkingTenantGate>
  );
}

function MetricsBody() {
  const generation = useGenerationMetrics(true);
  const gate = useGateMetrics(true);

  const noGenerationData = !generation.isPending && !generation.error && generation.aggregate.sampleCount === 0;

  return (
    <ScreenTemplate
      header={<PageHeader title="AI Operations — Metrics" meta={<span>TTFT · tokens/s · stop reason · regeneration rate</span>} />}
      stats={
        <section aria-label="Key generation metrics">
          <KpiStrip generation={generation} gate={gate} />
        </section>
      }
      footer={
        <StatusFooter
          start={<span>{formatNumber(generation.aggregate.sampleCount)} LLM_CALL samples in the metrics window (default last 7 days)</span>}
          end={
            <span aria-hidden className="font-mono">
              server aggregate
            </span>
          }
        />
      }
    >
      <div className="flex flex-col gap-4">
        {generation.error ? (
          <ErrorState title={'Couldn\u2019t load generation metrics'} error={generation.error} onRetry={generation.refetch} />
        ) : noGenerationData ? (
          <EmptyState
            icon={IconChartHistogram}
            title="No agentic runs yet"
            description="Metrics populate once this tenant's agentic sessions record LLM_CALL steps with GenerationStats."
          />
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <LatencyCard generation={generation} />
            <StopReasonCard generation={generation} />
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          Generation panels come from GET /admin/agent-trajectory/metrics/generation. Regeneration / SLA panels still derive from the gate queue.
        </p>
      </div>
    </ScreenTemplate>
  );
}
