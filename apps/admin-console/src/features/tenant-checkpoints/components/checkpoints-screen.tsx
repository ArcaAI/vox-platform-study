'use client';

import { useMemo, useState } from 'react';
import { IconAlertTriangle, IconArchive, IconPlus, IconUpload } from '@tabler/icons-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import type { ColumnDef } from '@arcaai/ui';
import { Alert, AlertDescription } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { useSession } from '@/shared/auth';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import { formatBytes, formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { isRestoreActive, isRestoreLockError, useCheckpoints, useRestores, useTenantName } from '../api';
import type { TenantCheckpoint } from '../api';
import { CheckpointDrawer } from './checkpoint-drawer';
import { CreateCheckpointSheet } from './create-checkpoint-sheet';
import { RestoreDialog } from './restore-dialog';
import { RestoreHistory } from './restore-history';
import { CheckpointStatusBadge } from './status-badges';
import { UploadCheckpointDialog } from './upload-checkpoint-dialog';

const TABS = ['checkpoints', 'history'] as const;
const EMPTY = '—';
const TITLE = 'Checkpoints';

const COLUMNS: ColumnDef<TenantCheckpoint>[] = [
  {
    accessorKey: 'label',
    header: 'Label',
    enableSorting: false,
    meta: { label: 'Label' },
    cell: ({ row }) => <span className="truncate font-medium">{row.original.label}</span>,
    size: 260,
    minSize: 160,
  },
  {
    accessorKey: 'kind',
    header: 'Kind',
    enableSorting: false,
    meta: { label: 'Kind' },
    cell: ({ row }) => <Badge variant={row.original.kind === 'SAFETY' ? 'secondary' : 'outline'}>{row.original.kind === 'SAFETY' ? 'Safety' : 'Manual'}</Badge>,
    size: 100,
  },
  {
    accessorKey: 'origin',
    header: 'Origin',
    enableSorting: false,
    meta: { label: 'Origin' },
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.origin === 'UPLOADED' ? 'Uploaded' : 'Created'}</span>,
    size: 100,
  },
  {
    accessorKey: 'status',
    header: 'Status',
    enableSorting: false,
    meta: { label: 'Status' },
    cell: ({ row }) => <CheckpointStatusBadge checkpoint={row.original} />,
    size: 260,
  },
  {
    accessorKey: 'sizeBytes',
    header: 'Size',
    enableSorting: false,
    meta: { label: 'Size' },
    cell: ({ row }) => <span className="text-muted-foreground tabular-nums">{formatBytes(row.original.sizeBytes)}</span>,
    size: 100,
  },
  {
    accessorKey: 'createdAt',
    header: 'Created',
    enableSorting: false,
    meta: { label: 'Created' },
    cell: ({ row }) => (
      <span className="text-muted-foreground" title={formatDateTime(row.original.createdAt)}>
        {formatRelativeTime(row.original.createdAt)}
      </span>
    ),
    size: 140,
  },
  {
    accessorKey: 'expiresAt',
    header: 'Expires',
    enableSorting: false,
    meta: { label: 'Expires' },
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.expiresAt ? formatDateTime(row.original.expiresAt, 'date') : EMPTY}</span>,
    size: 130,
  },
];

function LockBanner() {
  return (
    <Alert variant="destructive">
      <IconAlertTriangle aria-hidden />
      <AlertDescription>Restore in progress — this tenant is read-only until it finishes.</AlertDescription>
    </Alert>
  );
}

function CheckpointsBody({ tenantId }: { tenantId: string }) {
  const session = useSession();
  const isSuperAdmin = session.data?.effectiveIsElevated ?? false;
  const knownName = session.data?.workingTenantId === tenantId ? session.data.workingTenantName : null;
  const tenantName = useTenantName(tenantId, knownName);
  const resolvedName = knownName ?? tenantName.data ?? null;

  const [tab, setTab] = useQueryState('tab', parseAsStringLiteral(TABS).withDefault('checkpoints'));
  const query = useAdminGridParams();
  const list = useCheckpoints(tenantId, query.listParams);
  const latestRestores = useRestores(tenantId, { limit: 5 });
  const { rows, total } = normalizeList<TenantCheckpoint>(list.data);

  const [createOpen, setCreateOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<TenantCheckpoint | null>(null);
  const [lockedByWrite, setLockedByWrite] = useState(false);

  const selected = useMemo(() => rows.find((row) => row.id === selectedId) ?? null, [rows, selectedId]);
  const locked =
    lockedByWrite ||
    isRestoreLockError(list.error) ||
    isRestoreLockError(latestRestores.error) ||
    (latestRestores.data?.data.some((restore) => isRestoreActive(restore.status)) ?? false);
  const onLocked = () => setLockedByWrite(true);

  const createAction = (
    <Button onClick={() => setCreateOpen(true)} disabled={locked}>
      <IconPlus aria-hidden />
      Create checkpoint
    </Button>
  );

  return (
    <>
      <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTab(next === 'checkpoints' ? null : (next as (typeof TABS)[number]))}>
        <ScreenTemplate
          contentMode="fill"
          header={
            <PageHeader
              title={TITLE}
              meta={
                <>
                  {list.data ? <span>{formatNumber(total ?? 0)} checkpoints</span> : <Skeleton className="h-4 w-24" />}
                  <span aria-hidden>&middot;</span>
                  <span>encrypted tenant archives</span>
                </>
              }
              actions={
                <>
                  <Button variant="outline" onClick={() => setUploadOpen(true)} disabled={locked}>
                    <IconUpload aria-hidden />
                    Upload checkpoint
                  </Button>
                  {createAction}
                </>
              }
            />
          }
          statusBanner={locked ? <LockBanner /> : null}
          tabs={
            <TabsList variant="line">
              <TabsTrigger value="checkpoints">Checkpoints</TabsTrigger>
              <TabsTrigger value="history">Restore history</TabsTrigger>
            </TabsList>
          }
          footer={
            <StatusFooter
              start={<span>{list.isFetching && !list.isLoading ? 'Refreshing' : 'Up to date'}</span>}
              end={
                <span aria-hidden className="font-mono">
                  GET /admin/tenants/:id/checkpoints
                </span>
              }
            />
          }
        >
          <TabsContent value="checkpoints" className="flex min-h-0 flex-1 flex-col">
            <AdminDataGrid<TenantCheckpoint>
              gridId="tenant-checkpoints"
              aria-label="Checkpoints"
              columns={COLUMNS}
              rows={rows}
              total={total ?? 0}
              queryState={query.queryState}
              onQueryStateChange={query.setQueryState}
              isLoading={list.isLoading}
              isBusy={list.isFetching && !list.isLoading}
              error={isRestoreLockError(list.error) ? null : list.error}
              onRetry={() => list.refetch()}
              onRowClick={(row) => setSelectedId(row.id)}
              emptyState={
                <EmptyState
                  icon={IconArchive}
                  title="Create your first checkpoint"
                  description="A checkpoint captures this tenant's data so you can download it or roll the tenant back later."
                  action={createAction}
                />
              }
              emptyFilteredState={<EmptyState icon={IconArchive} title="No checkpoints match" />}
            />
          </TabsContent>
          <TabsContent value="history" className="flex min-h-0 flex-1 flex-col">
            <RestoreHistory tenantId={tenantId} />
          </TabsContent>
        </ScreenTemplate>
      </Tabs>
      <CheckpointDrawer
        checkpoint={selected}
        tenantId={tenantId}
        onClose={() => setSelectedId(null)}
        onRestore={(target) => setRestoreTarget(target)}
        onLocked={onLocked}
      />
      <CreateCheckpointSheet open={createOpen} onOpenChange={setCreateOpen} tenantId={tenantId} onLocked={onLocked} />
      <UploadCheckpointDialog open={uploadOpen} onOpenChange={setUploadOpen} tenantId={tenantId} onLocked={onLocked} />
      {restoreTarget && resolvedName ? (
        <RestoreDialog
          open
          onOpenChange={(open) => !open && setRestoreTarget(null)}
          tenantId={tenantId}
          tenantName={resolvedName}
          checkpoint={restoreTarget}
          isSuperAdmin={isSuperAdmin}
          onLocked={onLocked}
          onRestored={() => {
            setRestoreTarget(null);
            setSelectedId(null);
            void setTab('history');
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Tenant checkpoints (/checkpoints, tier 30-49, working-tenant scoped): create,
 * upload, download, restore (break-glass + category picker) and restore history.
 */
export function CheckpointsScreen() {
  const session = useSession();
  const tenantId = session.data?.effectiveTenantId ?? null;

  return (
    <WorkingTenantGate title={TITLE}>
      {tenantId ? (
        <CheckpointsBody tenantId={tenantId} />
      ) : (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}
    </WorkingTenantGate>
  );
}
