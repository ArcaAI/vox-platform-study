'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { IconBuilding, IconFilterOff, IconRefresh, IconStethoscope } from '@tabler/icons-react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState, type SortRule } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useSession } from '@/shared/auth';
import { useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { CONSULTATION_STATUSES, VISIT_TYPES, consultationKeys, useConsultations, visitTypeOf } from '../api';
import type { Consultation, ConsultationStatus, ConsultationVisitType, ListConsultationsParams } from '../api';
import { doctorDisplayName } from '../lib/doctor-name';
import { AggregateChartCard } from './aggregate-chart-card';
import { ConsultationDetailPanel } from './consultation-detail-panel';
import { ConsultationStatusBadge } from './consultation-status-badge';

const LIST_ENDPOINT_HINT = 'GET /admin/consultations';
const AGGREGATE_ENDPOINT_HINT = 'aggregate: GET aggregate?from&to[&granularity]';

const STATUS_LABELS: Record<(typeof CONSULTATION_STATUSES)[number], string> = {
  OPEN: 'Open',
  RECORDING: 'Recording',
  PAUSED: 'Paused',
  STOPPED: 'Stopped',
  APPROVED: 'Approved',
  CLOSED_COMPLETE: 'Closed (approved)',
  CLOSED_INCOMPLETE: 'Closed (no approval)',
};

const STATUS_OPTIONS: FilterOption[] = CONSULTATION_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] }));

const TYPE_OPTIONS: FilterOption[] = [
  { value: 'new', label: 'New' },
  { value: 'revisit', label: 'Revisit' },
];

/** Embedded grid (design-spec D2): fixed viewport beside the aggregate card. */
const CONSULTATIONS_GRID_HEIGHT = 480;

/** Server-side default: latest-updated first — matches the gateway's own default (TASK-999). */
const CONSULTATIONS_DEFAULT_SORT: SortRule[] = [{ id: 'updatedAt', desc: true }];

/** Scalar value of a single-value faceted filter from the grid query-state. */
function scalarFilterValue(state: DataQueryState, id: string): string {
  const rule = state.filters.find((filter) => filter.id === id);
  if (!rule) return '';
  return Array.isArray(rule.value) ? String(rule.value[0] ?? '') : String(rule.value ?? '');
}

/**
 * Frame 40 masks the patient identifier ("pt_44s1 (masked)") — show a short
 * prefix, never the full id; this oversight surface has no clinical need for it.
 */
function maskPatientId(patientId: string): string {
  return patientId.length <= 7 ? patientId : `${patientId.slice(0, 7)}\u2026`;
}

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

/** Footer status mirroring the consultations fetch state (a read-only surface). */
function RefreshStatus() {
  const isFetching = useIsFetching({ queryKey: consultationKeys.root }) > 0;
  return <span>{isFetching ? 'Refreshing' : 'Read-only'}</span>;
}

/** Endpoint hints for the footer `end` slot (secondary meta). */
function EndpointMeta() {
  return (
    <>
      <span aria-hidden className="font-mono">
        {LIST_ENDPOINT_HINT}
      </span>
      <span aria-hidden className="font-mono">
        {AGGREGATE_ENDPOINT_HINT}
      </span>
    </>
  );
}

/**
 * Frame 40 NoTenant panel — the row 33 EXCEPTION: an elevated session with no
 * working tenant is NOT gated; it gets the cross-tenant aggregate (the
 * gateway aggregates across tenants for an unpinned SUPER_ADMIN). Row data
 * still requires a tenant scope, so no grid and no detail mount here.
 */
function CrossTenantAggregateView() {
  return (
    <ScreenTemplate
      header={<PageHeader title="Consultations" meta={<span>cross-tenant aggregate</span>} actions={<RefreshAction />} />}
      statusBanner={
        <Card className="flex-row items-center gap-3 px-4 py-3">
          <IconBuilding aria-hidden className="text-info size-5 shrink-0" />
          <p className="text-sm">
            <span className="font-medium">Cross-tenant aggregate</span> {'\u2014'} select a working tenant to browse consultation rows.
          </p>
        </Card>
      }
      footer={<StatusFooter start={<RefreshStatus />} end={<EndpointMeta />} />}
    >
      <AggregateChartCard className="max-w-3xl" />
    </ScreenTemplate>
  );
}

function ConsultationsScreenBody() {
  // Discrete filters (patient/doctor/department ids, status) + the client-only
  // type filter live in the URL via the standard grid codec; the selected row
  // (a detail sheet, not a route) stays local state.
  const query = useAdminGridParams({ defaultSort: CONSULTATIONS_DEFAULT_SORT });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const patientId = scalarFilterValue(query.queryState, 'patientId');
  const doctorId = scalarFilterValue(query.queryState, 'doctorId');
  const departmentId = scalarFilterValue(query.queryState, 'departmentId');
  const statusValue = scalarFilterValue(query.queryState, 'status');
  const typeValue = scalarFilterValue(query.queryState, 'type');
  const status = (CONSULTATION_STATUSES as readonly string[]).includes(statusValue) ? (statusValue as ConsultationStatus) : undefined;
  const type = (VISIT_TYPES as readonly string[]).includes(typeValue) ? (typeValue as ConsultationVisitType) : undefined;

  // page/limit/sort come from the shared grid-state pipeline (useAdminGridParams
  // -> toListParams), which already applies the 0-based-state -> 1-based-request
  // conversion this endpoint expects (see grid-url-state.ts `toListParams`). The
  // remaining filters (patientId/doctorId/departmentId/status) stay hand-built:
  // this endpoint takes plain top-level params, not the generic bracket-grammar
  // `filters` string `toListParams` would otherwise produce.
  const listParams: ListConsultationsParams = {
    page: query.listParams.page,
    limit: query.listParams.limit,
    ...(query.listParams.sort ? { sort: query.listParams.sort } : {}),
    ...(patientId ? { patientId } : {}),
    ...(doctorId ? { doctorId } : {}),
    ...(departmentId ? { departmentId } : {}),
    ...(status ? { status } : {}),
  };
  const list = useConsultations(listParams);

  const { rows: pageRows, total } = normalizeList<Consultation>(list.data);
  // RC-2: `GET /admin/consultations` (see `admin-consultation.controller.ts#list`)
  // whitelists only page/limit/patientId/doctorId/departmentId/status/sort — visit
  // type is DERIVED (`visitTypeOf`) and has no server param, so the New/Revisit
  // facet can only narrow the ONE page already loaded, never the server total.
  // Surfaced in the empty state below, and `count` tracks what is ACTUALLY
  // shown once that facet is active (house pattern: `harness-workflows-screen.tsx`'s
  // `rowCount={rows.length}` for the same "client filter over the loaded page" shape).
  const rows = type ? pageRows.filter((row) => visitTypeOf(row) === type) : pageRows;
  const count = type ? rows.length : (total ?? 0);
  const hasFilters = Boolean(patientId || doctorId || departmentId || status || type);
  const typeScopedToLoadedPage = Boolean(type) && rows.length === 0 && pageRows.length > 0;

  const clearFilters = () => query.setQueryState({ ...query.queryState, filters: [] });

  const columns = useMemo<ColumnDef<Consultation>[]>(
    () => [
      {
        accessorKey: 'id',
        header: 'Consult',
        enableSorting: false,
        enableHiding: false,
        size: 150,
        minSize: 120,
        meta: { label: 'Consult' },
        cell: ({ row }) => (
          <Link
            href={`/consultations/${encodeURIComponent(row.original.id)}`}
            className="block max-w-32 truncate font-mono text-xs underline-offset-2 hover:underline focus-visible:underline"
            title={`Open activity for ${row.original.id}`}
            onClick={(event) => event.stopPropagation()}
          >
            {row.original.id}
          </Link>
        ),
      },
      {
        accessorKey: 'patientId',
        header: 'Patient',
        enableSorting: false,
        enableHiding: false,
        size: 120,
        meta: { label: 'Patient', variant: 'text' },
        cell: ({ row }) => <span className="font-mono text-xs">{maskPatientId(row.original.patientId)}</span>,
      },
      {
        accessorKey: 'doctorId',
        header: 'Doctor',
        enableSorting: false,
        enableHiding: false,
        size: 150,
        meta: { label: 'Doctor', variant: 'text' },
        cell: ({ row }) => {
          const doctor = doctorDisplayName(row.original.doctor);
          if (!doctor) return <span className="font-mono text-xs">{row.original.doctorId}</span>;
          return (
            <span title={doctor.secondary}>
              {doctor.label}
              {doctor.secondary && doctor.label !== doctor.secondary ? <span className="text-muted-foreground ml-1 text-xs">({doctor.secondary})</span> : null}
            </span>
          );
        },
      },
      {
        accessorKey: 'departmentId',
        header: 'Department',
        enableSorting: false,
        enableHiding: false,
        size: 130,
        meta: { label: 'Department', variant: 'text' },
        cell: ({ row }) =>
          row.original.department?.code ??
          row.original.department?.name ?? <span className="font-mono text-xs">{row.original.departmentId ?? '\u2014'}</span>,
      },
      {
        id: 'type',
        accessorFn: (row) => visitTypeOf(row),
        header: 'Type',
        enableSorting: false,
        enableHiding: false,
        size: 110,
        meta: { label: 'Type', variant: 'select', options: TYPE_OPTIONS },
        cell: ({ row }) => <Badge variant="outline">{visitTypeOf(row.original) === 'new' ? 'New' : 'Revisit'}</Badge>,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        // Gateway allow-list (`CONSULTATION_SORTABLE_FIELDS`) covers `status` —
        // unlike Consult/Patient/Doctor/Department/Type above, which have no
        // server-side sort support and stay `enableSorting: false`.
        enableSorting: true,
        enableHiding: false,
        size: 140,
        meta: { label: 'Status', variant: 'select', options: STATUS_OPTIONS },
        cell: ({ row }) => (
          <ConsultationStatusBadge
            status={row.original.status}
            processing={row.original.processing}
            processingReason={row.original.processingReason}
            governingRun={row.original.governingRun}
          />
        ),
      },
      {
        id: 'encounters',
        accessorFn: (row) => row.encounters?.length ?? null,
        header: 'Encounters',
        enableSorting: false,
        enableHiding: false,
        size: 100,
        meta: { label: 'Encounters' },
        cell: ({ row }) => {
          const count = row.original.encounters?.length;
          return count === undefined ? (
            <span className="text-muted-foreground">{'\u2014'}</span>
          ) : (
            <span className="tabular-nums" aria-label={`${count} ${count === 1 ? 'encounter' : 'encounters'}`}>
              {count}
            </span>
          );
        },
      },
      {
        id: 'autoCloseAt',
        accessorFn: (row) => row.autoCloseAt ?? null,
        header: 'Auto-close',
        enableSorting: false,
        enableHiding: false,
        size: 120,
        meta: { label: 'Auto-close' },
        cell: ({ row }) =>
          row.original.autoCloseAt ? (
            <span
              className="text-muted-foreground text-xs whitespace-nowrap"
              title={formatDateTime(row.original.autoCloseAt)}
              aria-label={`Auto-closes ${formatDateTime(row.original.autoCloseAt)}`}
            >
              {formatRelativeTime(row.original.autoCloseAt)}
            </span>
          ) : (
            <span className="text-muted-foreground">{'\u2014'}</span>
          ),
      },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        enableSorting: true,
        enableHiding: false,
        size: 120,
        minSize: 100,
        meta: { label: 'Updated' },
        cell: ({ row }) => (
          <span className="text-muted-foreground text-xs whitespace-nowrap" title={formatDateTime(row.original.updatedAt)}>
            {formatRelativeTime(row.original.updatedAt)}
          </span>
        ),
      },
    ],
    [],
  );

  const empty = hasFilters ? (
    <EmptyState
      icon={IconFilterOff}
      title="No consultations in range"
      description={
        typeScopedToLoadedPage
          ? 'No match on the loaded page. The New/Revisit filter has no server-side endpoint here, so it only scans the current page \u2014 page through, narrow by patient/doctor/department/status (server-filtered), or clear the filters.'
          : 'Filter mismatch \u2014 empty is not an error. Clear the filters to see every consultation in scope.'
      }
      action={
        <Button variant="outline" onClick={clearFilters} aria-label="Clear filters and show all rows">
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
    <>
      <ScreenTemplate
        header={
          <PageHeader
            title="Consultations"
            meta={list.data ? <span>{formatNumber(count)} consultations</span> : list.isError ? null : <Skeleton className="h-4 w-28" />}
            actions={<RefreshAction />}
          />
        }
        footer={<StatusFooter start={<RefreshStatus />} end={<EndpointMeta />} />}
      >
        <div className="grid items-start gap-4 xl:grid-cols-5">
          <AggregateChartCard className="xl:col-span-2" />
          <div className="flex flex-col gap-4 xl:col-span-3">
            <VirtualizedDataGrid<Consultation>
              aria-label="Consultations"
              columns={columns}
              data={rows}
              getRowId={(row) => row.id}
              height={CONSULTATIONS_GRID_HEIGHT}
              manual={{ filtering: true, pagination: true, sorting: true }}
              rowCount={count}
              queryState={query.queryState}
              onQueryStateChange={query.setQueryState}
              persistence={gridPersistence('consultations')}
              features={{
                columnReorder: true,
                columnResize: true,
                columnPinning: true,
                columnVisibility: true,
                rowSelection: false,
                globalSearch: false,
                facetedFilters: true,
                sorting: true,
              }}
              onRowClick={(row) => setSelectedId(row.id)}
              isLoading={list.isLoading}
              isBusy={list.isFetching && !list.isLoading}
              error={rows.length > 0 ? null : (list.error ?? null)}
              errorState={(error) => <ErrorState error={error} onRetry={() => void list.refetch()} />}
              onRetry={() => void list.refetch()}
              emptyState={empty}
            />
          </div>
        </div>
      </ScreenTemplate>
      <ConsultationDetailPanel consultationId={selectedId} onOpenChange={(open) => !open && setSelectedId(null)} />
    </>
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

  // The EFFECTIVE identity decides: a super admin impersonating a tenant admin is a tenant admin
  // here, so they get the grid, not the cross-tenant aggregate (TASK-1059 C-01). `?? ` keeps an
  // older session payload (without the effective fields) on the operator fields.
  const elevated = session.data.effectiveIsElevated ?? session.data.isElevated;
  const tenantId = session.data.effectiveTenantId !== undefined ? session.data.effectiveTenantId : session.data.workingTenantId;
  if (elevated && !tenantId) {
    return <CrossTenantAggregateView />;
  }

  return <ConsultationsScreenBody />;
}
