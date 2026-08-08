'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { IconReceipt } from '@tabler/icons-react';

import { MetricTable } from '@arcaai/ui/components/metrics';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';

import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth';
import { formatMicros, formatPercent } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';

import { useComputeDraft, useInvoices, useRateCard, useSpendStatus } from '../api/hooks';
import type { BillingInvoiceStatus, SellRate, SpendStatus } from '../api/types';
import { InvoiceDetailDrawer } from './invoice-detail-drawer';

const MONTH_COUNT = 12;
const monthLabelFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' });

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

const STATUS_LABEL: Record<BillingInvoiceStatus, string> = { DRAFT: 'Draft', FINALIZED: 'Finalized', VOID: 'Void' };

export function BillingScreen() {
  return (
    <WorkingTenantGate
      title="Billing & invoices"
      meta={<span className="font-mono text-xs">admin/billing/invoices · rate-card · spend-status</span>}
      description="Invoices are per-tenant. Pick a working tenant to compute drafts, finalize periods and issue credit memos."
    >
      <BillingBody />
    </WorkingTenantGate>
  );
}

function BillingBody() {
  const session = useSession();
  const tenantId = session.data?.effectiveTenantId ?? session.data?.workingTenantId ?? '';

  const months = useMemo(() => recentMonths(), []);
  const [period, setPeriod] = useState(months[0]);
  const [tab, setTab] = useState('invoices');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const invoices = useInvoices(tab === 'invoices');
  const spend = useSpendStatus(true, period);
  const rateCard = useRateCard(tab === 'rate-card');
  const computeDraft = useComputeDraft();

  function onComputeDraft() {
    if (!tenantId) {
      toast.error('No working tenant is selected.');
      return;
    }
    computeDraft.mutate(
      { tenantId, period },
      {
        onSuccess: (invoice) => {
          toast.success(`Draft computed for ${monthLabel(invoice.period)}`);
          setSelectedId(invoice.id);
        },
        onError: (err) => toast.error(err instanceof GatewayError ? err.message : 'Could not compute the draft.'),
      },
    );
  }

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <ScreenTemplate
        header={<PageHeader title="Billing & invoices" meta={<span>In-house invoice engine · money as integer micros</span>} />}
        statusBanner={<SpendBanner spend={spend.data ?? null} period={period} />}
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="rate-card">Rate card</TabsTrigger>
          </TabsList>
        }
        footer={<StatusFooter start={<span>SELL rates are supersede-only; a finalized period is immutable (corrections are credit memos)</span>} end={<span className="font-mono">GLOBAL_ADMIN</span>} />}
      >
        <TabsContent value="invoices">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-2">
              <PeriodSelect months={months} value={period} onChange={setPeriod} />
              <Button size="sm" onClick={onComputeDraft} disabled={computeDraft.isPending}>
                Compute draft
              </Button>
            </div>
            <InvoiceListCard
              rows={
                invoices.data?.map((invoice) => ({
                  period: monthLabel(invoice.period),
                  status: STATUS_LABEL[invoice.status],
                  total: formatMicros(invoice.totalMicros, invoice.currency),
                  view: (
                    <Button variant="ghost" size="sm" onClick={() => setSelectedId(invoice.id)}>
                      View
                    </Button>
                  ),
                })) ?? []
              }
              isLoading={invoices.isPending}
              error={invoices.error ?? undefined}
            />
          </div>
        </TabsContent>

        <TabsContent value="rate-card">
          <RateCardCard rows={rateCard.data ?? []} isLoading={rateCard.isPending} error={rateCard.error ?? undefined} />
        </TabsContent>
      </ScreenTemplate>

      <InvoiceDetailDrawer invoiceId={selectedId} onClose={() => setSelectedId(null)} />
    </Tabs>
  );
}

function PeriodSelect({ months, value, onChange }: { months: string[]; value: string; onChange: (period: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">Billing period</span>
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
    </div>
  );
}

function SpendBanner({ spend, period }: { spend: SpendStatus | null; period: string }) {
  if (!spend) return null;
  const tone = spend.exceeded ? 'border-destructive/40 bg-destructive/10 text-destructive-foreground' : 'border-border bg-muted/40';
  const limit = spend.spendLimitMicros === null ? 'no limit set' : formatMicros(spend.spendLimitMicros);
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${tone}`} role="status">
      <span className="font-medium">Overage spend</span> {formatMicros(spend.overageSpendMicros)} of {limit}
      {spend.utilizationPercent !== null ? <span className="text-muted-foreground"> · {formatPercent(spend.utilizationPercent)} used</span> : null}
      {spend.exceeded ? <span className="ml-2 font-semibold">Spend limit reached ({period}).</span> : null}
    </div>
  );
}

function InvoiceListCard({ rows, isLoading, error }: { rows: Record<string, React.ReactNode>[]; isLoading: boolean; error?: Error }) {
  return (
    <MetricTable
      columns={[
        { key: 'period', label: 'Period' },
        { key: 'status', label: 'Status' },
        { key: 'total', label: 'Total', format: 'numeric' },
        { key: 'view', label: <span className="sr-only">Actions</span>, align: 'right' },
      ]}
      rows={rows}
      zebra
      caption="Invoices for the working tenant"
      aria-label="Invoices"
      isLoading={isLoading}
      error={error}
      emptyState={
        <EmptyState
          icon={IconReceipt}
          title="No invoices yet"
          description="Compute a draft for a period to start the invoice lifecycle. Placeholder SELL rates apply until real rates are seeded."
        />
      }
    />
  );
}

function RateCardCard({ rows, isLoading, error }: { rows: SellRate[]; isLoading: boolean; error?: Error }) {
  const tableRows = rows.map((rate) => ({
    kind: rate.rowKind,
    capability: rate.capability ?? '—',
    unit: rate.unit ?? '—',
    tier: rate.planTier ?? '—',
    rate: formatMicros(rate.unitPriceMicros, rate.currency),
    book: <span className="font-mono text-xs">{rate.bookVersion}</span>,
  }));
  return (
    <MetricTable
      columns={[
        { key: 'kind', label: 'Row kind' },
        { key: 'capability', label: 'Capability' },
        { key: 'unit', label: 'Unit' },
        { key: 'tier', label: 'Plan' },
        { key: 'rate', label: 'Rate', format: 'numeric' },
        { key: 'book', label: 'Book version' },
      ]}
      rows={tableRows}
      zebra
      caption="Effective SELL rate card (read-only; superseding rates is a rate-card admin action)"
      aria-label="SELL rate card"
      isLoading={isLoading}
      error={error}
      emptyState={<EmptyState icon={IconReceipt} title="No SELL rates" description="The tenant-facing rate card has no effective rows yet." />}
    />
  );
}
