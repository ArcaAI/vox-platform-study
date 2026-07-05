'use client';

import { useState } from 'react';
import { IconFilterOff, IconPlus, IconRoute, IconStarFilled } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useSession } from '@/shared/auth';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { usePipeline, usePipelines } from '../api';
import type { Pipeline } from '../api';
import { ConfigEditorCard } from './config-editor-card';
import { CreatePipelineDialog } from './create-pipeline-dialog';
import { PipelineStatusBadge } from './pipeline-status-badge';
import { VersionsLifecyclePanel } from './versions-lifecycle-panel';

const STATUS_OPTIONS: FilterOption[] = [
    { value: 'ENABLED', label: 'On' },
    { value: 'DISABLED', label: 'Off' },
];

/**
 * Display-level engine extraction: the API has no engine field/param — the
 * model id lives inside the YAML (`asr:`/`engine:`/`model:` keys), so the
 * frame's Engine filter works client-side over the loaded list.
 */
function pipelineEngine(configYaml: string): string | null {
    const match = /^\s*(?:asr|engine|model)\s*:\s*["']?([A-Za-z0-9._/-]+)["']?\s*$/m.exec(configYaml);
    return match ? match[1] : null;
}

const ENDPOINT_HINT = (
    <span aria-hidden className="font-mono text-xs">
        GET /admin/audio/pipelines
    </span>
);

/** Frame 34 — Audio Pipelines (tier 30–49): config editor, grid, versions & lifecycle. */
export function AudioPipelinesScreen() {
    return (
        <WorkingTenantGate title="Audio Pipelines" meta={ENDPOINT_HINT}>
            <AudioPipelinesBody />
        </WorkingTenantGate>
    );
}

function AudioPipelinesBody() {
    const session = useSession();
    const pipelinesQuery = usePipelines();
    const [{ search, status, engine, page, limit }, setParams] = useQueryStates({
        search: parseAsString.withDefault(''),
        status: parseAsString.withDefault(''),
        engine: parseAsString.withDefault(''),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(25),
    });
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [createOpen, setCreateOpen] = useState(false);

    const detailQuery = usePipeline(selectedId);

    const pipelines = pipelinesQuery.data ?? [];
    const engineOptions: FilterOption[] = [...new Set(pipelines.map((pipeline) => pipelineEngine(pipeline.configYaml)).filter((value): value is string => !!value))]
        .sort()
        .map((value) => ({ value, label: value }));

    const filtered = pipelines.filter((pipeline) => {
        if (status && pipeline.resourceStatus !== status) return false;
        if (engine && pipelineEngine(pipeline.configYaml) !== engine) return false;
        if (!search) return true;
        const needle = search.toLowerCase();
        return pipeline.name.toLowerCase().includes(needle) || pipeline.slug.toLowerCase().includes(needle);
    });
    const pageRows = filtered.slice(page * limit, (page + 1) * limit);
    const hasFilters = Boolean(search || status || engine);

    const columns: DataTableColumn<Pipeline>[] = [
        {
            key: 'name',
            header: 'Pipeline',
            cell: (row) => <span className={row.id === selectedId ? 'text-primary font-semibold' : 'font-medium'}>{row.name}</span>,
        },
        { key: 'slug', header: 'Slug', mono: true, cell: (row) => row.slug },
        {
            key: 'default',
            header: 'Default',
            cell: (row) =>
                row.isDefault ? (
                    <span className="inline-flex items-center">
                        <IconStarFilled aria-hidden className="text-warning size-4" />
                        <span className="sr-only">Tenant default</span>
                    </span>
                ) : (
                    <span aria-hidden className="text-muted-foreground">
                        {'\u2014'}
                    </span>
                ),
        },
        { key: 'status', header: 'Status', cell: (row) => <PipelineStatusBadge status={row.resourceStatus} /> },
    ];

    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No pipelines match your filters"
            description="Try a different search or clear the filters."
            action={
                <Button variant="outline" onClick={() => void setParams({ search: null, status: null, engine: null, page: null })}>
                    <IconFilterOff aria-hidden />
                    Clear filters
                </Button>
            }
        />
    ) : (
        <EmptyState
            icon={IconRoute}
            title="No pipelines for this tenant"
            description="An ASR pipeline defines the models and preprocessing the SDK uses. Create the first one to feed the SDK pickers."
            action={
                <Button onClick={() => setCreateOpen(true)}>
                    <IconPlus aria-hidden />
                    New pipeline
                </Button>
            }
        />
    );

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Audio Pipelines"
                meta={
                    <>
                        {pipelinesQuery.data ? <span>{formatNumber(pipelines.length)} pipelines</span> : <Skeleton className="h-4 w-20" />}
                        {ENDPOINT_HINT}
                        <span className="text-xs">public read GET /audio/pipelines feeds SDK pickers</span>
                    </>
                }
                actions={
                    <Button onClick={() => setCreateOpen(true)}>
                        <IconPlus aria-hidden />
                        New pipeline
                    </Button>
                }
            />
            <FilterBar shown={filtered.length} total={pipelines.length}>
                <FilterSearch
                    label="Search pipelines"
                    placeholder={'Search pipelines\u2026'}
                    value={search}
                    onChange={(value) => void setParams({ search: value || null, page: null })}
                />
                <FilterSelect
                    id="pipelines-status-filter"
                    label="Status"
                    value={status}
                    onChange={(value) => void setParams({ status: value || null, page: null })}
                    options={STATUS_OPTIONS}
                />
                <FilterSelect
                    id="pipelines-engine-filter"
                    label="Engine"
                    value={engine}
                    onChange={(value) => void setParams({ engine: value || null, page: null })}
                    options={engineOptions}
                />
                <span aria-hidden className="text-muted-foreground hidden font-mono text-xs lg:inline">
                    GET slug/:slug lookup
                </span>
            </FilterBar>
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)]">
                <ConfigEditorCard
                    key={selectedId ?? 'none'}
                    detail={detailQuery.data}
                    isLoading={!!selectedId && detailQuery.isPending}
                    onReload={() => void detailQuery.refetch()}
                />
                <div className="flex flex-col gap-3">
                    <DataTable
                        aria-label="Audio pipelines"
                        columns={columns}
                        rows={pageRows}
                        rowKey={(row) => row.id}
                        isLoading={pipelinesQuery.isLoading}
                        error={pipelinesQuery.error ?? undefined}
                        onRetry={() => void pipelinesQuery.refetch()}
                        empty={empty}
                        onRowClick={(row) => setSelectedId(row.id)}
                    />
                    <TablePagination
                        page={page}
                        limit={limit}
                        total={filtered.length}
                        onPageChange={(next) => void setParams({ page: next || null })}
                        onLimitChange={(next) => void setParams({ limit: next, page: null })}
                    />
                </div>
                <VersionsLifecyclePanel
                    detail={detailQuery.data}
                    isLoading={!!selectedId && detailQuery.isPending}
                    isElevated={session.data?.isElevated ?? false}
                    onReload={() => void detailQuery.refetch()}
                    onDeleted={() => setSelectedId(null)}
                />
            </div>
            <CreatePipelineDialog open={createOpen} onOpenChange={setCreateOpen} />
        </div>
    );
}
