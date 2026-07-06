'use client';

import { useMemo, useState } from 'react';
import { IconDots, IconFilterOff, IconPencil, IconPlus, IconRobot, IconTrash } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent } from '@arcaai/ui/components/shadcn/card';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useDeleteTemplate, useDepartments, useTemplates, useUsageStats } from '../api/hooks';
import type { ListTemplatesParams, PromptTemplate, PromptTemplateStatus } from '../api/types';
import { CreateTemplateDialog, EditTemplateDialog } from './template-form-dialog';
import { TestRunPanel } from './test-run-panel';
import { VersionsPanel } from './version-diff-panel';

/** Embedded grid (design-spec D2): fixed viewport in the master-detail middle column. */
const TEMPLATES_GRID_HEIGHT = 480;

const STATUS_OPTIONS: FilterOption[] = [
    { value: 'DRAFT', label: 'Draft' },
    { value: 'PUBLISHED', label: 'Published' },
];

/** Scalar value of a single-value faceted filter from the grid query-state. */
function scalarFilterValue(state: DataQueryState, id: string): string {
    const rule = state.filters.find((filter) => filter.id === id);
    if (!rule) return '';
    return Array.isArray(rule.value) ? String(rule.value[0] ?? '') : String(rule.value ?? '');
}

/** Per-row all-time run count from GET :id/usage (cached per template id). */
function UsageCell({ templateId }: { templateId: string }) {
    const usage = useUsageStats(templateId);
    if (usage.isPending) return <Skeleton className="h-4 w-16" />;
    if (!usage.data) return <span className="text-muted-foreground">{'\u2014'}</span>;
    return (
        <span className="tabular-nums">
            {formatNumber(usage.data.totalUsages)} <span className="text-muted-foreground">runs</span>
        </span>
    );
}

function TemplateRowActions({ template, onEdit, onDelete }: { template: PromptTemplate; onEdit: () => void; onDelete: () => void }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Open actions for ${template.name}`} onClick={(event) => event.stopPropagation()}>
                    <IconDots aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            {/* The portal content still bubbles through the React tree to the row's onClick. */}
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                <DropdownMenuItem onSelect={onEdit}>
                    <IconPencil aria-hidden />
                    Edit template
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                    <IconTrash aria-hidden />
                    Delete
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function AgentsScreenBody() {
    // Grid query-state (omni search, Department/Status faceted filters, page)
    // lives in the URL via the standard codec; `template` (the selected row that
    // drives the side panels) stays its own param.
    const query = useAdminGridParams();
    const [selectedParam, setSelectedParam] = useQueryState('template', parseAsString.withDefault(''));
    const [createOpen, setCreateOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<PromptTemplate | null>(null);

    const search = query.queryState.globalSearch?.trim() ?? '';
    const department = scalarFilterValue(query.queryState, 'departmentId');
    const status = scalarFilterValue(query.queryState, 'status');
    const page = query.queryState.pagination.mode === 'offset' ? query.queryState.pagination.page : 0;
    const limit = query.queryState.pagination.limit;

    // NOTE: this endpoint's `page` is ONE-based (server does `page || 1`);
    // the URL/UI state stays zero-based like every other console list.
    const listParams: ListTemplatesParams = {
        search: search || undefined,
        departmentId: department || undefined,
        status: status === 'DRAFT' || status === 'PUBLISHED' ? (status as PromptTemplateStatus) : undefined,
        page: page + 1,
        limit,
    };
    const templatesQuery = useTemplates(listParams);
    const departmentsQuery = useDepartments();
    const deleteTemplate = useDeleteTemplate();

    const { rows, total } = normalizeList<PromptTemplate>(templatesQuery.data);
    const count = total ?? 0;
    const hasFilters = Boolean(search || department || status);
    const selected = rows.find((row) => row.id === selectedParam) ?? rows[0] ?? null;

    const departmentLabels = useMemo(
        () => new Map((departmentsQuery.data ?? []).map((row) => [row.id, row.code ?? row.name ?? row.id])),
        [departmentsQuery.data],
    );
    const departmentOptions = useMemo<FilterOption[]>(
        () => (departmentsQuery.data ?? []).map((row) => ({ value: row.id, label: (row.code ?? row.name ?? row.id) as string })),
        [departmentsQuery.data],
    );

    const clearFilters = () => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] });

    const columns = useMemo<ColumnDef<PromptTemplate>[]>(
        () => [
            {
                accessorKey: 'name',
                header: 'Template',
                enableSorting: false,
                enableHiding: false,
                size: 220,
                minSize: 140,
                meta: { label: 'Template' },
                cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
            },
            {
                accessorKey: 'departmentId',
                header: 'Dept',
                enableSorting: false,
                enableHiding: false,
                size: 120,
                meta: { label: 'Dept', variant: 'select', options: departmentOptions },
                cell: ({ row }) =>
                    row.original.departmentId ? (
                        <Badge variant="outline" className="font-mono text-[10px]">
                            {departmentLabels.get(row.original.departmentId) ?? row.original.departmentId}
                        </Badge>
                    ) : (
                        <span className="text-muted-foreground">{'\u2014 all \u2014'}</span>
                    ),
            },
            {
                accessorKey: 'status',
                header: 'Status',
                enableSorting: false,
                enableHiding: false,
                size: 120,
                meta: { label: 'Status', variant: 'select', options: STATUS_OPTIONS },
                cell: ({ row }) =>
                    row.original.status === 'DRAFT' ? <Badge variant="outline">Draft</Badge> : <Badge variant="secondary">Published</Badge>,
            },
            {
                id: 'active',
                header: 'Active',
                enableSorting: false,
                enableHiding: false,
                size: 90,
                meta: { label: 'Active' },
                cell: ({ row }) => <span className="font-mono text-xs">v{row.original.currentVersionNumber}</span>,
            },
            {
                id: 'usage',
                header: 'Usage',
                enableSorting: false,
                enableHiding: false,
                size: 120,
                meta: { label: 'Usage' },
                cell: ({ row }) => <UsageCell templateId={row.original.id} />,
            },
            {
                id: 'actions',
                header: () => <span className="sr-only">Actions</span>,
                enableSorting: false,
                enableHiding: false,
                enableResizing: false,
                size: 56,
                minSize: 56,
                meta: { label: 'Actions' },
                cell: ({ row }) => (
                    <div className="flex w-full justify-end">
                        <TemplateRowActions template={row.original} onEdit={() => setEditingId(row.original.id)} onDelete={() => setDeleting(row.original)} />
                    </div>
                ),
            },
        ],
        [departmentLabels, departmentOptions],
    );

    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No templates match your filters"
            description="Try a different search or clear the filters."
            action={
                <Button variant="outline" onClick={clearFilters}>
                    <IconFilterOff aria-hidden />
                    Clear filters
                </Button>
            }
        />
    ) : (
        <EmptyState
            icon={IconRobot}
            title="No prompt templates yet"
            description="Templates drive the tenant's summarization agents. Create the first one to start versioning prompts."
            action={
                <Button onClick={() => setCreateOpen(true)}>
                    <IconPlus aria-hidden />
                    New template
                </Button>
            }
        />
    );

    function handleDeleteConfirmed() {
        if (!deleting) return;
        deleteTemplate.mutate(deleting.id, {
            onSuccess: () => {
                toast.success('Template deleted');
                if (deleting.id === selectedParam) void setSelectedParam(null);
                setDeleting(null);
            },
            onError: (error) => {
                toast.error(error instanceof GatewayError ? error.message : 'Could not delete the template.');
                setDeleting(null);
            },
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Agents & Prompt Templates"
                meta={
                    <>
                        {templatesQuery.data ? <span>{formatNumber(count)} templates</span> : <Skeleton className="h-4 w-24" />}
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            GET /admin/prompt-templates
                        </span>
                    </>
                }
                actions={
                    <Button onClick={() => setCreateOpen(true)}>
                        <IconPlus aria-hidden />
                        New template
                    </Button>
                }
            />
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)]">
                {/* Keyed remounts reset panel-local state on selection change.
                    The prefixes keep the two keyed siblings unique — duplicate
                    keys make React orphan the old panel instead of unmounting
                    it, stacking one extra Versions card per selection (BUG-002). */}
                {selected ? (
                    <VersionsPanel key={`versions-${selected.id}`} template={selected} />
                ) : (
                    <Card className="py-4">
                        <CardContent className="text-muted-foreground px-4 text-sm">Select a template to inspect its versions.</CardContent>
                    </Card>
                )}
                <div className="flex flex-col gap-3">
                    <VirtualizedDataGrid<PromptTemplate>
                        aria-label="Prompt templates"
                        columns={columns}
                        data={rows}
                        getRowId={(row) => row.id}
                        height={TEMPLATES_GRID_HEIGHT}
                        manual={{ filtering: true, pagination: true }}
                        rowCount={count}
                        queryState={query.queryState}
                        onQueryStateChange={query.setQueryState}
                        persistence={gridPersistence('agents')}
                        features={{
                            columnReorder: true,
                            columnResize: true,
                            columnPinning: true,
                            columnVisibility: true,
                            rowSelection: false,
                            globalSearch: true,
                            facetedFilters: true,
                            sorting: false,
                        }}
                        onRowClick={(row) => void setSelectedParam(row.id)}
                        isLoading={templatesQuery.isLoading}
                        isBusy={templatesQuery.isFetching && !templatesQuery.isLoading}
                        error={rows.length > 0 ? null : (templatesQuery.error ?? null)}
                        errorState={(error) => <ErrorState error={error} onRetry={() => void templatesQuery.refetch()} />}
                        onRetry={() => void templatesQuery.refetch()}
                        emptyState={empty}
                    />
                    {count > 0 ? (
                        <p className="text-muted-foreground text-sm">
                            Templates {'\u00b7'} selected:{' '}
                            {selected ? <span className="text-foreground font-medium">{selected.name}</span> : 'none'}
                        </p>
                    ) : null}
                </div>
                {selected ? (
                    <TestRunPanel key={`test-run-${selected.id}`} template={selected} />
                ) : (
                    <Card className="py-4">
                        <CardContent className="text-muted-foreground px-4 text-sm">Select a template to run a test.</CardContent>
                    </Card>
                )}
            </div>
            <CreateTemplateDialog open={createOpen} onOpenChange={setCreateOpen} />
            {editingId ? <EditTemplateDialog templateId={editingId} onOpenChange={(open) => !open && setEditingId(null)} /> : null}
            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                title="Delete template?"
                description={
                    deleting
                        ? `Soft-deletes "${deleting.name}" and detaches it from consultations that reference it. Its version history stays in the database.`
                        : ''
                }
                confirmLabel="Delete template"
                destructive
                typeToConfirm={deleting?.name}
                onConfirm={handleDeleteConfirmed}
                isPending={deleteTemplate.isPending}
            />
        </div>
    );
}

/**
 * Frame 32 — Agents & Prompt Templates (tier 30–49, capabilities-matrix row
 * 25). Tenant-scoped: elevated sessions must pick a working tenant before any
 * query mounts; tenant admins are pinned and pass straight through.
 */
export function AgentsScreen() {
    return (
        <WorkingTenantGate
            title="Agents & Prompt Templates"
            meta={
                <span aria-hidden className="text-muted-foreground font-mono text-xs">
                    GET /admin/prompt-templates
                </span>
            }
            description="Prompt templates are administered per tenant. Pick a working tenant from the switcher in the top bar to load its agents."
        >
            <AgentsScreenBody />
        </WorkingTenantGate>
    );
}
