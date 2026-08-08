'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { MetricTable } from '@arcaai/ui/components/metrics';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime, formatMicros } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';

import { useAddAdjustment, useFinalizeInvoice, useInvoice, useVoidInvoice } from '../api/hooks';
import type { BillingInvoice, BillingInvoiceStatus } from '../api/types';

const STATUS_VARIANT: Record<BillingInvoiceStatus, 'default' | 'secondary' | 'outline'> = {
  DRAFT: 'secondary',
  FINALIZED: 'default',
  VOID: 'outline',
};

function toastError(err: unknown, fallback: string) {
  toast.error(err instanceof GatewayError ? err.message : fallback);
}

/** Right slide-over for one invoice: summary + lines + adjustments, with the
 * DRAFT→FINALIZE/VOID lifecycle (If-Match OCC) and a credit-memo dialog for
 * FINALIZED periods (TASK-615 #15b). */
export function InvoiceDetailDrawer({ invoiceId, onClose }: { invoiceId: string | null; onClose: () => void }) {
  const detail = useInvoice(invoiceId);
  const invoice = detail.data?.data ?? null;
  const etag = detail.data?.etag ?? null;

  const finalize = useFinalizeInvoice();
  const voidInvoice = useVoidInvoice();
  const [memoOpen, setMemoOpen] = useState(false);

  function onFinalize() {
    if (!invoice || !etag) return;
    finalize.mutate(
      { id: invoice.id, etag },
      { onSuccess: () => toast.success('Invoice finalized'), onError: (err) => !isOcc(err) && toastError(err, 'Could not finalize the invoice.') },
    );
  }

  function onVoid() {
    if (!invoice || !etag) return;
    voidInvoice.mutate(
      { id: invoice.id, etag },
      { onSuccess: () => toast.success('Invoice voided'), onError: (err) => !isOcc(err) && toastError(err, 'Could not void the invoice.') },
    );
  }

  const occError = (finalize.error ?? voidInvoice.error) as unknown;

  return (
    <>
      <DetailDrawer
        open={!!invoiceId}
        onOpenChange={(open) => !open && onClose()}
        size="xl"
        title={invoice ? `Invoice · ${invoice.period}` : 'Invoice'}
        badges={invoice ? <Badge variant={STATUS_VARIANT[invoice.status]}>{invoice.status}</Badge> : undefined}
        meta={
          invoice ? (
            <span className="flex items-center gap-1 font-mono text-xs">
              {invoice.id}
              <CopyButton value={invoice.id} label="Copy invoice id" />
            </span>
          ) : undefined
        }
        footer={
          invoice ? (
            <InvoiceActions
              status={invoice.status}
              busy={finalize.isPending || voidInvoice.isPending}
              hasEtag={!!etag}
              onFinalize={onFinalize}
              onVoid={onVoid}
              onAddMemo={() => setMemoOpen(true)}
            />
          ) : undefined
        }
      >
        {detail.isPending ? (
          <DetailSkeleton />
        ) : detail.error ? (
          <ErrorState title="Could not load invoice" error={detail.error} onRetry={() => void detail.refetch()} />
        ) : invoice ? (
          <div className="flex flex-col gap-4">
            <OccConflictAlert error={occError} onReload={() => void detail.refetch()} />
            <InvoiceSummary invoice={invoice} />
            <LinesTable invoice={invoice} />
            <AdjustmentsTable invoice={invoice} />
          </div>
        ) : null}
      </DetailDrawer>
      {invoice ? <CreditMemoDialog open={memoOpen} onOpenChange={setMemoOpen} invoiceId={invoice.id} /> : null}
    </>
  );
}

function isOcc(err: unknown): boolean {
  return err instanceof GatewayError && (err.isVersionConflict || err.isMissingPrecondition);
}

function InvoiceActions({
  status,
  busy,
  hasEtag,
  onFinalize,
  onVoid,
  onAddMemo,
}: {
  status: BillingInvoiceStatus;
  busy: boolean;
  hasEtag: boolean;
  onFinalize: () => void;
  onVoid: () => void;
  onAddMemo: () => void;
}) {
  if (status === 'DRAFT') {
    return (
      <>
        <Button variant="outline" size="sm" onClick={onVoid} disabled={busy || !hasEtag}>
          Void
        </Button>
        <Button size="sm" onClick={onFinalize} disabled={busy || !hasEtag}>
          Finalize
        </Button>
      </>
    );
  }
  if (status === 'FINALIZED') {
    return (
      <Button variant="outline" size="sm" onClick={onAddMemo}>
        Add credit memo
      </Button>
    );
  }
  return <span className="text-muted-foreground text-xs">Voided periods are immutable.</span>;
}

function InvoiceSummary({ invoice }: { invoice: BillingInvoice }) {
  const rows: Array<[string, string]> = [
    ['Plan tier', invoice.planTier ?? '—'],
    ['Plan-fee basis', invoice.planFeeBasis],
    ['Subtotal', formatMicros(invoice.subtotalMicros, invoice.currency)],
    ['Adjustments', formatMicros(invoice.adjustmentsTotalMicros, invoice.currency)],
    ['Total after adjustments', formatMicros(invoice.amountAfterAdjustmentsMicros, invoice.currency)],
    ['BYOK notional (not billed)', formatMicros(invoice.byokNotionalCostMicros, invoice.currency)],
    ['Finalized', invoice.finalizedAt ? formatDateTime(invoice.finalizedAt) : '—'],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LinesTable({ invoice }: { invoice: BillingInvoice }) {
  const rows = invoice.lines.map((line) => ({
    kind: line.kind,
    description: line.description,
    quantity: line.quantity ?? '—',
    amount: formatMicros(line.amountMicros, invoice.currency),
  }));
  return (
    <section aria-label="Invoice lines">
      <h3 className="mb-2 text-sm font-semibold">Lines</h3>
      <MetricTable
        columns={[
          { key: 'kind', label: 'Kind' },
          { key: 'description', label: 'Description' },
          { key: 'quantity', label: 'Quantity', format: 'numeric' },
          { key: 'amount', label: 'Amount', format: 'numeric' },
        ]}
        rows={rows}
        zebra
        aria-label="Invoice line items"
        emptyState={<span className="text-muted-foreground text-sm">No lines.</span>}
      />
    </section>
  );
}

function AdjustmentsTable({ invoice }: { invoice: BillingInvoice }) {
  const rows = invoice.adjustments.map((adjustment) => ({
    reason: adjustment.reason,
    amount: formatMicros(adjustment.amountMicros, invoice.currency),
    created: formatDateTime(adjustment.createdAt),
  }));
  return (
    <section aria-label="Invoice adjustments">
      <h3 className="mb-2 text-sm font-semibold">Adjustments (credit memos)</h3>
      <MetricTable
        columns={[
          { key: 'reason', label: 'Reason' },
          { key: 'amount', label: 'Amount', format: 'numeric' },
          { key: 'created', label: 'Created' },
        ]}
        rows={rows}
        aria-label="Credit memos against this invoice"
        emptyState={<span className="text-muted-foreground text-sm">No adjustments.</span>}
      />
    </section>
  );
}

function CreditMemoDialog({ open, onOpenChange, invoiceId }: { open: boolean; onOpenChange: (open: boolean) => void; invoiceId: string }) {
  const addAdjustment = useAddAdjustment();
  const [reason, setReason] = useState('');
  const [dollars, setDollars] = useState('');

  function submit() {
    const reasonCode = reason.trim();
    const amount = Number(dollars);
    if (!reasonCode || Number.isNaN(amount) || amount === 0) {
      toast.error('Enter a reason code and a non-zero amount.');
      return;
    }
    // Negative micros = credit (the common case); a positive dollar amount is a credit.
    const amountMicros = String(-Math.round(Math.abs(amount) * 1_000_000));
    addAdjustment.mutate(
      { id: invoiceId, body: { reason: reasonCode, amountMicros } },
      {
        onSuccess: () => {
          toast.success('Credit memo added');
          setReason('');
          setDollars('');
          onOpenChange(false);
        },
        onError: (err) => toastError(err, 'Could not add the credit memo.'),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add credit memo</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="memo-reason">Reason code</Label>
            <Input
              id="memo-reason"
              placeholder="goodwill_credit"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">A bounded code, not prose (PHI-free, aggregatable).</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="memo-amount">Credit amount (USD)</Label>
            <Input id="memo-amount" inputMode="decimal" placeholder="50.00" value={dollars} onChange={(event) => setDollars(event.target.value)} />
            <p className="text-muted-foreground text-xs">Nets against the finalized total as a credit.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={addAdjustment.isPending}>
            Add credit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-4 w-full" />
        ))}
      </div>
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
