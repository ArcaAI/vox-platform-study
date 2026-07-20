'use client';

import { useMemo, useState } from 'react';
import { IconFilterOff, IconPlus, IconRobot } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useSession } from '@/shared/auth';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useDeleteTemplate, useDepartments, useTemplates, useUsageStats } from '../api/hooks';
import type { ListTemplatesParams, PromptTemplate, PromptTemplateCategory, PromptTemplateStatus } from '../api/types';
import { AgentDetailDrawer } from './agent-detail';
import { GovernanceTab } from './governance-tab';

const STATUS_OPTIONS: FilterOption[] = [
    { value: 'DRAFT', label: 'Draft' },
    { value: 'PUBLISHED', label: 'Published' },
];

const CATEGORY_LABELS: Record<PromptTemplateCategory, string> = {
    SYSTEM: 'System',
    SUMMARY: 'Summary',
    DNA_ANALYSIS: 'DNA analysis',
    CUSTOM: 'Custom',
};

const CATEGORY_OPTIONS: FilterOption[] = (Object.keys(CATEGORY_LABELS) as PromptTemplateCategory[]).map((value) => ({
    value,
    label: CATEGORY_LABELS[value],
}));

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
    if (!usage.data) return <span className="text-muted-foreground">{'—'}</span>;
    return (
        <span className="tabular-nums">
            {formatNumber(usage.data.totalUsages)} <span className="text-muted-foreground">runs</span>
        </span>
    );
}

function AgentsScreenBody() {
    // Grid query-state (omni search, Department/Type/Status faceted filters, page)
    // lives in the URL via the standard codec; `template` (the selected row that
    // opens the detail slide-over) stays its own param.
    const query = useAdminGridParams();
    const [selectedParam, setSelectedParam] = useQueryState('template', parseAsString.withDefault(''));
    // TASK-532 (M-03/OD-6): `?tab=governance` is the redirect target from the
    // retired `/prompt-studio`, so the tab must be URL-addressable.
    const [tabParam, setTabParam] = useQueryState('tab', parseAsString);
    const session = useSession();
    const isElevated = session.data?.isElevated ?? false;
    const tab = isElevated && tabParam === 'governance' ? 'governance' : 'agents';
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<PromptTemplate | null>(null);

    const search = query.queryState.globalSearch?.trim() ?? '';
    const department = scalarFilterValue(query.queryState, 'departmentId');
    const category = scalarFilterValue(query.queryState, 'category');
    const status = scalarFilterValue(query.queryState, 'status');
    const page = query.queryState.pagination.mode === 'offset' ? query.queryState.pagination.page : 0;
    const limit = query.queryState.pagination.limit;

    // NOTE: this endpoint's `page` is ONE-based (server does `page || 1`);
    // the URL/UI state stays zero-based like every other console list.
    const listParams: ListTemplatesParams = {
        search: search || undefined,
        departmentId: department || undefined,
        category: (category as PromptTemplateCategory) || undefined,
        status: status === 'DRAFT' || status === 'PUBLISHED' ? (status as PromptTemplateStatus) : undefined,
        page: page + 1,
        limit,
    };
    const templatesQuery = useTemplates(listParams);
    const departmentsQuery = useDepartments();
    const deleteTemplate = useDeleteTemplate();

    const { rows, total } = normalizeList<PromptTemplate>(templatesQuery.data);
    const count = total ?? 0;
    const hasFilters = Boolean(search || department || category || status);
    const selected = rows.find((row) => row.id === selectedParam) ?? null;

    const departmentLabels = useMemo(
        () => new Map((departmentsQuery.data ?? []).map((row) => [row.id, (row.code ?? row.name ?? row.id) as string])),
        [departmentsQuery.data],
    );
    const departmentOptions = useMemo<FilterOption[]>(
        () => (departmentsQuery.data ?? []).map((row) => ({ value: row.id, label: (row.code ?? row.name ?? row.id) as string })),
        [departmentsQuery.data],
    );

    const selectedDepartmentLabel = selected?.departmentId ? (departmentLabels.get(selected.departmentId) ?? selected.departmentId) : null;

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
                        <span className="text-muted-foreground">{'— all —'}</span>
                    ),
            },
            {
                accessorKey: 'category',
                header: 'Type',
                enableSorting: false,
                enableHiding: false,
                size: 130,
                meta: { label: 'Type', variant: 'select', options: CATEGORY_OPTIONS },
                cell: ({ row }) => <Badge variant="outline">{CATEGORY_LABELS[row.original.category] ?? row.original.category}</Badge>,
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
                <Button onClick={() => setCreating(true)}>
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
        <>
            {/*
             * TASK-532 (M-03/OD-6): `/agents` gained the Governance tab that the
             * retired `/prompt-studio` used to own. Tabs wrap the template so the
             * shared context reaches both the TabsList (a pinned region) and the
             * panels (children) — rule 11 §Screen Template.
             */}
            <Tabs
                className="flex min-h-0 flex-1 flex-col"
                value={tab}
                onValueChange={(next) => void setTabParam(next === 'agents' ? null : next)}
            >
            <ScreenTemplate
                contentMode={tab === 'governance' ? 'scroll' : 'fill'}
                tabs={
                    <TabsList variant="line">
                        <TabsTrigger value="agents">Agents</TabsTrigger>
                        {/* Elevated-only in the console; the 403 is server-side regardless. */}
                        {isElevated ? <TabsTrigger value="governance">Governance</TabsTrigger> : null}
                    </TabsList>
                }
                header={
                    <PageHeader
                        title="Agents & Prompt Templates"
                        meta={templatesQuery.data ? <span>{formatNumber(count)} templates</span> : <Skeleton className="h-4 w-24" />}
                        actions={
                            <Button onClick={() => setCreating(true)}>
                                <IconPlus aria-hidden />
                                New template
                            </Button>
                        }
                    />
                }
                footer={
                    <StatusFooter
                        start={<span>{templatesQuery.isFetching && !templatesQuery.isLoading ? 'Refreshing' : 'Up to date'}</span>}
                        end={
                            <span aria-hidden className="font-mono">
                                GET /admin/prompt-templates
                            </span>
                        }
                    />
                }
            >
                <TabsContent value="agents" className="flex min-h-0 flex-1 flex-col">
                <VirtualizedDataGrid<PromptTemplate>
                    aria-label="Prompt templates"
                    columns={columns}
                    data={rows}
                    getRowId={(row) => row.id}
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
                </TabsContent>
                {isElevated ? (
                    <TabsContent value="governance" className="flex min-h-0 flex-1 flex-col">
                        <GovernanceTab />
                    </TabsContent>
                ) : null}
            </ScreenTemplate>
            </Tabs>

            <AgentDetailDrawer
                key={creating ? 'create' : (selectedParam || 'no-template')}
                templateId={creating ? null : selectedParam || null}
                creating={creating}
                departmentLabel={selectedDepartmentLabel}
                onOpenChange={(open) => {
                    if (open) return;
                    setCreating(false);
                    void setSelectedParam(null);
                }}
                onCreated={(template) => {
                    setCreating(false);
                    void setSelectedParam(template.id);
                }}
                onRequestDelete={setDeleting}
            />

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
        </>
    );
}

/**
 * Frame 32 — Agents & Prompt Templates (tier 30–49, capabilities-matrix row
 * 25). Tenant-scoped: elevated sessions must pick a working tenant before any
 * query mounts; tenant admins are pinned and pass straight through. Redesign
 * (build spec §7): fill-height grid + console-wide detail slide-over.
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
