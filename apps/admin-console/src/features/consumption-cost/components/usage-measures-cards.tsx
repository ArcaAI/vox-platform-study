'use client';

import { IconCloud, IconCpu, IconDatabase } from '@tabler/icons-react';

import { MetricTable } from '@arcaai/ui/components/metrics';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';

import { formatBytes, formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';

import type { UsageSummaryView } from '../api/hooks';

/**
 * TASK-959 — the compute, third-party network and storage cards that ride
 * beside the existing cost cards on the Consumption & Cost screen (§10.2
 * wire contract). Kept in their own file rather than folded into
 * `consumption-cost-screen.tsx` (already the screen's biggest file) — same
 * split as `aggregate.ts` living apart from the screen that renders it.
 *
 * All three read fields that are OPTIONAL on the local `UsageSummaryResponse`
 * mirror (see `api/types.ts`): an older gateway, or a test fixture written
 * before this ticket, simply omits them, and every card below renders its
 * empty state rather than throwing on `undefined`.
 */

/** Fixed-point decimal-string seconds -> "2.418 s"; em-dash for nullish/NaN (matches `formatNumber`'s convention). */
function formatSeconds(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return `${n.toFixed(3)} s`;
}

/** Fixed-point decimal-string GB -> "1.23 GB". Extra precision under 1 GB so a small dev-DB figure doesn't round to "0.00 GB". */
function formatDecimalGb(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  const decimals = Math.abs(n) < 1 ? 4 : 2;
  return `${n.toFixed(decimals)} GB`;
}

export function ComputeCard({ summary }: { summary: UsageSummaryView }) {
  const compute = summary.data?.computeSeconds;
  const rows = compute
    ? [
        { metric: 'GPU seconds', value: formatSeconds(compute.gpuSeconds) },
        { metric: 'CPU seconds', value: formatSeconds(compute.cpuSeconds) },
        { metric: 'Workflow-worker CPU seconds', value: formatSeconds(summary.data?.workflowCpuSeconds) },
      ]
    : [];
  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm font-medium">Compute</h2>
        <p className="text-muted-foreground text-xs">
          GPU vs CPU occupancy across the inference capabilities. The durable worker&rsquo;s own CPU is its own line — it is never added to compute so
          it is never billed twice.
        </p>
      </CardHeader>
      <CardContent>
        <MetricTable
          columns={[
            { key: 'metric', label: 'Measure' },
            { key: 'value', label: 'Seconds', format: 'numeric' },
          ]}
          rows={rows}
          caption="GPU/CPU occupancy seconds and workflow-worker CPU seconds for the working tenant this period"
          aria-label="Compute seconds for the working tenant this period"
          isLoading={summary.isPending}
          error={summary.error ?? undefined}
          emptyState={<EmptyState icon={IconCpu} title="No compute recorded" description="No GPU or CPU occupancy was measured this period." />}
        />
      </CardContent>
    </Card>
  );
}

export function ThirdPartyNetworkCard({ summary }: { summary: UsageSummaryView }) {
  const bytes = summary.data?.thirdPartyBytes;
  const rows = bytes
    ? [
        { metric: 'Egress (to the vendor)', value: <span title={`${bytes.egressBytes} bytes`}>{formatBytes(Number(bytes.egressBytes))}</span> },
        { metric: 'Ingress (from the vendor)', value: <span title={`${bytes.ingressBytes} bytes`}>{formatBytes(Number(bytes.ingressBytes))}</span> },
      ]
    : [];
  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm font-medium">Third-party network</h2>
        <p className="text-muted-foreground text-xs">Bytes that crossed to a vendor (CLOUD or BYOK). Self-hosted LAN traffic is excluded. Hover a value for the exact byte count.</p>
      </CardHeader>
      <CardContent>
        <MetricTable
          columns={[
            { key: 'metric', label: 'Direction' },
            { key: 'value', label: 'Bytes', format: 'numeric' },
          ]}
          rows={rows}
          caption="Third-party egress and ingress bytes for the working tenant this period"
          aria-label="Third-party network bytes for the working tenant this period"
          isLoading={summary.isPending}
          error={summary.error ?? undefined}
          emptyState={<EmptyState icon={IconCloud} title="No third-party traffic" description="No bytes crossed to a vendor this period." />}
        />
      </CardContent>
    </Card>
  );
}

export function StorageCard({ summary }: { summary: UsageSummaryView }) {
  const storage = summary.data?.storage;
  const rows = storage
    ? [
        { metric: 'Media (recordings, attachments)', value: formatDecimalGb(storage.mediaGb) },
        { metric: 'Text (transcripts, notes, entities)', value: formatDecimalGb(storage.textGb) },
        { metric: 'Claim-check (offloaded payloads)', value: formatDecimalGb(storage.claimCheckGb) },
        { metric: 'Total', value: formatDecimalGb(storage.totalGb) },
      ]
    : [];
  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm font-medium">Storage</h2>
        <p className="text-muted-foreground text-xs">
          {storage ? `What the tenant was holding as of ${formatDateTime(storage.asOf, 'date')} — the latest nightly snapshot, not a period sum.` : 'The nightly storage snapshot.'}
        </p>
      </CardHeader>
      <CardContent>
        <MetricTable
          columns={[
            { key: 'metric', label: 'Class' },
            { key: 'value', label: 'GB', format: 'numeric' },
          ]}
          rows={rows}
          caption="Storage held by class at the latest nightly snapshot"
          aria-label="Storage held by class for the working tenant"
          isLoading={summary.isPending}
          error={summary.error ?? undefined}
          emptyState={<EmptyState icon={IconDatabase} title="No snapshot yet" description="The nightly storage snapshot hasn't run for this tenant yet." />}
        />
      </CardContent>
    </Card>
  );
}
