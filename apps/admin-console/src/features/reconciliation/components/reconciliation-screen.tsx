'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { IconScale } from '@tabler/icons-react';

import { MetricTable, StatCard } from '@arcaai/ui/components/metrics';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Label } from '@arcaai/ui/components/shadcn/label';

import { GatewayError } from '@/shared/api';
import { formatDateTime, formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';

import { useLatestPerProvider, useReconciliationRuns, useRunReconciliation } from '../api/hooks';
import type { ReconciliationRun, ReconciliationStatus } from '../api/types';

const STATUS_VARIANT: Record<ReconciliationStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  reconciled: 'default',
  skipped: 'outline',
  failed: 'destructive',
};

/** Signed ratio → "+50.0%" / "−2.4%". Null stays an em-dash: an undefined ratio is not zero drift. */
function formatDrift(value: string | null): string {
  if (value === null) return '—';
  const ratio = Number(value);
  if (Number.isNaN(ratio)) return '—';
  const sign = ratio > 0 ? '+' : ratio < 0 ? '−' : '';
  return `${sign}${Math.abs(ratio * 100).toFixed(1)}%`;
}

/**
 * Provider reconciliation — the audit trail.
 *
 * PLATFORM-WIDE, not tenant-scoped: a vendor bills the platform, so this screen
 * has no working-tenant gate, unlike its neighbours under `/ai-operations`.
 * Read-only apart from "Run now": the trail is a control, and one an operator
 * can edit answers nothing in a dispute.
 */
export function ReconciliationScreen() {
  const [breachedOnly, setBreachedOnly] = useState(false);
  const runs = useReconciliationRuns({ breachedOnly: breachedOnly || undefined, limit: 200 });
  const latest = useLatestPerProvider();
  const runNow = useRunReconciliation();

  const rows = (runs.data ?? []).map((run) => ({
    provider: <span className="font-mono text-xs">{run.provider}</span>,
    window: run.window,
    status: <Badge variant={STATUS_VARIANT[run.status]}>{run.status}</Badge>,
    ledger: run.ledgerQuantity === null ? '—' : formatNumber(Number(run.ledgerQuantity)),
    vendor: run.providerQuantity === null ? '—' : `${formatNumber(Number(run.providerQuantity))}${run.providerUnit ? ` ${run.providerUnit}` : ''}`,
    drift: (
      <span className={run.breachedThreshold ? 'text-destructive font-medium' : undefined}>
        {formatDrift(run.relativeDrift)}
        {run.breachedThreshold ? <span className="ml-1 text-xs">(&gt;{run.thresholdPct}%)</span> : null}
      </span>
    ),
    // The reason is the whole value of a skipped row: it says what an operator
    // has to DO — provision a credential, or wait for a client to be written.
    // Wraps rather than clips: this cell carries the only actionable text on a
    // skipped row ("provision THIS key"), so truncating it defeats the screen.
    detail: <span className="text-muted-foreground block max-w-[30rem] text-xs break-words whitespace-normal">{run.reason ?? ''}</span>,
    ranAt: formatDateTime(run.runAt),
  }));

  function onRunNow() {
    runNow.mutate(undefined, {
      onSuccess: (sweep) =>
        toast.success(`Reconciled ${sweep.window} — ${sweep.reconciled} compared, ${sweep.skipped} skipped, ${sweep.failed} failed`),
      onError: (err) => toast.error(err instanceof GatewayError ? err.message : 'Could not run the reconciliation sweep.'),
    });
  }

  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="Provider reconciliation"
          meta={<span>Ledger vs each vendor&apos;s own usage report · platform-wide, CLOUD-funded usage only</span>}
          actions={
            <Button size="sm" onClick={onRunNow} disabled={runNow.isPending}>
              Run now
            </Button>
          }
        />
      }
      stats={<ProviderStatusBoard runs={latest.data ?? []} isLoading={latest.isPending} />}
      toolbar={
        <div className="flex items-center gap-2">
          <Switch id="breached-only" checked={breachedOnly} onCheckedChange={setBreachedOnly} />
          <Label htmlFor="breached-only" className="text-sm font-normal">
            Only runs that breached the drift threshold
          </Label>
        </div>
      }
      footer={
        <StatusFooter
          start={<span>Alert-only — a drift finding never rewrites the ledger; corrections are compensating events</span>}
          end={<span className="font-mono">GLOBAL_ADMIN</span>}
        />
      }
    >
      <MetricTable
        columns={[
          { key: 'provider', label: 'Provider' },
          { key: 'window', label: 'Window' },
          { key: 'status', label: 'Status' },
          { key: 'ledger', label: 'Ledger', format: 'numeric' },
          { key: 'vendor', label: 'Vendor', format: 'numeric' },
          { key: 'drift', label: 'Drift', format: 'numeric' },
          { key: 'detail', label: 'Detail' },
          { key: 'ranAt', label: 'Ran at' },
        ]}
        rows={rows}
        zebra
        caption="Every attempt is recorded — skipped and failed included, because the gap is what an audit asks about"
        aria-label="Provider reconciliation runs"
        isLoading={runs.isPending}
        error={runs.error ?? undefined}
        emptyState={
          <EmptyState
            icon={IconScale}
            title={breachedOnly ? 'No threshold breaches' : 'No reconciliation runs yet'}
            description={
              breachedOnly
                ? 'No run has disagreed with a vendor beyond the drift threshold.'
                : 'The scheduled sweep ships off. Use “Run now” to reconcile the last settled window.'
            }
          />
        }
      />
    </ScreenTemplate>
  );
}

/** Latest outcome per vendor — the "is anything actually reconciling?" answer. */
function ProviderStatusBoard({ runs, isLoading }: { runs: ReconciliationRun[]; isLoading: boolean }) {
  if (isLoading || runs.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {runs.map((run) => (
        <StatCard
          key={run.provider}
          label={run.provider}
          value={run.status === 'reconciled' ? formatDrift(run.relativeDrift) : run.status}
          hint={run.status === 'reconciled' ? `${run.window} · vs ledger` : (run.reason ?? run.window)}
          accent={run.breachedThreshold ? 'destructive' : run.status === 'failed' ? 'warning' : 'default'}
        />
      ))}
    </div>
  );
}
