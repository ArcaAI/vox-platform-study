'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconFilterOff, IconPlus, IconRobot, IconUpload } from '@tabler/icons-react';
import { toast } from 'sonner';
import { parseAsString, useQueryState } from 'nuqs';
import type { ColumnDef, SortRule } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import type { FilterOption } from '@/shared/data/filter-bar';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { ActiveBadge, AssignmentBadges, LifecycleStatusBadge, OriginBadge } from '@/shared/versioning';
import { AGENT_TASKS, AGENT_TASK_LABEL, useAgent, useAgentLineages, useImportAgent, type AgentLineage, type AgentTask } from '../api';
import { AgentLineageDrawer, problemToast } from './agent-detail';
import { AgentHiddenBadge, AgentTaskBadge } from './agent-status-badge';
import { CreateAgentWizard } from './create-agent-wizard';

const TASK_OPTIONS: FilterOption[] = AGENT_TASKS.map((task) => ({ value: task, label: AGENT_TASK_LABEL[task] }));

/**
 * Omni search targets. `slug` is the only FOLD-SAFE text field: it is identical on every version
 * of a lineage, so narrowing on it never drops a version row from the server-side fold. `name`
 * can differ between versions of the same slug, which would quietly change the folded counters
 * as well as the membership — see the note on `AgentLineageListParams`.
 */
const AGENT_LINEAGE_SEARCH_FIELDS = ['slug'];

/**
 * The lineage register orders by name and ignores `sort` (`AgentRepository.findLineagesForTenant`
 * folds AFTER the query, so a row-level ORDER BY could not order lineages anyway). Declared here
 * so the grid's implicit sort matches what the server actually does rather than promising a
 * control that silently does nothing.
 */
const AGENT_LINEAGE_DEFAULT_SORT: SortRule[] = [{ id: 'name', desc: false }];

const ENDPOINT_HINT = (
  <span aria-hidden className="font-mono text-xs">
    GET /admin/agents/lineages
  </span>
);

/** The active-version cell: which version this slug serves, or the warning that nothing does. */
function ActiveCell({ lineage }: { lineage: AgentLineage }) {
  if (!lineage.active) return <ActiveBadge noneActive />;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="font-mono text-xs">v{lineage.active.versionNumber}</span>
      <ActiveBadge active />
    </span>
  );
}

/** The open-draft cell: what "Continue draft vM" would continue, or nothing in flight. */
function DraftCell({ lineage }: { lineage: AgentLineage }) {
  if (!lineage.draft) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="font-mono text-xs">v{lineage.draft.versionNumber}</span>
      <LifecycleStatusBadge status={lineage.draft.status} />
    </span>
  );
}

/**
 * Agents (tier 30–49, `manage:Agent`) — TASK-965 WS-4: ONE ROW PER LINEAGE.
 *
 * The screen used to render `GET admin/agents`, which answers one row per VERSION: an agent with
 * three versions was three near-identical rows ("Realtime transcription v2 Published Active" over
 * "v1 Deprecated"), every count counted versions where an admin reads agents, and client-side
 * paging could split one lineage across two pages (AG-13/AG-14). The grid now reads the lineage
 * register, where a row IS the agent: its active version, its open draft, its version count and
 * what the slug serves. The versions themselves live one level down, in the drawer.
 */
export function AgentsScreen() {
  return (
    <WorkingTenantGate title="Agents" meta={ENDPOINT_HINT}>
      <AgentsBody />
    </WorkingTenantGate>
  );
}

function AgentsBody() {
  const query = useAdminGridParams({ searchFields: AGENT_LINEAGE_SEARCH_FIELDS, defaultSort: AGENT_LINEAGE_DEFAULT_SORT });

  // TASK-965 (AG-21) — the deep link names the LINEAGE, not a version row: `?agent=<uuid>` pinned
  // a version, so a shared link opened a superseded row the moment the next version was
  // published. `/agents?slug=…` is what the Studio's agent inspector already links to.
  const [selectedSlug, setSelectedSlug] = useQueryState('slug', parseAsString.withDefault(''));

  // One release of grace for the old id link: resolve it to its slug, then drop it from the URL.
  const [legacyAgentParam, setLegacyAgentParam] = useQueryState('agent', parseAsString.withDefault(''));
  const legacyAgent = useAgent(legacyAgentParam || null);
  const legacySlug = legacyAgent.data?.data.slug ?? null;
  useEffect(() => {
    if (!legacyAgentParam) return;
    if (!legacySlug) return;
    void setSelectedSlug(legacySlug);
    void setLegacyAgentParam(null);
  }, [legacyAgentParam, legacySlug, setSelectedSlug, setLegacyAgentParam]);

  // TASK-890 §3.10 — `?create=1` opens the wizard directly (the Studio's "Create a new agent"
  // deep link, `agent-picker-field.tsx`'s CREATE_AGENT_HREF). Read once as the lazy initial
  // state (the deep link is a fresh navigation, so this always runs at mount); the effect below
  // only clears the URL param — never local state — so a refresh or Back doesn't re-open it.
  const [createParam, setCreateParam] = useQueryState('create', parseAsString.withDefault(''));
  const [creating, setCreating] = useState(() => createParam === '1');
  useEffect(() => {
    if (createParam === '1') void setCreateParam(null);
  }, [createParam, setCreateParam]);

  // TASK-979 — `?task=<value>` deep-links the Task filter: the voice-profile enrollment card and
  // the three retired `/audio/pipelines`, `/ai-model-defaults`, `/ai-configuration` redirects all
  // link here with `?task=SPEECH_TO_TEXT`, but the grid's OWN filter state lives entirely in the
  // `f`-encoded param (`useAdminGridParams`/`grid-url-state.ts`). Consumed exactly ONCE, at the
  // initial navigation: a valid task is translated into an `f` filter rule and `task` is dropped
  // in the same effect, so `f` stays the SINGLE source of truth for "what is the active filter" —
  // reading `task` reactively would make it un-clearable.
  const [taskParam, setTaskParam] = useQueryState('task', parseAsString.withDefault(''));
  useEffect(() => {
    if (taskParam && (AGENT_TASKS as readonly string[]).includes(taskParam)) {
      query.setQueryState({
        ...query.queryState,
        filters: [...query.queryState.filters.filter((rule) => rule.id !== 'task'), { id: 'task', operator: 'inArray', variant: 'multiSelect', value: [taskParam] }],
      });
    }
    if (taskParam) void setTaskParam(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: a `?task=` deep link is read from the initial URL exactly once.
  }, []);

  /**
   * `task` is the register's FIRST-CLASS query field (like `paletteKey` on the workflow list), so
   * the facet is lifted out of the generic `filters` grammar and sent as `?task=`. Only one value
   * travels: the route takes a single enum, so a multi-select with two picks would silently send
   * one. The facet control is left as multiSelect for house consistency and the first pick wins —
   * stated here rather than discovered.
   */
  const taskFilter = query.queryState.filters.find((rule) => rule.id === 'task');
  const taskValue = Array.isArray(taskFilter?.value) ? taskFilter?.value.map(String)[0] : taskFilter?.value ? String(taskFilter.value) : undefined;
  const task = (AGENT_TASKS as readonly string[]).includes(taskValue ?? '') ? (taskValue as AgentTask) : undefined;

  const listParams = useMemo(() => {
    const { filters: _filters, sort: _sort, ...rest } = query.listParams;
    return { ...rest, ...(task ? { task } : {}) };
  }, [query.listParams, task]);

  const lineagesQuery = useAgentLineages(listParams);
  const rows = useMemo(() => lineagesQuery.data?.data ?? [], [lineagesQuery.data]);
  const total = lineagesQuery.data?.count ?? 0;
  const versionsOnPage = rows.reduce((sum, lineage) => sum + lineage.versionCount, 0);

  const selected = useMemo(() => rows.find((lineage) => lineage.slug === selectedSlug) ?? null, [rows, selectedSlug]);

  const importAgent = useImportAgent();
  const importInputRef = useRef<HTMLInputElement>(null);

  const clearFilters = useCallback(() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] }), [query]);

  /**
   * Import a bundle file. The gateway is the authority on whether a bundle is valid and on
   * whether its references resolve HERE, so the browser only parses the JSON — a client-side
   * pre-check would be a second, weaker copy of a rule that must hold at the server anyway.
   */
  const handleImport = useCallback(
    async (file: File) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        toast.error(`${file.name} is not valid JSON.`);
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        toast.error(`${file.name} does not contain an agent bundle.`);
        return;
      }
      try {
        const imported = await importAgent.mutateAsync({ bundle: parsed as Record<string, unknown> });
        toast.success(`Imported ${imported.name} as a draft (v${imported.versionNumber}).`);
        void setSelectedSlug(imported.slug);
      } catch (error) {
        problemToast(error, 'Could not import that bundle.');
      }
    },
    [importAgent, setSelectedSlug],
  );

  const columns = useMemo<ColumnDef<AgentLineage>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Agent',
        enableSorting: false,
        enableHiding: false,
        size: 260,
        minSize: 160,
        meta: { label: 'Agent' },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span className="flex flex-wrap items-center gap-1">
              <span className={row.original.slug === selectedSlug ? 'truncate font-medium' : 'truncate font-normal'}>{row.original.name}</span>
              <AgentHiddenBadge hidden={row.original.hidden} />
            </span>
            <span className="text-muted-foreground truncate font-mono text-xs">{row.original.slug}</span>
          </span>
        ),
      },
      {
        accessorKey: 'task',
        header: 'Task',
        enableSorting: false,
        enableHiding: false,
        size: 160,
        meta: { label: 'Task', variant: 'multiSelect', options: TASK_OPTIONS },
        cell: ({ row }) => <AgentTaskBadge task={row.original.task} />,
      },
      {
        id: 'active',
        accessorFn: (row) => row.active?.versionNumber ?? null,
        header: 'Active version',
        enableSorting: false,
        enableHiding: false,
        size: 160,
        meta: { label: 'Active version' },
        cell: ({ row }) => <ActiveCell lineage={row.original} />,
      },
      {
        id: 'draft',
        accessorFn: (row) => row.draft?.versionNumber ?? null,
        header: 'Open draft',
        enableSorting: false,
        size: 150,
        meta: { label: 'Open draft' },
        cell: ({ row }) => <DraftCell lineage={row.original} />,
      },
      {
        // AG-20 — the Version column used to be hideable and the choice persisted, which left an
        // admin staring at a list where the only thing distinguishing two rows was invisible.
        // With one row per lineage the count is the lineage's own size, and it always shows.
        accessorKey: 'versionCount',
        header: 'Versions',
        enableSorting: false,
        enableHiding: false,
        size: 110,
        meta: { label: 'Versions' },
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1 text-xs">
            <span className="font-mono">{formatNumber(row.original.versionCount)}</span>
            {row.original.deprecatedCount > 0 ? <span className="text-muted-foreground">({formatNumber(row.original.deprecatedCount)} deprecated)</span> : null}
          </span>
        ),
      },
      {
        id: 'serves',
        accessorFn: (row) => (row.assignment.tenantDefault ? 'tenant' : row.assignment.departmentCount > 0 ? 'department' : 'unassigned'),
        header: 'Serves',
        enableSorting: false,
        size: 200,
        meta: { label: 'Serves' },
        cell: ({ row }) => <AssignmentBadges {...row.original.assignment} />,
      },
      {
        id: 'origin',
        accessorFn: (row) => row.origin.sourceTenantId ?? '',
        header: 'Origin',
        enableSorting: false,
        size: 140,
        meta: { label: 'Origin' },
        cell: ({ row }) => <OriginBadge sourceTenantId={row.original.origin.sourceTenantId} />,
      },
      {
        id: 'tags',
        accessorFn: (row) => row.tags.join(' '),
        header: 'Tags',
        enableSorting: false,
        size: 200,
        meta: { label: 'Tags' },
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
        size: 140,
        meta: { label: 'Updated' },
        cell: ({ row }) => <span className="text-muted-foreground text-xs">{formatRelativeTime(row.original.updatedAt)}</span>,
      },
    ],
    [selectedSlug],
  );

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Agents"
            meta={
              <>
                {lineagesQuery.data ? (
                  <span>
                    {formatNumber(total)} agents · {formatNumber(versionsOnPage)} versions on this page
                  </span>
                ) : (
                  <Skeleton className="h-4 w-40" />
                )}
                <span className="text-xs">one row per agent · versions, activation and assignment inside</span>
              </>
            }
            actions={
              <>
                {/* The file input is the control; the button is its visible label — the
                    workflow-studio toolbar pattern. */}
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  aria-label="Agent bundle to import"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void handleImport(file);
                  }}
                />
                <Button variant="outline" disabled={importAgent.isPending} onClick={() => importInputRef.current?.click()}>
                  <IconUpload aria-hidden className="size-4" />
                  Import
                </Button>
                <Button onClick={() => setCreating(true)}>
                  <IconPlus aria-hidden className="size-4" />
                  New agent
                </Button>
              </>
            }
          />
        }
        footer={
          <StatusFooter
            start={lineagesQuery.data ? `${formatNumber(rows.length)} of ${formatNumber(total)} agents` : 'Loading…'}
            end={ENDPOINT_HINT}
          />
        }
      >
        <AdminDataGrid<AgentLineage>
          gridId="agents"
          aria-label="Agents"
          columns={columns}
          rows={rows}
          total={total}
          getRowId={(row) => row.slug}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          isLoading={lineagesQuery.isLoading}
          isBusy={lineagesQuery.isFetching && !lineagesQuery.isLoading}
          error={lineagesQuery.error}
          onRetry={() => void lineagesQuery.refetch()}
          onRowClick={(row) => void setSelectedSlug(row.slug)}
          emptyState={
            <EmptyState
              icon={IconRobot}
              title="No agents yet"
              description="Create an agent: pick a task, bind a catalogue model, set its instruction and parameters, then publish it. A new tenant starts with the platform's default agents already cloned in — editable like any other."
              action={
                <Button onClick={() => setCreating(true)}>
                  <IconPlus aria-hidden className="size-4" />
                  New agent
                </Button>
              }
            />
          }
          emptyFilteredState={
            <EmptyState
              icon={IconFilterOff}
              title="No agents match your filters"
              description="Clear the search and filters to see every agent."
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

      <CreateAgentWizard
        open={creating}
        onOpenChange={setCreating}
        onCreated={(agent) => {
          setCreating(false);
          void setSelectedSlug(agent.slug);
        }}
      />
      <AgentLineageDrawer slug={selectedSlug || null} lineage={selected} onOpenChange={(open) => !open && void setSelectedSlug('')} />
    </>
  );
}
