'use client';

import { useMemo, useState } from 'react';
import { IconBrain, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { normalizeList } from '@/shared/data/envelopes';
import { NameWithId } from '@/shared/data/name-with-id';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useDeleteDnaMemorySample, useDnaMemory, useDnaMemorySummary } from '../api';
import type { DnaMemorySample, DnaMemorySummaryRow, DnaSampleSource } from '../api';

const SAMPLE_PAGE_SIZE = 20;
const SOURCES: DnaSampleSource[] = ['EDIT', 'SIGNOFF', 'INGEST'];

export function clinicianLabel(row: Pick<DnaMemorySummaryRow, 'displayName' | 'username' | 'doctorId'>): string {
  return row.displayName || row.username || row.doctorId;
}

function relative(value: string | null): string {
  return value ? formatRelativeTime(value) : '—';
}

/** Per-clinician memory roll-up (`GET memory/summary`); a row opens that clinician's samples. */
export function MemoryTab() {
  const summary = useDnaMemorySummary();
  const [selected, setSelected] = useState<DnaMemorySummaryRow | null>(null);
  const rows = summary.data ?? [];

  const columns = useMemo<ColumnDef<DnaMemorySummaryRow>[]>(
    () => [
      {
        accessorKey: 'doctorId',
        header: 'Clinician',
        enableSorting: false,
        size: 240,
        meta: { label: 'Clinician' },
        cell: ({ row }) => <NameWithId name={row.original.displayName || row.original.username || undefined} id={row.original.doctorId} />,
      },
      {
        accessorKey: 'total',
        header: 'Total',
        enableSorting: false,
        size: 90,
        meta: { label: 'Total' },
        cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.total)}</span>,
      },
      {
        accessorKey: 'unconsumed',
        header: 'Unconsumed',
        enableSorting: false,
        size: 120,
        meta: { label: 'Unconsumed' },
        cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.unconsumed)}</span>,
      },
      {
        id: 'bySource',
        header: 'By source',
        enableSorting: false,
        size: 240,
        meta: { label: 'By source' },
        cell: ({ row }) => (
          <span className="text-muted-foreground font-mono text-xs">
            {SOURCES.map((source) => `${source} ${row.original.bySource?.[source] ?? 0}`).join(' · ')}
          </span>
        ),
      },
      {
        accessorKey: 'lastSampleAt',
        header: 'Last sample',
        enableSorting: false,
        size: 140,
        meta: { label: 'Last sample' },
        cell: ({ row }) => <span className="text-muted-foreground">{relative(row.original.lastSampleAt)}</span>,
      },
      {
        accessorKey: 'lastReportAt',
        header: 'Last report',
        enableSorting: false,
        size: 140,
        meta: { label: 'Last report' },
        cell: ({ row }) => <span className="text-muted-foreground">{relative(row.original.lastReportAt)}</span>,
      },
      {
        accessorKey: 'dnaEnabled',
        header: 'DNA',
        enableSorting: false,
        size: 110,
        meta: { label: 'DNA' },
        cell: ({ row }) => (row.original.dnaEnabled ? <Badge variant="default">DNA on</Badge> : <Badge variant="outline">DNA off</Badge>),
      },
    ],
    [],
  );

  return (
    <>
      <VirtualizedDataGrid<DnaMemorySummaryRow>
        aria-label="Writing-style memory by clinician"
        columns={columns}
        data={rows}
        getRowId={(row) => row.doctorId}
        rowCount={rows.length}
        features={{
          columnReorder: false,
          columnResize: true,
          columnPinning: false,
          columnVisibility: false,
          rowSelection: false,
          globalSearch: false,
          facetedFilters: false,
          sorting: false,
        }}
        onRowClick={(row) => setSelected(row)}
        isLoading={summary.isLoading}
        isBusy={summary.isFetching && !summary.isLoading}
        error={rows.length > 0 ? null : (summary.error ?? null)}
        errorState={(error) => <ErrorState error={error} onRetry={() => void summary.refetch()} />}
        onRetry={() => void summary.refetch()}
        emptyState={
          <EmptyState
            icon={IconBrain}
            title="No writing-style memory yet"
            description="Samples appear when clinicians edit or sign off generated summaries, or when you ingest history on the Ingest tab."
          />
        }
      />
      <MemorySamplesDrawer
        key={selected?.doctorId ?? 'none'}
        clinician={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </>
  );
}

function MemorySamplesDrawer({ clinician, onOpenChange }: { clinician: DnaMemorySummaryRow | null; onOpenChange: (open: boolean) => void }) {
  const [source, setSource] = useState<DnaSampleSource | ''>('');
  const [consumed, setConsumed] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);
  const [pendingDelete, setPendingDelete] = useState<DnaMemorySample | null>(null);
  const remove = useDeleteDnaMemorySample();

  const samples = useDnaMemory(
    clinician
      ? {
          doctorId: clinician.doctorId,
          page,
          limit: SAMPLE_PAGE_SIZE,
          ...(source ? { source } : {}),
          ...(consumed ? { consumed: consumed === 'true' } : {}),
        }
      : null,
  );
  const { rows, total } = normalizeList<DnaMemorySample>(samples.data);
  const totalCount = total ?? rows.length;
  const lastPage = Math.max(1, Math.ceil(totalCount / SAMPLE_PAGE_SIZE));

  async function confirmDelete() {
    if (!pendingDelete) return;
    try {
      await remove.mutateAsync(pendingDelete.id);
      toast.success('Memory sample deleted');
      setPendingDelete(null);
    } catch (error) {
      toast.error(error instanceof GatewayError ? error.message : 'Could not delete the sample.');
    }
  }

  return (
    <>
      <DetailDrawer
        open={!!clinician}
        onOpenChange={onOpenChange}
        size="lg"
        title={clinician ? clinicianLabel(clinician) : 'Clinician memory'}
        badges={clinician ? <Badge variant="secondary">{formatNumber(clinician.total)} samples</Badge> : null}
        meta={clinician ? <span className="font-mono">{clinician.doctorId}</span> : null}
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs tabular-nums">
              Page {page} of {lastPage} {'·'} {formatNumber(totalCount)} samples
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= lastPage} onClick={() => setPage((value) => value + 1)}>
                Next
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dna-memory-source">Source</Label>
              <NativeSelect
                id="dna-memory-source"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value as DnaSampleSource | '');
                  setPage(1);
                }}
              >
                <NativeSelectOption value="">All sources</NativeSelectOption>
                {SOURCES.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {value}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dna-memory-consumed">Consumed</Label>
              <NativeSelect
                id="dna-memory-consumed"
                value={consumed}
                onChange={(event) => {
                  setConsumed(event.target.value as '' | 'true' | 'false');
                  setPage(1);
                }}
              >
                <NativeSelectOption value="">All</NativeSelectOption>
                <NativeSelectOption value="false">Not yet consumed</NativeSelectOption>
                <NativeSelectOption value="true">Consumed by a report</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>

          {samples.isLoading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-20 w-full" />
              ))}
            </div>
          ) : samples.isError && rows.length === 0 ? (
            <ErrorState error={samples.error} onRetry={() => void samples.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState icon={IconBrain} title="No samples" description="No memory samples match these filters." />
          ) : (
            <ul className="flex flex-col gap-3" aria-label="Memory samples">
              {rows.map((sample) => (
                <li key={sample.id} className="flex flex-col gap-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{sample.source}</Badge>
                    {sample.kind ? <Badge variant="outline">{sample.kind}</Badge> : null}
                    {sample.consumed ? <Badge variant="outline">Consumed</Badge> : <Badge variant="default">New</Badge>}
                    <span className="text-muted-foreground text-xs">written {formatRelativeTime(sample.writtenAt)}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto"
                      aria-label={`Delete sample ${sample.id}`}
                      onClick={() => setPendingDelete(sample)}
                    >
                      <IconTrash aria-hidden />
                    </Button>
                  </div>
                  <p className="text-sm break-words whitespace-pre-wrap">{sample.preview}</p>
                  <p className="text-muted-foreground font-mono text-xs">
                    {sample.id}
                    {sample.sourceRef ? ` · ${sample.sourceRef}` : ''}
                    {sample.consultationId ? ` · consultation ${sample.consultationId}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DetailDrawer>
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        destructive
        title="Delete this memory sample?"
        description="The sample is soft-deleted and will no longer feed future DNA reports. Existing reports are not changed."
        confirmLabel="Delete sample"
        isPending={remove.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}
