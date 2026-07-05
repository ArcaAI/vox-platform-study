'use client';

import { useState } from 'react';
import { IconDots, IconFilterOff, IconPencil, IconPlus, IconRobot, IconTrash } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
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
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useDeleteTemplate, useDepartments, useTemplates, useUsageStats } from '../api/hooks';
import type { ListTemplatesParams, PromptTemplate, PromptTemplateStatus } from '../api/types';
import { CreateTemplateDialog, EditTemplateDialog } from './template-form-dialog';
import { TestRunPanel } from './test-run-panel';
import { VersionsPanel } from './version-diff-panel';

/** Frame shows compact pages; also bounds the per-row usage-stat fan-out. */
const PAGE_SIZE = 10;

const STATUS_OPTIONS: FilterOption[] = [
    { value: 'DRAFT', label: 'Draft' },
    { value: 'PUBLISHED', label: 'Published' },
];

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
    const [{ search, department, status, page, template: selectedParam }, setParams] = useQueryStates({
        search: parseAsString.withDefault(''),
        department: parseAsString.withDefault(''),
        status: parseAsString.withDefault(''),
        page: parseAsInteger.withDefault(0),
        template: parseAsString.withDefault(''),
    });
    const [createOpen, setCreateOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<PromptTemplate | null>(null);

    // NOTE: this endpoint's `page` is ONE-based (server does `page || 1`);
    // the URL/UI state stays zero-based like every other console list.
    const listParams: ListTemplatesParams = {
        search: search || undefined,
        departmentId: department || undefined,
        status: status === 'DRAFT' || status === 'PUBLISHED' ? (status as PromptTemplateStatus) : undefined,
        page: page + 1,
        limit: PAGE_SIZE,
    };
    const templatesQuery = useTemplates(listParams);
    const departmentsQuery = useDepartments();
    const deleteTemplate = useDeleteTemplate();

    const rows = templatesQuery.data?.data ?? [];
    const count = templatesQuery.data?.count ?? 0;
    const hasFilters = Boolean(search || department || status);
    const selected = rows.find((row) => row.id === selectedParam) ?? rows[0] ?? null;

    const departmentLabels = new Map((departmentsQuery.data ?? []).map((row) => [row.id, row.code ?? row.name ?? row.id]));
    const departmentOptions: FilterOption[] = (departmentsQuery.data ?? []).map((row) => ({
        value: row.id,
        label: departmentLabels.get(row.id) as string,
    }));

    const columns: DataTableColumn<PromptTemplate>[] = [
        {
            key: 'name',
            header: 'Template',
            cell: (row) => (
                <span className="flex items-center gap-2">
                    <span className="font-medium">{row.name}</span>
                    {row.status === 'DRAFT' ? <Badge variant="outline">Draft</Badge> : null}
                </span>
            ),
        },
        {
            key: 'department',
            header: 'Dept',
            cell: (row) =>
                row.departmentId ? (
                    <Badge variant="outline" className="font-mono text-[10px]">
                        {departmentLabels.get(row.departmentId) ?? row.departmentId}
                    </Badge>
                ) : (
                    <span className="text-muted-foreground">{'\u2014 all \u2014'}</span>
                ),
        },
        { key: 'active', header: 'Active', mono: true, cell: (row) => `v${row.currentVersionNumber}` },
        { key: 'usage', header: 'Usage', cell: (row) => <UsageCell templateId={row.id} /> },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            className: 'w-12 text-right',
            cell: (row) => <TemplateRowActions template={row} onEdit={() => setEditingId(row.id)} onDelete={() => setDeleting(row)} />,
        },
    ];

    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No templates match your filters"
            description="Try a different search or clear the filters."
            action={
                <Button variant="outline" onClick={() => setParams({ search: null, department: null, status: null, page: null })}>
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
                if (deleting.id === selectedParam) void setParams({ template: null });
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
            <FilterBar>
                <FilterSearch
                    label="Search templates"
                    placeholder={'Search templates\u2026'}
                    value={search}
                    onChange={(value) => setParams({ search: value || null, page: null })}
                />
                <FilterSelect
                    id="agents-department-filter"
                    label="Department"
                    value={department}
                    onChange={(value) => setParams({ department: value || null, page: null })}
                    options={departmentOptions}
                />
                <FilterSelect
                    id="agents-status-filter"
                    label="Status"
                    value={status}
                    onChange={(value) => setParams({ status: value || null, page: null })}
                    options={STATUS_OPTIONS}
                />
                <span aria-hidden className="text-muted-foreground ml-auto pr-2 font-mono text-xs">
                    GET usage-records
                </span>
            </FilterBar>
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
                    <DataTable
                        aria-label="Prompt templates"
                        columns={columns}
                        rows={rows}
                        rowKey={(row) => row.id}
                        isLoading={templatesQuery.isLoading}
                        error={templatesQuery.error}
                        onRetry={() => void templatesQuery.refetch()}
                        empty={empty}
                        onRowClick={(row) => void setParams({ template: row.id })}
                        skeletonRows={5}
                    />
                    {count > 0 ? (
                        <>
                            <p className="text-muted-foreground text-sm">
                                Templates {'\u00b7'} selected:{' '}
                                {selected ? <span className="text-foreground font-medium">{selected.name}</span> : 'none'}
                            </p>
                            <TablePagination page={page} limit={PAGE_SIZE} total={count} onPageChange={(next) => setParams({ page: next || null })} />
                        </>
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
