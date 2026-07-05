'use client';

import { useCallback, useState } from 'react';
import { IconCpu, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { parseAsInteger, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useDeleteModel, useModelsPaginated } from '../api/hooks';
import type { AiModel } from '../api/types';
import { ModelFormSheet } from './model-form-sheet';
import { CATEGORY_OPTIONS, SOURCE_LABELS, SOURCE_OPTIONS, humanizeEnum } from './model-meta';

const STATUS_OPTIONS = [
    { value: 'ENABLED', label: 'Enabled' },
    { value: 'DISABLED', label: 'Disabled' },
    { value: 'SUSPENDED', label: 'Suspended' },
    { value: 'ARCHIVED', label: 'Archived' },
];

/**
 * Frame 15 — AI Model Registry (/ai-models, tier 10-19). Paginated registry
 * list with search/provider/capability/status filters (URL-synced), register/
 * edit drawer (OCC If-Match) and destructive delete with confirm.
 */
export function AiModelsScreen() {
    const [search, setSearch] = useQueryState('q', { defaultValue: '' });
    const [provider, setProvider] = useQueryState('provider', { defaultValue: '' });
    const [capability, setCapability] = useQueryState('capability', { defaultValue: '' });
    const [status, setStatus] = useQueryState('status', { defaultValue: '' });
    const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(0));
    const [limit, setLimit] = useQueryState('limit', parseAsInteger.withDefault(25));
    const [sort, setSort] = useQueryState('sort', { defaultValue: 'name:asc' });

    const filters = [
        provider ? `source:${provider}` : null,
        capability ? `category:${capability}` : null,
        status ? `resourceStatus:${status}` : null,
    ]
        .filter(Boolean)
        .join(',');

    const query = useModelsPaginated({
        page,
        limit,
        sort,
        search: search || undefined,
        searchFields: search ? 'name,slug' : undefined,
        filters: filters || undefined,
    });
    const rows = query.data?.data ?? [];
    const total = query.data?.total ?? 0;

    const [sheetOpen, setSheetOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<AiModel | null>(null);
    const deleteMutation = useDeleteModel();

    const handleSearch = useCallback(
        (value: string) => {
            void setSearch(value);
            void setPage(0);
        },
        [setSearch, setPage],
    );

    function filterSetter(setter: (value: string) => void) {
        return (value: string) => {
            setter(value);
            void setPage(0);
        };
    }

    function openCreate() {
        setEditingId(null);
        setSheetOpen(true);
    }

    function openEdit(id: string) {
        setEditingId(id);
        setSheetOpen(true);
    }

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

    const columns: DataTableColumn<AiModel>[] = [
        {
            key: 'name',
            header: 'Model',
            sortKey: 'name',
            cell: (model) => <span className="font-medium">{model.name}</span>,
        },
        {
            key: 'slug',
            header: 'Slug',
            mono: true,
            cell: (model) => (
                <span className="flex items-center gap-1">
                    {model.slug}
                    <CopyButton value={model.slug} label={`Copy slug ${model.slug}`} />
                </span>
            ),
        },
        {
            key: 'provider',
            header: 'Provider',
            cell: (model) => SOURCE_LABELS[model.source] ?? model.source,
        },
        {
            key: 'capability',
            header: 'Capability',
            cell: (model) => (
                <span className="flex flex-wrap items-center gap-1">
                    <Badge variant="secondary">{humanizeEnum(model.taskType)}</Badge>
                    <Badge variant="outline">{humanizeEnum(model.category)}</Badge>
                </span>
            ),
        },
        {
            key: 'status',
            header: 'Status',
            cell: (model) => <ResourceStatusBadge status={model.resourceStatus} />,
        },
        {
            key: 'updated',
            header: 'Updated',
            sortKey: 'updatedAt',
            cell: (model) => <span className="text-muted-foreground">{formatRelativeTime(model.updatedAt)}</span>,
        },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            headerClassName: 'w-20',
            cell: (model) => (
                <span className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${model.name}`} onClick={() => openEdit(model.id)}>
                        <IconPencil aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${model.name}`} onClick={() => setDeleteTarget(model)}>
                        <IconTrash aria-hidden />
                    </Button>
                </span>
            ),
        },
    ];

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="AI Model Registry"
                meta={
                    <>
                        {query.data ? <span>{formatNumber(total)} models</span> : null}
                        {query.data ? <span aria-hidden>&middot;</span> : null}
                        <span className="font-mono text-xs">GET /admin/ai-models</span>
                    </>
                }
                actions={
                    <Button onClick={openCreate}>
                        <IconPlus aria-hidden />
                        Register model
                    </Button>
                }
            />
            <FilterBar shown={query.data ? rows.length : undefined} total={query.data ? total : undefined}>
                <FilterSearch label="Search models" placeholder="Search models…" value={search} onChange={handleSearch} />
                <FilterSelect
                    id="ai-models-provider"
                    label="Provider"
                    value={provider}
                    onChange={filterSetter((value) => void setProvider(value))}
                    options={SOURCE_OPTIONS.map((option) => ({ value: option, label: SOURCE_LABELS[option] }))}
                />
                <FilterSelect
                    id="ai-models-capability"
                    label="Capability"
                    value={capability}
                    onChange={filterSetter((value) => void setCapability(value))}
                    options={CATEGORY_OPTIONS.map((option) => ({ value: option, label: humanizeEnum(option) }))}
                />
                <FilterSelect
                    id="ai-models-status"
                    label="Status"
                    value={status}
                    onChange={filterSetter((value) => void setStatus(value))}
                    options={STATUS_OPTIONS}
                />
            </FilterBar>
            <DataTable
                aria-label="AI models"
                columns={columns}
                rows={rows}
                rowKey={(model) => model.id}
                isLoading={query.isPending}
                error={query.error}
                onRetry={() => void query.refetch()}
                empty={
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
                sort={sort}
                onSortChange={(next) => {
                    void setSort(next);
                    void setPage(0);
                }}
            />
            {query.data ? (
                <TablePagination
                    page={page}
                    limit={limit}
                    total={total}
                    onPageChange={(next) => void setPage(next)}
                    onLimitChange={(next) => {
                        void setLimit(next);
                        void setPage(0);
                    }}
                />
            ) : null}
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
        </div>
    );
}
