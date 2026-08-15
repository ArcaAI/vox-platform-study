'use client';

import { useMemo, useState } from 'react';
import { IconCoin, IconKey, IconReportAnalytics, IconReportMoney, IconStethoscope } from '@tabler/icons-react';

import { MetricChart, MetricTable, StatCard } from '@arcaai/ui/components/metrics';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';

import { formatMicros, formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';

import { aggregateCostByCapability, sumMicrosMap } from '../api/aggregate';
import { useCostPerEncounter, useTopTenants, useUsageSummary } from '../api/hooks';
import type { CostPerEncounterView, TopTenantsView, UsageSummaryView } from '../api/hooks';

const MONTH_COUNT = 12;
const monthLabelFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' });

/** Current UTC month + the 11 prior, as `YYYY-MM` — the period picker's options. */
function recentMonths(now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < MONTH_COUNT; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  return monthLabelFormat.format(new Date(Date.UTC(y, m - 1, 1)));
}

export function ConsumptionCostScreen() {
  return (
    <WorkingTenantGate
      title="Consumption & Cost"
      meta={<span className="font-mono text-xs">GET admin/usage/summary · cost-per-encounter · top-tenants</span>}
      description="Metered AI consumption and cost are tenant-scoped. Pick a working tenant to view its usage."
    >
      <ConsumptionCostBody />
    </WorkingTenantGate>
  );
}

function ConsumptionCostBody() {
  const months = useMemo(() => recentMonths(), []);
  const [period, setPeriod] = useState(months[0]);
  const params = useMemo(() => ({ period }), [period]);

  const summary = useUsageSummary(true, params);
  const cpe = useCostPerEncounter(true, params);
  const top = useTopTenants(true, params);

  const noUsage = !summary.isPending && !summary.error && (summary.data?.lines.length ?? 0) === 0;

  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="Consumption & Cost"
          meta={<span>Metered AI usage and COGS for the working tenant · {monthLabel(period)}</span>}
          actions={<PeriodSelect months={months} value={period} onChange={setPeriod} />}
        />
      }
      stats={
        <section aria-label="Cost summary">
          <StatGrid summary={summary} cpe={cpe} />
        </section>
      }
      footer={
        <StatusFooter
          start={<span>Billing period {period} · money as rated cost (integer micros)</span>}
          end={<span className="font-mono">INTERNAL basis; BYOK notional shown separately (D14)</span>}
        />
      }
    >
      <div className="flex flex-col gap-4">
        {summary.error ? (
          <ErrorState title="Could not load usage" error={summary.error} onRetry={summary.refetch} />
        ) : noUsage ? (
          <EmptyState
            icon={IconReportAnalytics}
            title="No metered usage this period"
            description="Once this tenant runs transcription, summarization, TTS or NLP, its consumption and rated cost appear here."
          />
        ) : (
          <>
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <CostByCapabilityCard summary={summary} />
              <CostPerEncounterCard cpe={cpe} />
            </div>
            <UsageDetailCard summary={summary} />
            <TopTenantsCard top={top} />
          </>
        )}
      </div>
    </ScreenTemplate>
  );
}

function PeriodSelect({ months, value, onChange }: { months: string[]; value: string; onChange: (period: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[11rem]" aria-label="Billing period">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {months.map((month) => (
          <SelectItem key={month} value={month}>
            {monthLabel(month)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StatGrid({ summary, cpe }: { summary: UsageSummaryView; cpe: CostPerEncounterView }) {
  const byokTotal = sumMicrosMap(summary.data?.byokNotionalCostMicrosByCapability);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Total cost"
        value={formatMicros(summary.data?.totalCostMicros)}
        hint="INTERNAL-basis rated COGS this period"
        icon={IconCoin}
        deltaIntent="negative"
        isLoading={summary.isPending}
        error={summary.error ?? undefined}
      />
      <StatCard
        label="BYOK notional"
        value={formatMicros(byokTotal)}
        hint="Tenant-funded spend — never billed (D14)"
        icon={IconKey}
        isLoading={summary.isPending}
        error={summary.error ?? undefined}
      />
      <StatCard
        label="Mean cost / encounter"
        value={formatMicros(cpe.data?.meanMicros)}
        hint={cpe.data ? `${formatNumber(cpe.data.count)} consultations` : undefined}
        icon={IconReportMoney}
        deltaIntent="negative"
        isLoading={cpe.isPending}
        error={cpe.error ?? undefined}
      />
      <StatCard
        label="Encounters costed"
        value={cpe.data ? formatNumber(cpe.data.count) : null}
        hint="Consultations with INTERNAL-basis cost"
        icon={IconStethoscope}
        isLoading={cpe.isPending}
        error={cpe.error ?? undefined}
      />
    </div>
  );
}

function CostByCapabilityCard({ summary }: { summary: UsageSummaryView }) {
  const byCapability = useMemo(() => aggregateCostByCapability(summary.data?.lines ?? []), [summary.data]);
  const chartData = useMemo(() => byCapability.map((row) => ({ capability: row.capability, cost: Number(row.costMicros) / 1_000_000 })), [byCapability]);

  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm font-semibold">Cost by capability</h2>
      </CardHeader>
      <CardContent>
        <MetricChart
          kind="bar"
          data={chartData}
          xKey="capability"
          series={[{ key: 'cost', label: 'Cost (USD)' }]}
          height={240}
          isLoading={summary.isPending}
          error={summary.error ?? undefined}
          onRetry={summary.refetch}
          valueFormatter={(v) => `$${v.toFixed(2)}`}
          aria-label="INTERNAL-basis rated cost by AI capability for the working tenant this period"
        />
      </CardContent>
    </Card>
  );
}

function CostPerEncounterCard({ cpe }: { cpe: CostPerEncounterView }) {
  const rows = cpe.data
    ? [
        { metric: 'Median (p50)', cost: formatMicros(cpe.data.p50Micros) },
        { metric: 'p90', cost: formatMicros(cpe.data.p90Micros) },
        { metric: 'p99', cost: formatMicros(cpe.data.p99Micros) },
        { metric: 'Mean', cost: formatMicros(cpe.data.meanMicros) },
        { metric: 'Total', cost: formatMicros(cpe.data.totalMicros) },
      ]
    : [];
  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm font-semibold">Cost per encounter</h2>
      </CardHeader>
      <CardContent>
        <MetricTable
          columns={[
            { key: 'metric', label: 'Statistic' },
            { key: 'cost', label: 'Cost', format: 'numeric' },
          ]}
          rows={rows}
          caption="Per-consultation INTERNAL-basis cost distribution"
          aria-label="Cost per encounter percentiles"
          isLoading={cpe.isPending}
          error={cpe.error ?? undefined}
          emptyState={<EmptyState icon={IconReportMoney} title="No costed encounters" description="No consultations carried rated cost this period." />}
        />
      </CardContent>
    </Card>
  );
}

function UsageDetailCard({ summary }: { summary: UsageSummaryView }) {
  const rows =
    summary.data?.lines.map((line) => ({
      capability: line.capability,
      provider: line.provider,
      model: line.model === '' ? '—' : line.model,
      unit: line.unit,
      quantity: formatNumber(Number(line.quantity)),
      cost: formatMicros(line.costMicros),
    })) ?? [];
  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm font-semibold">Usage detail</h2>
      </CardHeader>
      <CardContent>
        <MetricTable
          columns={[
            { key: 'capability', label: 'Capability' },
            { key: 'provider', label: 'Provider' },
            { key: 'model', label: 'Model' },
            { key: 'unit', label: 'Unit' },
            { key: 'quantity', label: 'Quantity', format: 'numeric' },
            { key: 'cost', label: 'Cost', format: 'numeric' },
          ]}
          rows={rows}
          zebra
          caption="Metered usage by capability × provider × model × unit"
          aria-label="Usage detail by capability, provider, model and unit"
          isLoading={summary.isPending}
          error={summary.error ?? undefined}
        />
      </CardContent>
    </Card>
  );
}

function TopTenantsCard({ top }: { top: TopTenantsView }) {
  const rows =
    top.data?.tenants.map((tenant) => ({
      tenant: <span className="font-mono text-xs">{tenant.tenantId}</span>,
      cost: formatMicros(tenant.costMicros),
    })) ?? [];
  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm font-semibold">Platform · top spenders</h2>
        <p className="text-muted-foreground text-xs">Cross-tenant leaderboard (SUPER_ADMIN) — independent of the working tenant.</p>
      </CardHeader>
      <CardContent>
        <MetricTable
          columns={[
            { key: 'tenant', label: 'Tenant' },
            { key: 'cost', label: 'Cost', format: 'numeric' },
          ]}
          rows={rows}
          caption="Highest INTERNAL-basis rated cost across all tenants this period"
          aria-label="Top tenants by rated cost"
          isLoading={top.isPending}
          error={top.error ?? undefined}
          emptyState={<EmptyState icon={IconReportAnalytics} title="No cross-tenant usage" description="No rated usage across tenants this period." />}
        />
      </CardContent>
    </Card>
  );
}
