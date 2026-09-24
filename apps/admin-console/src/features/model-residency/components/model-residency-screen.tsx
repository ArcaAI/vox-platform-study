'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { IconCpuOff, IconDots } from '@tabler/icons-react';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@arcaai/ui/components/shadcn/dropdown-menu';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatBytes, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { isTerminalResidencyOperation, useModelResidencyOperation } from '@/shared/residency';
import { modelResidencyKeys, useModelResidency } from '../api';
import type { ModelResidencyModel } from '../api/types';
import { DeviceMemoryPanel } from './device-memory-panel';
import { LoadModelDialog } from './load-model-dialog';
import { PinTtlDialog } from './pin-ttl-dialog';
import { PolicyDrawer } from './policy-drawer';
import { RecommendationsPanel } from './recommendations-panel';
import { UnloadDialog } from './unload-dialog';

const rowId = (row: ModelResidencyModel) => `${row.service}::${row.instance}`;

const STATE_BADGE: Record<ModelResidencyModel['state'], { variant: 'default' | 'secondary' | 'outline'; label: string }> = {
  loaded: { variant: 'default', label: 'Loaded' },
  loading: { variant: 'secondary', label: 'Loading…' },
  unloading: { variant: 'outline', label: 'Unloading…' },
};

type RowActionState =
  | { kind: 'unload'; model: ModelResidencyModel; force: boolean }
  | { kind: 'pin'; model: ModelResidencyModel }
  | { kind: 'policy'; model: ModelResidencyModel }
  | null;

function ModelRowActions({ model, onAction }: { model: ModelResidencyModel; onAction: (state: RowActionState) => void }) {
  const canUnload = model.inFlight === 0;
  return (
    <span className="flex justify-end" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${model.service}/${model.modelRef}`}>
            <IconDots aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!canUnload} onSelect={() => canUnload && onAction({ kind: 'unload', model, force: false })}>
            {canUnload ? 'Unload' : `Unload — disabled (${model.inFlight} in flight)`}
          </DropdownMenuItem>
          {!canUnload ? (
            <DropdownMenuItem variant="destructive" onSelect={() => onAction({ kind: 'unload', model, force: true })}>
              Force unload…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => onAction({ kind: 'pin', model })}>Pin &amp; TTL…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onAction({ kind: 'policy', model })}>Edit policy…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/**
 * Model residency (ticket §5.4) — the platform-admin load/unload/pin/policy
 * control plane over `stt`, `text`, `nlp` and LM Studio (D-11: platform-admin
 * only, tier 10-19, no tenant scope). Devices + resident models + shadow-mode
 * recommendations come from ONE `GET admin/model-residency` read, polled every
 * 10s so the view never lags the ticket's 15s freshness target.
 */
export function ModelResidencyScreen() {
  const query = useModelResidency();
  const queryClient = useQueryClient();
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [rowAction, setRowAction] = useState<RowActionState>(null);
  const [pendingOperationId, setPendingOperationId] = useState<string | null>(null);
  const operationQuery = useModelResidencyOperation(pendingOperationId);

  // The load dialog hands back an operationId (async accept) or null (already
  // resident, synchronous). Poll the operation to a terminal state, then
  // refresh the residency read so the optimistic `loading` row is replaced by
  // the real one (or removed, on failure) — ticket §5.4 "async load polls the
  // operation to terminal and updates the row". No `setPendingOperationId`
  // here: `refetchInterval` already stops polling once terminal
  // (react-hooks/set-state-in-effect), and the id is overwritten by the NEXT
  // load's `onLoadStarted` regardless.
  useEffect(() => {
    const operation = operationQuery.data;
    if (!operation || !isTerminalResidencyOperation(operation.status)) return;
    void queryClient.invalidateQueries({ queryKey: modelResidencyKeys.list() });
    if (operation.status === 'succeeded') {
      toast.success(`${operation.service}/${operation.modelRef} loaded.`);
    } else {
      toast.error(operation.error?.message || `Loading ${operation.service}/${operation.modelRef} failed.`);
    }
  }, [operationQuery.data, queryClient]);

  const devices = query.data?.devices ?? [];
  const models = useMemo(() => query.data?.models ?? [], [query.data]);
  const recommendations = query.data?.recommendations ?? [];

  const columns = useMemo<ColumnDef<ModelResidencyModel>[]>(
    () => [
      {
        accessorKey: 'service',
        header: 'Service',
        meta: { label: 'Service' },
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.service}</span>,
        size: 100,
      },
      {
        accessorKey: 'modelRef',
        header: 'Model',
        meta: { label: 'Model' },
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="truncate font-mono text-xs">{row.original.modelRef}</span>
            {row.original.aiModelName ? <span className="text-muted-foreground truncate text-xs">{row.original.aiModelName}</span> : null}
          </div>
        ),
        size: 220,
        minSize: 160,
      },
      {
        accessorKey: 'device',
        header: 'Device',
        meta: { label: 'Device' },
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.device}</span>,
        size: 90,
      },
      {
        id: 'state',
        accessorFn: (row) => row.state,
        header: 'State',
        meta: { label: 'State' },
        cell: ({ row }) => {
          const badge = STATE_BADGE[row.original.state];
          return <Badge variant={badge.variant}>{badge.label}</Badge>;
        },
        size: 110,
      },
      {
        id: 'bytes',
        accessorFn: (row) => row.bytes ?? 0,
        header: 'Size',
        meta: { label: 'Size' },
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="tabular-nums">{formatBytes(row.original.bytes)}</span>
            <span className="text-muted-foreground text-xs">
              {row.original.bytesSource === 'measured' ? 'measured' : row.original.bytesSource === 'estimated' ? 'estimated' : 'unknown'}
            </span>
          </span>
        ),
        size: 120,
      },
      {
        id: 'inFlight',
        accessorFn: (row) => row.inFlight,
        header: 'In-flight',
        meta: { label: 'In-flight' },
        cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.inFlight)}</span>,
        size: 90,
      },
      {
        id: 'requestsPerMin',
        accessorFn: (row) => row.requestsPerMin ?? -1,
        header: 'Req/min',
        meta: { label: 'Req/min' },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.requestsPerMin === null ? '—' : formatNumber(Math.round(row.original.requestsPerMin * 10) / 10)}
          </span>
        ),
        size: 90,
      },
      {
        id: 'p50LatencyMs',
        accessorFn: (row) => row.p50LatencyMs ?? -1,
        header: 'p50',
        meta: { label: 'p50 latency' },
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.p50LatencyMs === null ? '—' : `${formatNumber(row.original.p50LatencyMs)} ms`}</span>
        ),
        size: 90,
      },
      {
        id: 'lastUsedAt',
        accessorFn: (row) => row.lastUsedAt ?? '',
        header: 'Last used',
        meta: { label: 'Last used' },
        cell: ({ row }) => <span>{formatRelativeTime(row.original.lastUsedAt)}</span>,
        size: 110,
      },
      {
        id: 'class',
        accessorFn: (row) => row.class,
        header: 'Class',
        meta: { label: 'Class' },
        cell: ({ row }) => (
          <span className="flex flex-col">
            <Badge variant={row.original.class === 'PINNED' ? 'default' : row.original.class === 'WARM' ? 'secondary' : 'outline'}>
              {row.original.class}
            </Badge>
            <span className="text-muted-foreground text-xs">{row.original.classSource}</span>
          </span>
        ),
        size: 130,
      },
      {
        id: 'ttlSeconds',
        accessorFn: (row) => row.ttlSeconds ?? -1,
        header: 'TTL',
        meta: { label: 'TTL' },
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.ttlSeconds === null ? '—' : `${formatNumber(row.original.ttlSeconds)}s`}</span>
        ),
        size: 90,
      },
      {
        id: 'pinned',
        accessorFn: (row) => row.pinned,
        header: 'Pinned',
        meta: { label: 'Pinned' },
        cell: ({ row }) =>
          row.original.pinned ? (
            <Badge variant="secondary">{row.original.adminPinned ? 'Pinned' : 'Pinned (live path)'}</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        size: 130,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        meta: { label: 'Actions' },
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        enableGlobalFilter: false,
        size: 56,
        minSize: 56,
        cell: ({ row }) => <ModelRowActions model={row.original} onAction={setRowAction} />,
      },
    ],
    [],
  );

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Model residency"
            meta={
              <>
                <Badge variant={query.data?.mode === 'enforce' ? 'default' : 'secondary'}>
                  {query.data?.mode === 'enforce' ? 'Enforce' : 'Shadow'}
                </Badge>
                <span>
                  {formatNumber(models.length)} resident model{models.length === 1 ? '' : 's'}
                </span>
              </>
            }
            actions={<Button onClick={() => setLoadDialogOpen(true)}>Load model</Button>}
          />
        }
        stats={
          query.data ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <DeviceMemoryPanel devices={devices} models={models} freshness={query.data.freshness} />
              <RecommendationsPanel recommendations={recommendations} />
            </div>
          ) : undefined
        }
        footer={
          <StatusFooter
            start={<span>auto-refresh 10s{query.data ? ` · reported ${formatRelativeTime(query.data.reportedAt)}` : ''}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/model-residency
              </span>
            }
          />
        }
      >
        <VirtualizedDataGrid<ModelResidencyModel>
          aria-label="Resident models"
          columns={columns}
          data={models}
          getRowId={rowId}
          features={{
            globalSearch: true,
            sorting: true,
            rowSelection: false,
            columnReorder: true,
            columnResize: true,
            columnPinning: true,
            columnVisibility: true,
          }}
          persistence={gridPersistence('model-residency')}
          isLoading={query.isLoading}
          isBusy={query.isFetching && !query.isLoading}
          error={models.length === 0 ? (query.error ?? undefined) : undefined}
          errorState={(error) => <ErrorState error={error} onRetry={() => void query.refetch()} />}
          onRetry={() => void query.refetch()}
          emptyState={
            <EmptyState icon={IconCpuOff} title="No resident models" description="Nothing is loaded on stt, text, nlp or LM Studio right now." />
          }
        />
      </ScreenTemplate>

      <LoadModelDialog open={loadDialogOpen} onOpenChange={setLoadDialogOpen} onLoadStarted={setPendingOperationId} />

      <UnloadDialog
        open={rowAction?.kind === 'unload'}
        onOpenChange={(next) => {
          if (!next) setRowAction(null);
        }}
        model={rowAction?.kind === 'unload' ? rowAction.model : null}
        force={rowAction?.kind === 'unload' ? rowAction.force : false}
      />

      <PinTtlDialog
        open={rowAction?.kind === 'pin'}
        onOpenChange={(next) => {
          if (!next) setRowAction(null);
        }}
        model={rowAction?.kind === 'pin' ? rowAction.model : null}
      />

      {rowAction?.kind === 'policy' ? (
        <PolicyDrawer
          open
          onOpenChange={(next) => {
            if (!next) setRowAction(null);
          }}
          model={rowAction.model}
          devices={devices}
        />
      ) : null}
    </>
  );
}
