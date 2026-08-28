'use client';

/**
 * Definitions list (TASK-719 Task 16, frame `NN.4 - Workflow Studio — Definitions List`).
 * Follows `features/workflow-runs/components/workflow-runs-screen.tsx` closely (same
 * `ScreenTemplate` + `VirtualizedDataGrid` + `WorkingTenantGate` shape) — the sibling ticket in
 * the same program, already built against a real `admin/workflow-*` endpoint.
 */
import { useState } from 'react';
import { IconLayoutGrid, IconListNumbers, IconListTree, IconPlus, IconRefresh } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Button, VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { workflowStudioKeys, useWorkflowDefinitions } from '../api';
import type { WorkflowDefinition } from '../api/types';
import { EndpointSequenceEditor } from './endpoint-sequence';

const PAGE_SIZE = 25;

const STATUS_VARIANT: Record<WorkflowDefinition['status'], 'default' | 'secondary' | 'outline'> = {
  DRAFT: 'outline',
  VALIDATED: 'secondary',
  PUBLISHED: 'default',
  DEPRECATED: 'outline',
};

function DefinitionsListBody() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [page, setPage] = useState(0);
  // TASK-812 (D-10) — the endpoint sequence opens in the console-wide detail surface rather than
  // taking a slot on this page: the screen is `contentMode="fill"` (the grid owns the height), so
  // an inline panel would either nest a second scroll container or squeeze the grid.
  const [endpointOpen, setEndpointOpen] = useState(false);

  const definitionsQuery = useWorkflowDefinitions({ page, limit: PAGE_SIZE });
  const rows = definitionsQuery.data?.data ?? [];

  const queryState: DataQueryState = { pagination: { mode: 'offset', page, limit: PAGE_SIZE }, sorting: [], filters: [], globalSearch: undefined };
  const setQueryState = (next: DataQueryState) => setPage(next.pagination.mode === 'offset' ? next.pagination.page : 0);

  const columns: ColumnDef<WorkflowDefinition>[] = [
    {
      accessorKey: 'name',
      header: 'Name',
      meta: { label: 'Name' },
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="truncate font-medium">{row.original.name}</span>
          <span className="text-muted-foreground font-mono text-xs">
            {row.original.slug} &middot; v{row.original.versionNumber}
          </span>
        </div>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      meta: { label: 'Status' },
      cell: ({ row }) => (
        <div className="flex items-center gap-1.5">
          <Badge variant={STATUS_VARIANT[row.original.status]}>{row.original.status}</Badge>
          {row.original.needsReview ? (
            <Badge variant="destructive" title="Published against an older node registry — re-publish to clear.">
              Needs review
            </Badge>
          ) : null}
        </div>
      ),
    },
    { accessorKey: 'paletteKey', header: 'Palette', meta: { label: 'Palette' } },
    {
      accessorKey: 'isActive',
      header: 'Active',
      meta: { label: 'Active' },
      cell: ({ row }) => (row.original.isActive ? <span className="text-success-strong text-xs font-medium">Active</span> : null),
    },
    {
      accessorKey: 'updatedAt',
      header: 'Updated',
      meta: { label: 'Updated' },
      cell: ({ row }) => (
        <span className="whitespace-nowrap" title={row.original.updatedAt}>
          {formatRelativeTime(row.original.updatedAt)}
        </span>
      ),
    },
  ];

  return (
    <ScreenTemplate
      contentMode="fill"
      header={
        <PageHeader
          title="Workflow Studio"
          meta={<span>Author, validate and publish workflow definitions for this tenant.</span>}
          actions={
            <>
              <Button variant="outline" asChild>
                <Link href="/workflow-studio/assignments">
                  <IconLayoutGrid aria-hidden />
                  Assignments
                </Link>
              </Button>
              <Button variant="outline" onClick={() => setEndpointOpen(true)}>
                <IconListNumbers aria-hidden />
                Endpoint sequence
              </Button>
              <Button variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: workflowStudioKeys.root })}>
                <IconRefresh aria-hidden />
                Refresh
              </Button>
              <Button onClick={() => router.push('/workflow-studio/new')}>
                <IconPlus aria-hidden />
                New definition
              </Button>
            </>
          }
        />
      }
      footer={
        <StatusFooter
          start={<span>Definitions are versioned — publishing freezes a row; edits after that create a new version.</span>}
          end={
            <span aria-hidden className="font-mono">
              GET /admin/workflow-definitions
            </span>
          }
        />
      }
    >
      <VirtualizedDataGrid<WorkflowDefinition>
        aria-label="Workflow definitions"
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        persistence={gridPersistence('workflow-definitions')}
        manual={{ pagination: true }}
        rowCount={definitionsQuery.data?.count ?? 0}
        pageMode="offset"
        queryState={queryState}
        onQueryStateChange={setQueryState}
        features={{
          columnReorder: true,
          columnResize: true,
          columnPinning: true,
          columnVisibility: true,
          rowSelection: false,
          globalSearch: false,
          facetedFilters: false,
          sorting: false,
        }}
        isLoading={definitionsQuery.isLoading}
        isBusy={definitionsQuery.isFetching && !definitionsQuery.isLoading}
        error={definitionsQuery.error}
        onRetry={() => void definitionsQuery.refetch()}
        errorState={(err) => <ErrorState error={err} onRetry={() => void definitionsQuery.refetch()} />}
        emptyState={
          <EmptyState
            icon={IconListTree}
            title="No workflow definitions yet"
            description="Create one from the node registry — Studio v1 renders whatever node types the registry serves."
            action={
              <Button onClick={() => router.push('/workflow-studio/new')}>
                <IconPlus aria-hidden />
                New definition
              </Button>
            }
          />
        }
        onRowClick={(row) => router.push(`/workflow-studio/${encodeURIComponent(row.id)}`)}
      />
      <DetailDrawer
        open={endpointOpen}
        onOpenChange={setEndpointOpen}
        title="Consultation endpoint sequence"
        size="lg"
        meta={
          <span>
            The ordered steps that run before a consultation session closes — including when it reaches its idle bound. Saved for this tenant.
          </span>
        }
      >
        <EndpointSequenceEditor scope="tenant" />
      </DetailDrawer>
    </ScreenTemplate>
  );
}

export function DefinitionsListScreen() {
  return (
    <WorkingTenantGate
      title="Workflow Studio"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/workflow-definitions
        </span>
      }
      description="Workflow definitions are tenant-scoped. Pick a working tenant from the top-bar switcher to load its definitions."
    >
      <DefinitionsListBody />
    </WorkingTenantGate>
  );
}
