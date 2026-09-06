'use client';

import { useCallback, useMemo, useState } from 'react';
import { IconCpu, IconDatabaseSearch, IconFilterOff, IconPencil, IconPlus, IconRadar, IconStar, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { type ColumnDef, type SortRule } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useModelCatalogue } from '@/shared/catalog';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useDeleteModel, useLastInventoryReport, useModelsPaginated, useRunModelInventory } from '../api/hooks';
import type { AiModel, UnregisteredBucketPrefix } from '../api/types';
import { AvailabilityBadge, AVAILABILITY_META } from './availability-badge';
import { DiscoveryDrawer } from './discovery-drawer';
import { ModelFormSheet, type ModelFormSeed } from './model-form-sheet';
import {
  AVAILABILITY_OPTIONS,
  DEPLOYMENT_KIND_LABELS,
  DEPLOYMENT_KIND_OPTIONS,
  LIBRARY_OPTIONS,
  SERVED_BY_OPTIONS,
  TASK_KIND_LABELS,
  pipelineTagRank,
} from './model-meta';
import { PlatformDefaultDialog } from './platform-default-dialog';
import { UnregisteredPrefixesDrawer } from './unregistered-prefixes-drawer';

/** Omni search targets (→ gateway `searchFields`) and the implicit sort — stable refs for the hook. */
const AI_MODEL_SEARCH_FIELDS = ['name', 'slug'];
const AI_MODEL_DEFAULT_SORT: SortRule[] = [{ id: 'name', desc: false }];

const LIBRARY_FILTER_OPTIONS: FilterOption[] = LIBRARY_OPTIONS.map((library) => ({ value: library, label: library }));
const SERVED_BY_FILTER_OPTIONS: FilterOption[] = SERVED_BY_OPTIONS.map((workload) => ({ value: workload, label: workload }));
const DEPLOYMENT_FILTER_OPTIONS: FilterOption[] = DEPLOYMENT_KIND_OPTIONS.map((kind) => ({ value: kind, label: DEPLOYMENT_KIND_LABELS[kind] }));
const AVAILABILITY_FILTER_OPTIONS: FilterOption[] = AVAILABILITY_OPTIONS.map((availability) => ({ value: availability, label: AVAILABILITY_META[availability].label }));
const STATUS_OPTIONS: FilterOption[] = [
  { value: 'ENABLED', label: 'Enabled' },
  { value: 'DISABLED', label: 'Disabled' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'ARCHIVED', label: 'Archived' },
];

/** Edit / platform-default / retire row actions — module-level so the column memo stays stable. */
function ModelRowActions({ model, onEdit, onPlatformDefault, onDelete }: { model: AiModel; onEdit: () => void; onPlatformDefault: () => void; onDelete: () => void }) {
  return (
    <span className="flex w-full items-center justify-end gap-1">
      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${model.name}`} onClick={onEdit}>
        <IconPencil aria-hidden />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={`Set platform default for ${model.name}`} onClick={onPlatformDefault}>
        <IconStar aria-hidden />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={`Retire ${model.name}`} onClick={onDelete}>
        <IconTrash aria-hidden />
      </Button>
    </span>
  );
}

/** Rows in Hugging Face task order, then by name — the "grouped by pipeline_tag" reading of the page. */
function orderByPipelineTag(rows: AiModel[]): AiModel[] {
  return [...rows].sort((a, b) => pipelineTagRank(a.pipelineTag) - pipelineTagRank(b.pipelineTag) || a.pipelineTag.localeCompare(b.pipelineTag) || a.name.localeCompare(b.name));
}

/**
 * Frame 15 — AI Model Registry (/ai-models, tier 10-19), TASK-860 v2.
 *
 * ONE catalogue, SYSTEM-owned, organised the way the Hugging Face Hub is:
 * task (`pipelineTag`) → serving library → model. Columns: Model · Task ·
 * Library · Served by · Deployment · Availability (measured by the inventory,
 * with when it was checked) · Platform default for · Licence/gated · Status ·
 * Updated. Facets: library, served-by, deployment kind, availability, status.
 *
 * Header actions: Register (drawer), Run inventory (measures every row against
 * the bucket and opens "In bucket, not registered" when it finds orphans),
 * Loaded on engines (read-only live discovery). Row actions: edit, set
 * platform default per task, retire.
 */
export function AiModelsScreen() {
  const query = useAdminGridParams({ searchFields: AI_MODEL_SEARCH_FIELDS, defaultSort: AI_MODEL_DEFAULT_SORT });
  const { data, isLoading, isFetching, error, refetch } = useModelsPaginated(query.listParams);
  const { rows: pageRows, total } = normalizeList<AiModel>(data);
  const rows = orderByPipelineTag(pageRows);
  const totalCount = total ?? 0;

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetSeed, setSheetSeed] = useState<ModelFormSeed | undefined>(undefined);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [unregisteredOpen, setUnregisteredOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AiModel | null>(null);
  const [defaultTarget, setDefaultTarget] = useState<AiModel | null>(null);
  const deleteMutation = useDeleteModel();
  const inventoryMutation = useRunModelInventory();
  const lastInventory = useLastInventoryReport();
  // TASK-890 §3.7 Risk 6 — a catalogue row naming no provider this platform can
  // serve is HIDDEN from every picker. Counted here (a super-admin-only field on
  // the catalogue payload) so the person who can assign a provider can see that
  // the rows exist at all; `undefined` means the field was not served, which is
  // not the same answer as zero, so neither renders a badge.
  const unassignedProviderCount = useModelCatalogue().data?.unassignedProviderCount ?? 0;

  const openCreate = (seed?: ModelFormSeed) => {
    setEditingId(null);
    setSheetSeed(seed);
    setSheetOpen(true);
  };

  const clearFilters = useCallback(() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] }), [query]);

  function handleDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast.success('Model retired');
        setDeleteTarget(null);
      },
      onError: (error) => toast.error(error.message),
    });
  }

  function runInventory() {
    inventoryMutation.mutate(undefined, {
      onSuccess: (report) => {
        const { available, missing, partial, notApplicable } = report.counts;
        toast.success(`Inventory: ${available} available · ${missing} missing · ${partial} partial · ${notApplicable} not applicable`);
        if (report.unregistered.length > 0) setUnregisteredOpen(true);
      },
      onError: (err) => toast.error(err.message),
    });
  }

  function registerFromBucket(prefix: UnregisteredBucketPrefix) {
    setUnregisteredOpen(false);
    openCreate({ slug: prefix.slug ?? '', name: prefix.slug ?? '', bucketPrefix: prefix.bucketPrefix });
  }

  const columns = useMemo<ColumnDef<AiModel>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Model',
        meta: { label: 'Model' },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{row.original.name}</span>
            <span className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
              {row.original.slug}
              <CopyButton value={row.original.slug} label={`Copy slug ${row.original.slug}`} />
            </span>
          </span>
        ),
        size: 260,
        minSize: 180,
      },
      {
        accessorKey: 'pipelineTag',
        header: 'Task',
        enableSorting: false,
        meta: { label: 'Task' },
        cell: ({ row }) => <Badge variant="secondary">{row.original.pipelineTag}</Badge>,
        size: 210,
      },
      {
        accessorKey: 'libraryName',
        header: 'Library',
        enableSorting: false,
        meta: { label: 'Library', variant: 'multiSelect', options: LIBRARY_FILTER_OPTIONS },
        cell: ({ row }) => (
          <Badge variant="outline" className="font-mono">
            {row.original.libraryName}
          </Badge>
        ),
        size: 150,
      },
      {
        accessorKey: 'servedBy',
        header: 'Served by',
        enableSorting: false,
        meta: { label: 'Served by', variant: 'multiSelect', options: SERVED_BY_FILTER_OPTIONS },
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.servedBy}</span>,
        size: 110,
      },
      {
        accessorKey: 'deploymentKind',
        header: 'Deployment',
        enableSorting: false,
        meta: { label: 'Deployment', variant: 'multiSelect', options: DEPLOYMENT_FILTER_OPTIONS },
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <span>{DEPLOYMENT_KIND_LABELS[row.original.deploymentKind]}</span>
            {row.original.wireModelId ? <span className="text-muted-foreground font-mono text-xs">{row.original.wireModelId}</span> : null}
          </span>
        ),
        size: 170,
      },
      {
        accessorKey: 'availability',
        header: 'Availability',
        enableSorting: false,
        meta: { label: 'Availability', variant: 'multiSelect', options: AVAILABILITY_FILTER_OPTIONS },
        cell: ({ row }) => <AvailabilityBadge availability={row.original.availability} checkedAt={row.original.availabilityCheckedAt} />,
        size: 210,
      },
      {
        id: 'platformDefault',
        header: 'Platform default for',
        enableSorting: false,
        meta: { label: 'Platform default for' },
        // Single line — wrapping badges outgrow the fixed-height grid row.
        cell: ({ row }) =>
          row.original.isPlatformDefaultFor.length > 0 ? (
            <span className="flex items-center gap-1 overflow-hidden">
              {row.original.isPlatformDefaultFor.map((task) => (
                <Badge key={task} variant="default">
                  {TASK_KIND_LABELS[task] ?? task}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        size: 220,
      },
      {
        id: 'licence',
        header: 'Licence',
        enableSorting: false,
        meta: { label: 'Licence' },
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-xs">{row.original.license ?? '—'}</span>
            {row.original.gated ? <Badge variant="outline">Gated</Badge> : null}
          </span>
        ),
        size: 150,
      },
      {
        accessorKey: 'resourceStatus',
        header: 'Status',
        enableSorting: false,
        meta: { label: 'Status', variant: 'multiSelect', options: STATUS_OPTIONS },
        cell: ({ row }) => <ResourceStatusBadge status={row.original.resourceStatus} />,
        size: 130,
      },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        meta: { label: 'Updated' },
        cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.updatedAt)}</span>,
        size: 150,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        meta: { label: 'Actions' },
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        size: 124,
        minSize: 124,
        cell: ({ row }) => (
          <ModelRowActions
            model={row.original}
            onEdit={() => {
              setEditingId(row.original.id);
              setSheetSeed(undefined);
              setSheetOpen(true);
            }}
            onPlatformDefault={() => setDefaultTarget(row.original)}
            onDelete={() => setDeleteTarget(row.original)}
          />
        ),
      },
    ],
    [setDeleteTarget, setDefaultTarget, setEditingId, setSheetOpen, setSheetSeed],
  );

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="AI Model Registry"
            meta={
              data ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span>{formatNumber(totalCount)} models in the platform catalogue</span>
                  {unassignedProviderCount > 0 ? (
                    <Badge variant="outline" title="These rows name no provider this platform can serve, so no picker lists them. Set a provider on each row to make it selectable.">
                      {formatNumber(unassignedProviderCount)} with no provider
                    </Badge>
                  ) : null}
                </span>
              ) : null
            }
            actions={
              <>
                <Button variant="outline" onClick={() => setDiscoveryOpen(true)}>
                  <IconRadar aria-hidden />
                  Loaded on engines
                </Button>
                <Button variant="outline" onClick={() => setUnregisteredOpen(true)} disabled={!lastInventory.data}>
                  <IconDatabaseSearch aria-hidden />
                  In bucket, not registered
                  {lastInventory.data && lastInventory.data.unregistered.length > 0 ? (
                    <Badge variant="secondary">{lastInventory.data.unregistered.length}</Badge>
                  ) : null}
                </Button>
                <Button variant="outline" onClick={runInventory} disabled={inventoryMutation.isPending}>
                  {inventoryMutation.isPending ? <Spinner /> : <IconCpu aria-hidden />}
                  Run inventory
                </Button>
                <Button onClick={() => openCreate()}>
                  <IconPlus aria-hidden />
                  Register model
                </Button>
              </>
            }
          />
        }
        footer={
          <StatusFooter
            start={<span>{isFetching && !isLoading ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/ai-models
              </span>
            }
          />
        }
      >
        <AdminDataGrid<AiModel>
          gridId="ai-models"
          aria-label="AI models"
          columns={columns}
          rows={rows}
          total={totalCount}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          isLoading={isLoading}
          isBusy={isFetching && !isLoading}
          error={error}
          onRetry={() => void refetch()}
          emptyState={
            <EmptyState
              icon={IconCpu}
              title="No models registered yet"
              description="Agents and workflows fall back to platform defaults until a model is registered."
              action={
                <Button onClick={() => openCreate()}>
                  <IconPlus aria-hidden />
                  Register model
                </Button>
              }
            />
          }
          emptyFilteredState={
            <EmptyState
              icon={IconFilterOff}
              title="No models match your filters"
              description="Try a different search or clear the filters."
              action={
                <Button variant="outline" onClick={clearFilters} aria-label="Clear filters and show all rows">
                  <IconFilterOff aria-hidden />
                  Clear filters
                </Button>
              }
            />
          }
        />
      </ScreenTemplate>
      <DiscoveryDrawer open={discoveryOpen} onOpenChange={setDiscoveryOpen} />
      <UnregisteredPrefixesDrawer open={unregisteredOpen} onOpenChange={setUnregisteredOpen} report={lastInventory.data} onRegister={registerFromBucket} />
      <ModelFormSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) {
            setEditingId(null);
            setSheetSeed(undefined);
          }
        }}
        modelId={editingId}
        seed={sheetSeed}
      />
      <PlatformDefaultDialog
        model={defaultTarget}
        open={defaultTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDefaultTarget(null);
        }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Retire model"
        description={
          <>
            This retires <span className="text-foreground font-medium">{deleteTarget?.name}</span> (
            <span className="font-mono">{deleteTarget?.slug}</span>) from the platform catalogue. Agents bound to it fall back to platform defaults.
          </>
        }
        confirmLabel="Retire model"
        destructive
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
