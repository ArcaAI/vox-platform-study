'use client';

/**
 * Templates tab — the `PromptTemplate` grid + the console-wide detail
 * slide-over (create / edit / versions / diff / test run).
 *
 * Moved verbatim out of `agents-screen.tsx` when prompt instruction templates
 * got their own route (`/prompt-templates`). `/agents` keeps the
 * `DepartmentAgent` catalog and links here — one authoritative editor per
 * backend resource (rule 13). Behaviour, URL params (`?template=`, `?atab=`)
 * and grid persistence key are unchanged, so existing deep links keep working.
 *
 * Two columns are new: `scope` (the TENANT_DEFAULT / DEPARTMENT_DEFAULT /
 * USER_PERSONAL discriminator, which decides whether a row is even a candidate
 * for tenant-wide resolution) and `Serving` (the pinned approval version — see
 * `approval-pin.tsx`).
 */

import { useEffect, useMemo, useState } from 'react';
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
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatNumber } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useDeleteTemplate, useDepartments, useTemplates, useUsageStats } from '../api/hooks';
import type { ListTemplatesParams, PromptTemplate, PromptTemplateCategory, PromptTemplateScope, PromptTemplateStatus } from '../api/types';
import { AgentDetailDrawer } from './agent-detail';
import { ApprovalPin, TemplateStatusBadge } from './approval-pin';

/**
 * `APPROVED` is now a filterable status. It was missing even though it is the
 * gate clinical resolution actually checks — an admin could not ask "what is
 * live?" from the grid at all.
 */
const STATUS_OPTIONS: FilterOption[] = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PUBLISHED', label: 'Published' },
  { value: 'APPROVED', label: 'Approved' },
];

const STATUS_VALUES: PromptTemplateStatus[] = ['DRAFT', 'PUBLISHED', 'APPROVED'];

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

const SCOPE_LABELS: Record<PromptTemplateScope, string> = {
  TENANT_DEFAULT: 'Tenant default',
  DEPARTMENT_DEFAULT: 'Department default',
  USER_PERSONAL: 'Personal',
};

const SCOPE_OPTIONS: FilterOption[] = (Object.keys(SCOPE_LABELS) as PromptTemplateScope[]).map((value) => ({ value, label: SCOPE_LABELS[value] }));

const SCOPE_VALUES: PromptTemplateScope[] = ['TENANT_DEFAULT', 'DEPARTMENT_DEFAULT', 'USER_PERSONAL'];

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

export interface TemplatesTabProps {
  /** Create-mode flag lifted to the screen so the page header can own the CTA. */
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
  /** Reports the current row count so the page header can render it. */
  onCountChange?: (state: { count: number; loaded: boolean; refreshing: boolean }) => void;
}

export function TemplatesTab({ creating, onCreatingChange, onCountChange }: TemplatesTabProps) {
  const query = useAdminGridParams();
  const [selectedParam, setSelectedParam] = useQueryState('template', parseAsString.withDefault(''));
  const [deleting, setDeleting] = useState<PromptTemplate | null>(null);

  const search = query.queryState.globalSearch?.trim() ?? '';
  const department = scalarFilterValue(query.queryState, 'departmentId');
  const category = scalarFilterValue(query.queryState, 'category');
  const status = scalarFilterValue(query.queryState, 'status');
  const scope = scalarFilterValue(query.queryState, 'scope');
  const page = query.queryState.pagination.mode === 'offset' ? query.queryState.pagination.page : 0;
  const limit = query.queryState.pagination.limit;

  // NOTE: this endpoint's `page` is ONE-based (server does `page || 1`);
  // the URL/UI state stays zero-based like every other console list.
  const listParams: ListTemplatesParams = {
    search: search || undefined,
    departmentId: department || undefined,
    category: (category as PromptTemplateCategory) || undefined,
    status: STATUS_VALUES.includes(status as PromptTemplateStatus) ? (status as PromptTemplateStatus) : undefined,
    scope: SCOPE_VALUES.includes(scope as PromptTemplateScope) ? (scope as PromptTemplateScope) : undefined,
    page: page + 1,
    limit,
  };
  const templatesQuery = useTemplates(listParams);
  const departmentsQuery = useDepartments();
  const deleteTemplate = useDeleteTemplate();

  const { rows, total } = normalizeList<PromptTemplate>(templatesQuery.data);
  const count = total ?? 0;
  const hasFilters = Boolean(search || department || category || status || scope);
  const selected = rows.find((row) => row.id === selectedParam) ?? null;

  const loaded = !!templatesQuery.data;
  const refreshing = templatesQuery.isFetching && !templatesQuery.isLoading;
  // Reporting up (not fetching) — the page header and footer are pinned
  // regions owned by the screen, so the grid tells them what it loaded.
  useEffect(() => {
    onCountChange?.({ count, loaded, refreshing });
  }, [onCountChange, count, loaded, refreshing]);

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
        accessorKey: 'scope',
        header: 'Scope',
        enableSorting: false,
        enableHiding: false,
        size: 150,
        meta: { label: 'Scope', variant: 'select', options: SCOPE_OPTIONS },
        cell: ({ row }) =>
          row.original.scope ? (
            <Badge variant="outline">{SCOPE_LABELS[row.original.scope] ?? row.original.scope}</Badge>
          ) : (
            <span className="text-muted-foreground">{'—'}</span>
          ),
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
            <Badge variant="outline" className="font-mono text-2xs">
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
        cell: ({ row }) => <TemplateStatusBadge status={row.original.status} />,
      },
      {
        id: 'serving',
        header: 'Serving',
        enableSorting: false,
        enableHiding: false,
        size: 160,
        meta: { label: 'Serving' },
        cell: ({ row }) => <ApprovalPin template={row.original} />,
      },
      {
        id: 'active',
        header: 'Draft',
        enableSorting: false,
        enableHiding: false,
        size: 90,
        meta: { label: 'Draft' },
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
      description="Prompt instruction templates are the blueprints agents and summaries are generated from. Create the first one to start versioning prompts."
      action={
        <Button onClick={() => onCreatingChange(true)}>
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
        isBusy={refreshing}
        error={rows.length > 0 ? null : (templatesQuery.error ?? null)}
        errorState={(error) => <ErrorState error={error} onRetry={() => void templatesQuery.refetch()} />}
        onRetry={() => void templatesQuery.refetch()}
        emptyState={empty}
      />

      <AgentDetailDrawer
        key={creating ? 'create' : selectedParam || 'no-template'}
        templateId={creating ? null : selectedParam || null}
        creating={creating}
        departmentLabel={selectedDepartmentLabel}
        onOpenChange={(open) => {
          if (open) return;
          onCreatingChange(false);
          void setSelectedParam(null);
        }}
        onCreated={(template) => {
          onCreatingChange(false);
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
