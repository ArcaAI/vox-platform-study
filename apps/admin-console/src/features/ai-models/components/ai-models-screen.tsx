'use client';

import { useCallback, useMemo, useState } from 'react';
import { IconCpu, IconFilterOff, IconPencil, IconPlus, IconRadar, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { type ColumnDef, type SortRule } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
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
import { useDeleteModel, useModelsPaginated } from '../api/hooks';
import type { AiModel } from '../api/types';
import { DiscoveryDrawer } from './discovery-drawer';
import { ModelFormSheet } from './model-form-sheet';
import { CATEGORY_OPTIONS, RUNTIME_PROVIDER_OPTIONS, SOURCE_LABELS, SOURCE_OPTIONS, humanizeEnum } from './model-meta';

/** Omni search targets (→ gateway `searchFields`) and the implicit sort — stable refs for the hook. */
const AI_MODEL_SEARCH_FIELDS = ['name', 'slug'];
const AI_MODEL_DEFAULT_SORT: SortRule[] = [{ id: 'name', desc: false }];

const SOURCE_FILTER_OPTIONS: FilterOption[] = SOURCE_OPTIONS.map((source) => ({ value: source, label: SOURCE_LABELS[source] }));
/** runtime-provider filter chip. */
const PROVIDER_FILTER_OPTIONS: FilterOption[] = RUNTIME_PROVIDER_OPTIONS.map((provider) => ({ value: provider, label: provider }));
const CAPABILITY_OPTIONS: FilterOption[] = CATEGORY_OPTIONS.map((category) => ({ value: category, label: humanizeEnum(category) }));
const STATUS_OPTIONS: FilterOption[] = [
    { value: 'ENABLED', label: 'Enabled' },
    { value: 'DISABLED', label: 'Disabled' },
    { value: 'SUSPENDED', label: 'Suspended' },
    { value: 'ARCHIVED', label: 'Archived' },
];

/** Edit / delete row actions — a module-level component so the column memo stays stable. */
function ModelRowActions({ model, onEdit, onDelete }: { model: AiModel; onEdit: () => void; onDelete: () => void }) {
    return (
        <span className="flex w-full items-center justify-end gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${model.name}`} onClick={onEdit}>
                <IconPencil aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${model.name}`} onClick={onDelete}>
                <IconTrash aria-hidden />
            </Button>
        </span>
    );
}

/**
 * Frame 15 — AI Models hub (/ai-models, tier 10-19). Server-driven
 * AdminDataGrid (omni search over name/slug + provider/capability/status typed
 * filters + sortable name/updated + pager), register/edit drawer (OCC If-Match)
 * and destructive delete with confirm.
 *
 * turns the registry screen into the hub: the header also opens the
 * DISCOVERY drawer, which merges these rows with the live LM Studio / Ollama /
 * vLLM / llama.cpp listings. Discovery probes are LAZY (drawer open only) so
 * this grid never waits on an engine round-trip, and the registry stays
 * authoritative for task routing — discovery only ever offers a register.
 */
export function AiModelsScreen() {
    const query = useAdminGridParams({ searchFields: AI_MODEL_SEARCH_FIELDS, defaultSort: AI_MODEL_DEFAULT_SORT });
    const { data, isLoading, isFetching, error, refetch } = useModelsPaginated(query.listParams);
    const { rows, total } = normalizeList<AiModel>(data);
    const totalCount = total ?? 0;

    const [sheetOpen, setSheetOpen] = useState(false);
    const [discoveryOpen, setDiscoveryOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<AiModel | null>(null);
    const deleteMutation = useDeleteModel();

    const openCreate = () => {
        setEditingId(null);
        setSheetOpen(true);
    };

    const clearFilters = useCallback(
        () => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] }),
        [query],
    );

    function handleDelete() {
        if (!deleteTarget) return;
        deleteMutation.mutate(deleteTarget.id, {
            onSuccess: () => {
                toast.success('Model deleted');
                setDeleteTarget(null);
            },
            onError: (error) => toast.error(error.message),
        });
    }

    const columns = useMemo<ColumnDef<AiModel>[]>(
        () => [
            {
                accessorKey: 'name',
                header: 'Model',
                meta: { label: 'Model' },
                cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
                size: 240,
                minSize: 160,
            },
            {
                accessorKey: 'slug',
                header: 'Slug',
                enableSorting: false,
                meta: { label: 'Slug' },
                cell: ({ row }) => (
                    <span className="flex items-center gap-1 font-mono text-xs">
                        {row.original.slug}
                        <CopyButton value={row.original.slug} label={`Copy slug ${row.original.slug}`} />
                    </span>
                ),
                size: 200,
            },
            {
                // The real runtime provider column (the source column below covers artifact origin).
                accessorKey: 'provider',
                header: 'Provider',
                enableSorting: false,
                meta: { label: 'Provider', variant: 'multiSelect', options: PROVIDER_FILTER_OPTIONS },
                cell: ({ row }) => (
                    <span className="flex items-center gap-1.5">
                        {row.original.provider ? (
                            <Badge variant="outline" className="font-mono">
                                {row.original.provider}
                            </Badge>
                        ) : (
                            <span className="text-muted-foreground">—</span>
                        )}
                        {row.original.architecture ? (
                            <span className="text-muted-foreground font-mono text-xs">{row.original.architecture}</span>
                        ) : null}
                    </span>
                ),
                size: 170,
            },
            {
                accessorKey: 'source',
                header: 'Source',
                enableSorting: false,
                meta: { label: 'Source', variant: 'multiSelect', options: SOURCE_FILTER_OPTIONS },
                cell: ({ row }) => SOURCE_LABELS[row.original.source] ?? row.original.source,
                size: 140,
            },
            {
                accessorKey: 'category',
                header: 'Capability',
                enableSorting: false,
                meta: { label: 'Capability', variant: 'multiSelect', options: CAPABILITY_OPTIONS },
                // Single line — wrapping badges outgrow the fixed-height grid row.
                cell: ({ row }) => (
                    <span className="flex items-center gap-1">
                        <Badge variant="secondary">{humanizeEnum(row.original.taskType)}</Badge>
                        <Badge variant="outline">{humanizeEnum(row.original.category)}</Badge>
                    </span>
                ),
                size: 280,
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
                size: 88,
                minSize: 88,
                cell: ({ row }) => (
                    <ModelRowActions
                        model={row.original}
                        onEdit={() => {
                            setEditingId(row.original.id);
                            setSheetOpen(true);
                        }}
                        onDelete={() => setDeleteTarget(row.original)}
                    />
                ),
            },
        ],
        [setDeleteTarget, setEditingId, setSheetOpen],
    );

    return (
        <>
            <ScreenTemplate
                contentMode="fill"
                header={
                    <PageHeader
                        title="AI Model Registry"
                        meta={data ? <span>{formatNumber(totalCount)} models</span> : null}
                        actions={
                            <>
                                <Button variant="outline" onClick={() => setDiscoveryOpen(true)}>
                                    <IconRadar aria-hidden />
                                    Discover from servers
                                </Button>
                                <Button onClick={openCreate}>
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
                            description="SMR and STT fall back to platform defaults until a model is registered."
                            action={
                                <Button onClick={openCreate}>
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
                                <Button variant="outline" onClick={clearFilters}>
                                    <IconFilterOff aria-hidden />
                                    Clear filters
                                </Button>
                            }
                        />
                    }
                />
            </ScreenTemplate>
            <DiscoveryDrawer open={discoveryOpen} onOpenChange={setDiscoveryOpen} />
            <ModelFormSheet
                open={sheetOpen}
                onOpenChange={(open) => {
                    setSheetOpen(open);
                    if (!open) setEditingId(null);
                }}
                modelId={editingId}
            />
            <ConfirmDialog
                open={deleteTarget !== null}
                onOpenChange={(open) => {
                    if (!open) setDeleteTarget(null);
                }}
                title="Delete model"
                description={
                    <>
                        This permanently removes <span className="text-foreground font-medium">{deleteTarget?.name}</span>{' '}
                        (<span className="font-mono">{deleteTarget?.slug}</span>) from the registry. Tenants assigned to it fall back
                        to platform defaults.
                    </>
                }
                confirmLabel="Delete model"
                destructive
                isPending={deleteMutation.isPending}
                onConfirm={handleDelete}
            />
        </>
    );
}
