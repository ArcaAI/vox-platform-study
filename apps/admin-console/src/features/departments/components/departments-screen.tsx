'use client';

import { useEffect, useState } from 'react';
import { IconHierarchy, IconPlus, IconSearch } from '@tabler/icons-react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { useViewportTier } from '@/shared/layout/use-viewport-tier';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useDepartments, useRootDepartments } from '../api/hooks';
import type { Department } from '../api/types';
import { DepartmentDetailDrawer } from './department-detail';
import { DepartmentHierarchyPanel } from './department-hierarchy-panel';
import { DepartmentMembersPanel } from './department-members-panel';
import { DepartmentPromptConfigPanel } from './department-prompt-config-panel';

const ENDPOINT_HINT = 'GET /admin/departments';

function matchesSearch(department: Department, needle: string): boolean {
  return [department.name, department.code, department.description].some((field) => field?.toLowerCase().includes(needle));
}

/** Skeleton mirroring the loaded three-panel layout (rule 10). */
function DepartmentsSkeleton() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(240px,1fr)_minmax(0,1.6fr)_minmax(260px,1fr)]" aria-hidden>
      <Skeleton className="h-80" />
      <Skeleton className="h-80" />
      <Skeleton className="h-80" />
    </div>
  );
}

function DepartmentsBody() {
  const tier = useViewportTier();
  const compact = tier !== 'desktop';

  const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
  const [includeDisabled, setIncludeDisabled] = useQueryState('disabled', parseAsBoolean.withDefault(false));
  const [selectedParam, setSelectedParam] = useQueryState('dept', parseAsString.withDefault(''));

  // Drawer state: `creating` opens the create form, `editingId` the edit form.
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // A row-menu "Delete department" opens the same edit drawer with its own
  // type-to-confirm dialog already up, so the destructive flow (confirm copy,
  // token match, has-children 400 handling) has exactly one implementation.
  const [confirmDeleteOnOpen, setConfirmDeleteOnOpen] = useState(false);
  // Compact tiers reach the tree through a toggleable drawer instead of a pane.
  const [treeOpen, setTreeOpen] = useState(false);

  // Debounced (300ms) draft over the URL-synced `q`, re-synced on external
  // changes (back/forward) via the render-time derived-state reset pattern.
  const [searchDraft, setSearchDraft] = useState(search);
  const [lastSearch, setLastSearch] = useState(search);
  if (search !== lastSearch) {
    setLastSearch(search);
    setSearchDraft(search);
  }
  useEffect(() => {
    if (searchDraft === search) return;
    const timer = setTimeout(() => void setSearch(searchDraft || null), 300);
    return () => clearTimeout(timer);
  }, [searchDraft, search, setSearch]);

  // The flat list backs the header count, search, parent options and the
  // cycle guard; the tree renders from roots + lazy :id/children reads.
  const list = useDepartments(includeDisabled ? { includeDisabled: true } : undefined);
  const roots = useRootDepartments();

  const departments = list.data ?? [];
  const needle = search.trim().toLowerCase();
  const searching = needle.length > 0;
  const searchResults = searching ? departments.filter((department) => matchesSearch(department, needle)) : departments;

  // Default the selection to the first root so the members/prompt panes are
  // populated on arrival (frame 30 shows Cardiology pre-selected).
  const selectedId = selectedParam || roots.data?.[0]?.id || departments[0]?.id || '';
  const selected = departments.find((department) => department.id === selectedId);
  const selectedName = selected ? selected.name || selected.code || selected.id : selectedId;

  const isEmpty = list.data !== undefined && departments.length === 0;

  const hierarchy = (
    <DepartmentHierarchyPanel
      roots={roots.data ?? []}
      rootsPending={roots.isPending}
      rootsError={roots.error}
      onRetryRoots={() => void roots.refetch()}
      searchResults={searchResults}
      searching={searching}
      selectedId={selectedId}
      onSelect={(id) => {
        void setSelectedParam(id);
        setTreeOpen(false);
      }}
      onEdit={(id) => {
        setConfirmDeleteOnOpen(false);
        setEditingId(id);
        setTreeOpen(false);
      }}
      onDelete={(id) => {
        setConfirmDeleteOnOpen(true);
        setEditingId(id);
        setTreeOpen(false);
      }}
    />
  );

  return (
    <>
      <ScreenTemplate
        header={
          <PageHeader
            title="Departments"
            meta={
              <>
                {list.data ? (
                  <span>
                    {formatNumber(departments.length)} departments
                    {selected ? ` · selected: ${selectedName}` : ''}
                  </span>
                ) : (
                  <Skeleton className="h-4 w-40" />
                )}
              </>
            }
            actions={
              <Button onClick={() => setCreating(true)}>
                <IconPlus aria-hidden />
                New department
              </Button>
            }
          />
        }
        toolbar={
          /* Not a data grid (frame 30 is a hierarchy tree): a plain toolbar over
                        the client-side search + include-disabled flag, no FilterBar. */
          <div className="bg-card flex flex-wrap items-center gap-3 rounded-md border p-2">
            {compact ? (
              <Button variant="outline" size="sm" onClick={() => setTreeOpen(true)}>
                <IconHierarchy aria-hidden />
                Departments
              </Button>
            ) : null}
            <div className="relative w-64 max-w-full">
              <IconSearch aria-hidden className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input
                aria-label="Search departments"
                placeholder={'Search departments…'}
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                className="h-9 pl-8"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="departments-include-disabled" className="text-muted-foreground text-sm font-normal">
                Include disabled:
              </Label>
              <Switch
                id="departments-include-disabled"
                checked={includeDisabled}
                onCheckedChange={(checked) => setIncludeDisabled(checked || null)}
              />
            </div>
            <span aria-live="polite" className="text-muted-foreground ml-auto pr-2 text-sm">
              Showing {formatNumber(searchResults.length)} of {formatNumber(departments.length)}
            </span>
          </div>
        }
        footer={
          <StatusFooter
            end={
              <span aria-hidden className="font-mono">
                {ENDPOINT_HINT}
              </span>
            }
          />
        }
      >
        {list.isPending ? (
          <DepartmentsSkeleton />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : isEmpty ? (
          <EmptyState
            icon={IconHierarchy}
            title="No departments yet"
            description="Departments organize clinicians and scope prompts and templates. Create the first one to start the hierarchy."
            action={
              <Button onClick={() => setCreating(true)}>
                <IconPlus aria-hidden />
                New department
              </Button>
            }
          />
        ) : compact ? (
          /* Compact tiers: the tree lives in a toggleable drawer; members and
                        prompt config stack below. */
          <div className="flex flex-col gap-4">
            {selectedId ? (
              <>
                <DepartmentMembersPanel key={selectedId} departmentId={selectedId} departmentName={selectedName} />
                <DepartmentPromptConfigPanel key={`${selectedId}-prompt`} departmentId={selectedId} onEdit={() => setEditingId(selectedId)} />
              </>
            ) : null}
          </div>
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(240px,1fr)_minmax(0,1.6fr)_minmax(260px,1fr)]">
            {hierarchy}
            {selectedId ? (
              <>
                {/* key remounts reset the members page when the selection moves. */}
                <DepartmentMembersPanel key={selectedId} departmentId={selectedId} departmentName={selectedName} />
                <DepartmentPromptConfigPanel key={`${selectedId}-prompt`} departmentId={selectedId} onEdit={() => setEditingId(selectedId)} />
              </>
            ) : null}
          </div>
        )}
      </ScreenTemplate>

      {compact ? (
        <DetailDrawer open={treeOpen} onOpenChange={setTreeOpen} size="md" title="Departments">
          {hierarchy}
        </DetailDrawer>
      ) : null}

      <DepartmentDetailDrawer
        key={creating ? 'create' : (editingId ?? 'no-department')}
        departmentId={editingId}
        creating={creating}
        departments={departments}
        confirmDeleteOnOpen={confirmDeleteOnOpen}
        onOpenChange={(open) => {
          if (open) return;
          setCreating(false);
          setEditingId(null);
          setConfirmDeleteOnOpen(false);
        }}
        onCreated={(created) => {
          setCreating(false);
          void setSelectedParam(created.id);
        }}
        onDeleted={() => {
          setEditingId(null);
          setConfirmDeleteOnOpen(false);
          void setSelectedParam(null);
        }}
      />
    </>
  );
}

/**
 * Frame 30 — Departments (tier 30–49): a three-pane surface — hierarchy tree
 * (roots + lazy children), members grid, and prompt-config Selects for the
 * selected department. Create/edit/delete live in the console-wide DetailDrawer;
 * compact tiers collapse the tree into a toggleable drawer. Tenant-scoped:
 * elevated sessions must pick a working tenant first (every read 400s without one).
 */
export function DepartmentsScreen() {
  return (
    <WorkingTenantGate
      title="Departments"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          {ENDPOINT_HINT}
        </span>
      }
      description="Departments are administered per tenant. Pick a working tenant from the switcher in the top bar to load its hierarchy, members and prompt config."
    >
      <DepartmentsBody />
    </WorkingTenantGate>
  );
}
