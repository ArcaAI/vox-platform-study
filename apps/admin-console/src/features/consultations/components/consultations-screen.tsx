'use client';

import { useEffect, useState } from 'react';
import { IconBuilding, IconFilterOff, IconRefresh, IconStethoscope } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useSession } from '@/shared/auth';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { CONSULTATION_STATUSES, VISIT_TYPES, consultationKeys, useConsultations, visitTypeOf } from '../api';
import type { Consultation, ListConsultationsParams } from '../api';
import { AggregateChartCard } from './aggregate-chart-card';
import { ConsultationDetailPanel } from './consultation-detail-panel';
import { ConsultationStatusBadge } from './consultation-status-badge';

const DEFAULT_LIMIT = 25;
const LIST_ENDPOINT_HINT = 'GET /admin/consultations';
const AGGREGATE_ENDPOINT_HINT = 'aggregate: GET aggregate?from&to[&granularity]';

const STATUS_LABELS: Record<(typeof CONSULTATION_STATUSES)[number], string> = {
    OPEN: 'Open',
    RECORDING: 'Recording',
    DRAFT_PENDING_SENSORS: 'Draft pending sensors',
    PENDING_REVIEW: 'Pending review',
    SIGNED: 'Signed',
    CLOSED: 'Closed',
    REOPENED: 'Reopened',
};

const STATUS_OPTIONS: FilterOption[] = CONSULTATION_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] }));

const TYPE_OPTIONS: FilterOption[] = [
    { value: 'new', label: 'New' },
    { value: 'revisit', label: 'Revisit' },
];

/** Refreshes every consultations query (list + aggregate + open detail). */
function RefreshAction() {
    const queryClient = useQueryClient();
    const isFetching = useIsFetching({ queryKey: consultationKeys.root }) > 0;
    return (
        <Button variant="outline" disabled={isFetching} onClick={() => void queryClient.invalidateQueries({ queryKey: consultationKeys.root })}>
            {isFetching ? <Spinner /> : <IconRefresh aria-hidden />}
            Refresh
        </Button>
    );
}

/**
 * Debounced mono id filter (patientId / doctorId / departmentId are opaque
 * ids per frame 40). Mirrors the shared FilterSearch's derived-state reset +
 * debounce so URL-driven changes (back/forward, clear filters) re-sync.
 */
function IdFilter({
    id,
    label,
    placeholder,
    value,
    onChange,
}: {
    id: string;
    label: string;
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
}) {
    const [draft, setDraft] = useState(value);
    const [lastValue, setLastValue] = useState(value);

    if (value !== lastValue) {
        setLastValue(value);
        setDraft(value);
    }

    useEffect(() => {
        if (draft === value) return;
        const timer = setTimeout(() => onChange(draft), 300);
        return () => clearTimeout(timer);
    }, [draft, value, onChange]);

    return (
        <div className="flex items-center gap-1.5">
            <Label htmlFor={id} className="text-muted-foreground text-sm font-normal">
                {label}:
            </Label>
            <Input
                id={id}
                placeholder={placeholder}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="h-9 w-36 font-mono text-xs"
            />
        </div>
    );
}

function EndpointMeta() {
    return (
        <>
            <span aria-hidden>&middot;</span>
            <span className="font-mono text-xs">{LIST_ENDPOINT_HINT}</span>
            <span aria-hidden>&middot;</span>
            <span className="font-mono text-xs">{AGGREGATE_ENDPOINT_HINT}</span>
            <span aria-hidden>&middot;</span>
            <span>read-only</span>
        </>
    );
}

/**
 * Frame 40 NoTenant panel — the row 33 EXCEPTION: an elevated session with no
 * working tenant is NOT gated; it gets the cross-tenant aggregate (the
 * gateway aggregates across tenants for an unpinned GLOBAL_ADMIN). Row data
 * still requires a tenant scope, so no grid and no detail mount here.
 */
function CrossTenantAggregateView() {
    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Consultations"
                meta={
                    <>
                        <span>cross-tenant aggregate</span>
                        <EndpointMeta />
                    </>
                }
                actions={<RefreshAction />}
            />
            <Card className="flex-row items-center gap-3 px-4 py-3">
                <IconBuilding aria-hidden className="text-info size-5 shrink-0" />
                <p className="text-sm">
                    <span className="font-medium">Cross-tenant aggregate</span> {'\u2014'} select a working tenant to browse consultation rows.
                </p>
            </Card>
            <AggregateChartCard className="max-w-3xl" />
        </div>
    );
}

function ConsultationsScreenBody() {
    const [{ patientId, doctorId, departmentId, status, type, page, limit }, setParams] = useQueryStates({
        patientId: parseAsString.withDefault(''),
        doctorId: parseAsString.withDefault(''),
        departmentId: parseAsString.withDefault(''),
        status: parseAsStringLiteral(CONSULTATION_STATUSES),
        type: parseAsStringLiteral(VISIT_TYPES),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(DEFAULT_LIMIT),
    });
    const [selectedId, setSelectedId] = useState<string | null>(null);

    // The endpoint is 1-based (0 coerces to 1 server-side); the URL/pagination
    // state stays 0-based like every other console list.
    const listParams: ListConsultationsParams = {
        page: page + 1,
        limit,
        ...(patientId ? { patientId } : {}),
        ...(doctorId ? { doctorId } : {}),
        ...(departmentId ? { departmentId } : {}),
        ...(status ? { status } : {}),
    };
    const list = useConsultations(listParams);

    const pageRows = list.data?.data ?? [];
    // The API has no type param — new/revisit filters the LOADED PAGE only.
    const rows = type ? pageRows.filter((row) => visitTypeOf(row) === type) : pageRows;
    const total = list.data?.count ?? 0;
    const hasFilters = Boolean(patientId || doctorId || departmentId || status || type);

    /** Any filter change restarts from the first page. */
    function updateFilters(patch: Parameters<typeof setParams>[0]) {
        void setParams({ ...patch, page: null });
    }

    const columns: DataTableColumn<Consultation>[] = [
        {
            key: 'id',
            header: 'Consult',
            mono: true,
            cell: (row) => (
                <span className="block max-w-32 truncate" title={row.id}>
                    {row.id}
                </span>
            ),
        },
        { key: 'doctor', header: 'Doctor', cell: (row) => row.doctor?.username ?? <span className="font-mono text-xs">{row.doctorId}</span> },
        {
            key: 'type',
            header: 'Type',
            cell: (row) => <Badge variant="outline">{visitTypeOf(row) === 'new' ? 'New' : 'Revisit'}</Badge>,
        },
        { key: 'status', header: 'Status', cell: (row) => <ConsultationStatusBadge status={row.status} /> },
    ];

    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No consultations in range"
            description={'Filter mismatch \u2014 empty is not an error. Clear the filters to see every consultation in scope.'}
            action={
                <Button
                    variant="outline"
                    onClick={() => updateFilters({ patientId: null, doctorId: null, departmentId: null, status: null, type: null })}
                >
                    <IconFilterOff aria-hidden />
                    Clear filters
                </Button>
            }
        />
    ) : (
        <EmptyState
            icon={IconStethoscope}
            title="No consultations yet"
            description={'Consultations appear here as clinicians run them \u2014 empty is not an error.'}
        />
    );

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Consultations"
                meta={
                    <>
                        {list.data ? <span>{formatNumber(total)} consultations</span> : list.isError ? null : <Skeleton className="h-4 w-28" />}
                        <EndpointMeta />
                    </>
                }
                actions={<RefreshAction />}
            />
            <FilterBar shown={rows.length} total={total}>
                <IdFilter
                    id="consultations-patient-filter"
                    label="Patient"
                    placeholder={'patientId\u2026'}
                    value={patientId}
                    onChange={(value) => updateFilters({ patientId: value || null })}
                />
                <IdFilter
                    id="consultations-doctor-filter"
                    label="Doctor"
                    placeholder={'doctorId\u2026'}
                    value={doctorId}
                    onChange={(value) => updateFilters({ doctorId: value || null })}
                />
                <IdFilter
                    id="consultations-department-filter"
                    label="Department"
                    placeholder={'departmentId\u2026'}
                    value={departmentId}
                    onChange={(value) => updateFilters({ departmentId: value || null })}
                />
                <FilterSelect
                    id="consultations-status-filter"
                    label="Status"
                    value={status ?? ''}
                    onChange={(value) => updateFilters({ status: value ? (value as (typeof CONSULTATION_STATUSES)[number]) : null })}
                    options={STATUS_OPTIONS}
                />
                <FilterSelect
                    id="consultations-type-filter"
                    label="Type"
                    value={type ?? ''}
                    onChange={(value) => updateFilters({ type: value ? (value as (typeof VISIT_TYPES)[number]) : null })}
                    options={TYPE_OPTIONS}
                />
            </FilterBar>
            <div className="grid items-start gap-4 xl:grid-cols-5">
                <AggregateChartCard className="xl:col-span-2" />
                <div className="flex flex-col gap-4 xl:col-span-3">
                    <DataTable
                        aria-label="Consultations"
                        columns={columns}
                        rows={rows}
                        rowKey={(row) => row.id}
                        isLoading={list.isLoading}
                        error={list.error ?? undefined}
                        onRetry={() => void list.refetch()}
                        empty={empty}
                        onRowClick={(row) => setSelectedId(row.id)}
                    />
                    <TablePagination
                        page={page}
                        limit={limit}
                        total={total}
                        onPageChange={(next) => void setParams({ page: next || null })}
                        onLimitChange={(next) => void setParams({ limit: next === DEFAULT_LIMIT ? null : next, page: null })}
                    />
                </div>
            </div>
            <ConsultationDetailPanel consultationId={selectedId} onOpenChange={(open) => !open && setSelectedId(null)} />
        </div>
    );
}

/**
 * Frame 40 — Consultations (tier 30–49, matrix row 33). Read-only tenant-wide
 * consultation oversight: the new-vs-revisit aggregate chart, the filterable
 * grid and the row-click detail. Scope branching is THE documented exception:
 * an elevated session with NO working tenant renders the cross-tenant
 * aggregate view instead of the usual tenant gate; a tenant admin (or an
 * elevated session pinned to a working tenant) gets the full screen.
 */
export function ConsultationsScreen() {
    const session = useSession();

    if (!session.data) {
        return (
            <div className="flex flex-col gap-4">
                <PageHeader title="Consultations" meta={<Skeleton className="h-4 w-40" />} />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (session.data.isElevated && !session.data.workingTenantId) {
        return <CrossTenantAggregateView />;
    }

    return <ConsultationsScreenBody />;
}
