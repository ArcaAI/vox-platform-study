'use client';

/**
 * `/workflow-studio` — the workflow MANAGEMENT screen (TASK-1036 §3.3, OD-13).
 *
 * This reverses TASK-893 OD-1: with no id in the URL the route no longer redirects into the
 * studio, it lists the tenant's workflows — ONE ROW PER SLUG (the lineage register,
 * `GET admin/workflow-definitions/lineages`), because a row per version made "what is live?"
 * unanswerable and paging split lineages. A row opens the studio on the active version, else the
 * newest draft; the versions, with their lifecycle verbs, live one level down in a drawer. A
 * multi-select bulk bar runs publish / unpublish / export / delete-all-versions CLIENT-SIDE per
 * item (D-2) with a per-item result list.
 *
 * The tag facet filters the LOADED page client-side: a tag differs between the versions of one
 * lineage, so a server-side `tags` predicate would change the register's folded counters
 * (see `listWorkflowLineages`). The search is server-side over `slug`, which is fold-safe.
 */
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import {
  IconCopy,
  IconDownload,
  IconFileImport,
  IconFilterOff,
  IconHistory,
  IconListTree,
  IconPlus,
  IconRocket,
  IconArchive,
  IconTemplate,
  IconTrash,
} from '@tabler/icons-react';
import type { ColumnDef, RowSelectionState, SortRule } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import type { FilterOption } from '@/shared/data/filter-bar';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { ActiveBadge, AssignmentBadges, LifecycleStatusBadge } from '@/shared/versioning';
import {
  useCloneWorkflowDefinition,
  useImportWorkflowDefinition,
  useInvalidateWorkflowStudioNamespace,
  useWorkflowLineages,
  useWorkflowTags,
  useWorkflowTemplates,
} from '../../api';
import type { WorkflowLineage } from '../../api/types';
import { CloneDefinitionDialog, type CloneDefinitionSubmission } from '../clone-definition-dialog';
import { ImportDefinitionDialog, type ImportDefinitionSubmission } from '../import-definition-dialog';
import { BulkRunDialog, type BulkRun } from './bulk-run-dialog';
import { BULK_ACTION_LABEL, initialItems, runBulk, type BulkAction } from './lineage-bulk';
import { LineageVersionsPanel, studioHref } from './lineage-versions-panel';

/** Fold-safe: a slug is identical on every version of a lineage, so narrowing on it drops no version row. */
const SEARCH_FIELDS = ['slug'];
/** The register orders by name server-side and ignores `sort`; declared so the grid does not promise a control that does nothing. */
const DEFAULT_SORT: SortRule[] = [{ id: 'name', desc: false }];

const ENDPOINT_HINT = (
  <span aria-hidden className="font-mono text-xs">
    GET /admin/workflow-definitions/lineages
  </span>
);

/** Where a row opens: the active version, else the newest open draft; null when it has neither (all deprecated). */
export function lineageStudioTarget(lineage: WorkflowLineage): string | null {
  const id = lineage.active?.id ?? lineage.draft?.id;
  return id ?? null;
}

function SlugCell({ slug }: { slug: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate font-mono text-xs">{slug}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={`Copy slug ${slug}`}
        onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard?.writeText(slug).then(
            () => toast.success(`Copied ${slug}`),
            () => toast.error('Could not copy to the clipboard.'),
          );
        }}
      >
        <IconCopy aria-hidden className="size-3.5" />
      </Button>
    </span>
  );
}

export function WorkflowManagementScreen() {
  return (
    <WorkingTenantGate
      title="Workflow Studio"
      meta={ENDPOINT_HINT}
      description="Workflow definitions are tenant-scoped. Pick a working tenant from the top-bar switcher to load them."
    >
      <ManagementBody />
    </WorkingTenantGate>
  );
}

function ManagementBody() {
  const router = useRouter();
  const query = useAdminGridParams({ searchFields: SEARCH_FIELDS, defaultSort: DEFAULT_SORT });
  const [selectedSlug, setSelectedSlug] = useQueryState('slug', parseAsString.withDefault(''));

  const tagFilter = query.queryState.filters.find((rule) => rule.id === 'tags');
  const tagFilterValue = tagFilter?.value;
  const tagValues = useMemo(() => (Array.isArray(tagFilterValue) ? tagFilterValue.map(String) : tagFilterValue ? [String(tagFilterValue)] : []), [tagFilterValue]);

  const listParams = useMemo(() => {
    const { filters: _filters, sort: _sort, ...rest } = query.listParams;
    return rest;
  }, [query.listParams]);

  const lineagesQuery = useWorkflowLineages(listParams);
  const tagsQuery = useWorkflowTags();
  const loaded = useMemo(() => lineagesQuery.data?.data ?? [], [lineagesQuery.data]);
  const rows = useMemo(() => (tagValues.length === 0 ? loaded : loaded.filter((row) => tagValues.some((tag) => row.tags.includes(tag)))), [loaded, tagValues]);
  const total = lineagesQuery.data?.count ?? 0;
  const versionsOnPage = rows.reduce((sum, row) => sum + row.versionCount, 0);
  const selected = useMemo(() => loaded.find((row) => row.slug === selectedSlug) ?? null, [loaded, selectedSlug]);

  const tagOptions = useMemo<FilterOption[]>(() => (tagsQuery.data ?? []).map((entry) => ({ value: entry.tag, label: entry.tag })), [tagsQuery.data]);

  // ---- header actions: templates / import (the three ways to a first workflow) -------------
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const templatesQuery = useWorkflowTemplates(cloneOpen);
  const cloneMutation = useCloneWorkflowDefinition();
  const importMutation = useImportWorkflowDefinition();

  async function handleClone({ sourceId, targetSlug, name }: CloneDefinitionSubmission) {
    setCloneError(null);
    try {
      const created = await cloneMutation.mutateAsync({ sourceId, body: { targetSlug, name } });
      setCloneOpen(false);
      toast.success(`Cloned into “${created.name}”.`);
      router.push(studioHref(created.id));
    } catch (cause) {
      const message = cause instanceof GatewayError ? cause.message : 'Failed to clone the workflow.';
      setCloneError(message);
      toast.error(message);
    }
  }

  async function handleImport({ targetSlug, name, bundle }: ImportDefinitionSubmission) {
    setImportError(null);
    try {
      const created = await importMutation.mutateAsync({ targetSlug, name, bundle });
      setImportOpen(false);
      toast.success(`Imported “${created.name}” as a draft — validate it before publishing.`);
      router.push(studioHref(created.id));
    } catch (cause) {
      // Verbatim: the 409 names the references this tenant lacks, and a paraphrase would drop that.
      const message = cause instanceof GatewayError ? cause.message : 'Failed to import the workflow.';
      setImportError(message);
      toast.error(message);
    }
  }

  const openClone = () => {
    setCloneError(null);
    setCloneOpen(true);
  };
  const openImport = () => {
    setImportError(null);
    setImportOpen(true);
  };

  // ---- selection + bulk ---------------------------------------------------------------------
  const [selection, setSelection] = useState<RowSelectionState>({});
  // Selected lineages survive a page change: the grid keys selection by slug, but only the loaded
  // page's rows are in hand, so earlier picks are remembered here.
  const [picked, setPicked] = useState<Map<string, WorkflowLineage>>(new Map());
  const [run, setRun] = useState<BulkRun | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalidate = useInvalidateWorkflowStudioNamespace();

  const handleSelection = useCallback(
    (next: RowSelectionState) => {
      setSelection(next);
      setPicked((previous) => {
        const map = new Map<string, WorkflowLineage>();
        for (const [slug, on] of Object.entries(next)) {
          if (!on) continue;
          const row = loaded.find((candidate) => candidate.slug === slug) ?? previous.get(slug);
          if (row) map.set(slug, row);
        }
        return map;
      });
    },
    [loaded],
  );

  const selectedLineages = useMemo(() => [...picked.values()], [picked]);

  async function startBulk(action: BulkAction) {
    const targets = selectedLineages;
    if (targets.length === 0) return;
    setRun({ action, items: initialItems(targets), finished: false });
    const results = await runBulk(action, targets, (slug, patch) =>
      setRun((current) => (current ? { ...current, items: current.items.map((item) => (item.slug === slug ? { ...item, ...patch } : item)) } : current)),
    );
    setRun((current) => (current ? { ...current, finished: true } : current));
    const failures = results.filter((item) => item.status === 'failed');
    for (const item of failures) toast.error(`${item.slug}: ${item.message}`);
    if (failures.length === 0) toast.success(`${BULK_ACTION_LABEL[action]}: all ${results.length} succeeded.`);
    else toast.error(`${BULK_ACTION_LABEL[action]}: ${failures.length} of ${results.length} failed.`);
    // One refresh for the whole run: the per-item calls were raw client calls, not hooks.
    void invalidate();
  }

  function closeRun() {
    setRun(null);
    handleSelection({});
  }

  const deletePhrase = selectedLineages.length === 1 ? (selectedLineages[0]?.slug ?? '') : `delete ${selectedLineages.length} workflows`;

  const actionBar = (
    <div role="toolbar" aria-label="Bulk actions" className="bg-card flex flex-wrap items-center gap-2 rounded-md border p-2">
      <span className="px-1 text-sm font-medium" aria-live="polite">
        {selectedLineages.length} selected
      </span>
      <Button variant="outline" size="sm" onClick={() => void startBulk('publish')}>
        <IconRocket aria-hidden />
        Publish
      </Button>
      <Button variant="outline" size="sm" onClick={() => void startBulk('unpublish')}>
        <IconArchive aria-hidden />
        Unpublish
      </Button>
      <Button variant="outline" size="sm" onClick={() => void startBulk('export')}>
        <IconDownload aria-hidden />
        Export
      </Button>
      <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
        <IconTrash aria-hidden />
        Delete all versions
      </Button>
      <Button variant="ghost" size="sm" className="ml-auto" onClick={() => handleSelection({})}>
        Clear selection
      </Button>
    </div>
  );

  const clearFilters = useCallback(() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] }), [query]);

  const columns = useMemo<ColumnDef<WorkflowLineage>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Workflow',
        enableSorting: false,
        enableHiding: false,
        size: 240,
        minSize: 160,
        meta: { label: 'Workflow' },
        cell: ({ row }) => <span className="truncate font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: 'slug',
        header: 'Slug',
        enableSorting: false,
        size: 220,
        meta: { label: 'Slug' },
        cell: ({ row }) => <SlugCell slug={row.original.slug} />,
      },
      {
        id: 'active',
        accessorFn: (row) => row.active?.versionNumber ?? null,
        header: 'Active version',
        enableSorting: false,
        size: 130,
        meta: { label: 'Active version' },
        cell: ({ row }) =>
          row.original.active ? (
            <span className="flex flex-col">
              <span className="font-mono text-xs">v{row.original.active.versionNumber}</span>
              <span className="text-muted-foreground text-xs">{formatRelativeTime(row.original.active.publishedAt)}</span>
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          ),
      },
      {
        id: 'draft',
        accessorFn: (row) => row.draft?.versionNumber ?? null,
        header: 'Newest draft',
        enableSorting: false,
        size: 120,
        meta: { label: 'Newest draft' },
        cell: ({ row }) =>
          row.original.draft ? <span className="font-mono text-xs">v{row.original.draft.versionNumber}</span> : <span className="text-muted-foreground text-xs">—</span>,
      },
      {
        accessorKey: 'versionCount',
        header: 'Versions',
        enableSorting: false,
        enableHiding: false,
        size: 100,
        meta: { label: 'Versions' },
        cell: ({ row }) => <span className="font-mono text-xs">{formatNumber(row.original.versionCount)}</span>,
      },
      {
        id: 'status',
        accessorFn: (row) => (row.active ? 'active' : row.draft ? 'draft' : 'inactive'),
        header: 'Status',
        enableSorting: false,
        size: 240,
        meta: { label: 'Status' },
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1">
            {row.original.active ? <ActiveBadge active /> : <ActiveBadge noneActive />}
            {row.original.draft ? <LifecycleStatusBadge status={row.original.draft.status} /> : null}
            {row.original.deprecatedCount > 0 ? (
              <Badge variant="outline" className="text-muted-foreground text-[10px]">
                {formatNumber(row.original.deprecatedCount)} deprecated
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: 'assignments',
        accessorFn: (row) => (row.assignment.tenantDefault ? 'tenant' : row.assignment.departmentCount > 0 ? 'department' : 'unassigned'),
        header: 'Assignments',
        enableSorting: false,
        size: 200,
        meta: { label: 'Assignments' },
        cell: ({ row }) => <AssignmentBadges {...row.original.assignment} />,
      },
      {
        id: 'tags',
        accessorFn: (row) => row.tags.join(' '),
        header: 'Tags',
        enableSorting: false,
        size: 200,
        meta: { label: 'Tags', variant: 'multiSelect', options: tagOptions },
        cell: ({ row }) =>
          row.original.tags.length === 0 ? (
            <span className="text-muted-foreground text-xs">—</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1">
              {row.original.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="font-mono text-[10px]">
                  {tag}
                </Badge>
              ))}
            </span>
          ),
      },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        enableSorting: false,
        size: 130,
        meta: { label: 'Updated' },
        cell: ({ row }) => <span className="text-muted-foreground text-xs">{formatRelativeTime(row.original.updatedAt)}</span>,
      },
      {
        id: 'versions',
        header: () => <span className="sr-only">Versions</span>,
        enableSorting: false,
        enableHiding: false,
        size: 56,
        meta: { label: 'Versions' },
        cell: ({ row }) => (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Versions of ${row.original.slug}`}
            onClick={(event) => {
              event.stopPropagation();
              void setSelectedSlug(row.original.slug);
            }}
          >
            <IconHistory aria-hidden className="size-4" />
          </Button>
        ),
      },
    ],
    [tagOptions, setSelectedSlug],
  );

  const newButton = (
    <Button onClick={() => router.push('/workflow-studio/new')}>
      <IconPlus aria-hidden className="size-4" />
      New workflow
    </Button>
  );

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Workflow Studio"
            meta={
              <>
                {lineagesQuery.data ? (
                  <span>
                    {formatNumber(total)} workflows · {formatNumber(versionsOnPage)} versions on this page
                  </span>
                ) : (
                  <Skeleton className="h-4 w-40" />
                )}
                <span className="text-xs">one row per workflow · versions, activation and assignments inside</span>
              </>
            }
            actions={
              <>
                <Button variant="outline" onClick={openClone}>
                  <IconTemplate aria-hidden className="size-4" />
                  Templates
                </Button>
                <Button variant="outline" onClick={openImport}>
                  <IconFileImport aria-hidden className="size-4" />
                  Import
                </Button>
                {newButton}
              </>
            }
          />
        }
        footer={<StatusFooter start={lineagesQuery.data ? `${formatNumber(rows.length)} of ${formatNumber(total)} workflows` : 'Loading…'} end={ENDPOINT_HINT} />}
      >
        <AdminDataGrid<WorkflowLineage>
          gridId="workflow-lineages"
          aria-label="Workflows"
          columns={columns}
          rows={rows}
          total={tagValues.length > 0 ? rows.length : total}
          getRowId={(row) => row.slug}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          isLoading={lineagesQuery.isLoading}
          isBusy={lineagesQuery.isFetching && !lineagesQuery.isLoading}
          error={lineagesQuery.error}
          onRetry={() => void lineagesQuery.refetch()}
          onRowClick={(row) => {
            const target = lineageStudioTarget(row);
            if (target) router.push(studioHref(target));
            else void setSelectedSlug(row.slug);
          }}
          selection={{ value: selection, onChange: handleSelection }}
          actionBar={actionBar}
          emptyState={
            <EmptyState
              icon={IconListTree}
              title="No workflow definitions yet"
              description="Start from a platform template, import a bundle another tenant exported, or build one from scratch — the studio renders whatever node types the registry serves."
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button onClick={openClone}>
                    <IconTemplate aria-hidden />
                    Start from template
                  </Button>
                  <Button variant="outline" onClick={() => router.push('/workflow-studio/new')}>
                    <IconPlus aria-hidden />
                    New workflow
                  </Button>
                  <Button variant="outline" onClick={openImport}>
                    <IconFileImport aria-hidden />
                    Import
                  </Button>
                </div>
              }
            />
          }
          emptyFilteredState={
            <EmptyState
              icon={IconFilterOff}
              title="No workflows match your filters"
              description="Clear the search and filters to see every workflow."
              action={
                <Button variant="outline" onClick={clearFilters} aria-label="Clear filters and show all rows">
                  <IconFilterOff aria-hidden className="size-4" />
                  Clear filters
                </Button>
              }
            />
          }
        />
      </ScreenTemplate>

      <DetailDrawer
        open={!!selectedSlug}
        onOpenChange={(open) => !open && void setSelectedSlug('')}
        title={selected?.name ?? selectedSlug}
        meta={<span className="font-mono text-xs">{selectedSlug}</span>}
        size="lg"
        footer={
          selected && lineageStudioTarget(selected) ? (
            <Button onClick={() => router.push(studioHref(lineageStudioTarget(selected) as string))}>Open in Studio</Button>
          ) : undefined
        }
      >
        {selectedSlug ? <LineageVersionsPanel slug={selectedSlug} lineage={selected} /> : null}
      </DetailDrawer>

      <CloneDefinitionDialog
        open={cloneOpen}
        onOpenChange={(next) => {
          setCloneOpen(next);
          if (!next) setCloneError(null);
        }}
        source={null}
        templates={templatesQuery.data ?? []}
        templatesLoading={templatesQuery.isLoading}
        onConfirm={(submission) => void handleClone(submission)}
        confirming={cloneMutation.isPending}
        error={cloneError}
      />
      <ImportDefinitionDialog
        open={importOpen}
        onOpenChange={(next) => {
          setImportOpen(next);
          if (!next) setImportError(null);
        }}
        onConfirm={(submission) => void handleImport(submission)}
        confirming={importMutation.isPending}
        error={importError}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete all versions of ${selectedLineages.length} workflow${selectedLineages.length === 1 ? '' : 's'}?`}
        description="Each workflow's active version is unpublished first, then every version is soft-deleted. The workflow stops resolving and its assignments point at nothing."
        body={
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {selectedLineages.map((lineage) => (
              <li key={lineage.slug}>
                {lineage.name} <span className="text-muted-foreground font-mono text-xs">{lineage.slug}</span> — {lineage.versionCount} version{lineage.versionCount === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        }
        confirmLabel="Delete all versions"
        destructive
        typeToConfirm={deletePhrase}
        onConfirm={() => {
          setConfirmDelete(false);
          void startBulk('delete');
        }}
      />

      <BulkRunDialog run={run} onClose={closeRun} />
    </>
  );
}
