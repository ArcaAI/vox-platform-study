'use client';

import { useEffect, useState } from 'react';
import { IconHierarchy, IconPlus, IconSearch } from '@tabler/icons-react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useDepartments, useRootDepartments } from '../api/hooks';
import type { Department } from '../api/types';
import { CreateDepartmentDialog } from './create-department-dialog';
import { DepartmentEditPanel } from './department-edit-panel';
import { DepartmentHierarchyPanel } from './department-hierarchy-panel';
import { DepartmentMembersPanel } from './department-members-panel';

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
    const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
    const [includeDisabled, setIncludeDisabled] = useQueryState('disabled', parseAsBoolean.withDefault(false));
    const [selectedParam, setSelectedParam] = useQueryState('dept', parseAsString.withDefault(''));
    const [createOpen, setCreateOpen] = useState(false);

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

    // Default the selection to the first root so the members/edit panels are
    // populated on arrival (frame 30 shows Cardiology pre-selected).
    const selectedId = selectedParam || roots.data?.[0]?.id || departments[0]?.id || '';
    const selected = departments.find((department) => department.id === selectedId);
    const selectedName = selected ? selected.name || selected.code || selected.id : selectedId;

    const isEmpty = list.data !== undefined && departments.length === 0;

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
                                        {selected ? ` \u00b7 selected: ${selectedName}` : ''}
                                    </span>
                                ) : (
                                    <Skeleton className="h-4 w-40" />
                                )}
                            </>
                        }
                        actions={
                            <Button onClick={() => setCreateOpen(true)}>
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
                        <div className="relative w-64 max-w-full">
                            <IconSearch aria-hidden className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                            <Input
                                aria-label="Search departments"
                                placeholder={'Search departments\u2026'}
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
                            <Button onClick={() => setCreateOpen(true)}>
                                <IconPlus aria-hidden />
                                New department
                            </Button>
                        }
                    />
                ) : (
                    <div className="grid items-start gap-4 xl:grid-cols-[minmax(240px,1fr)_minmax(0,1.6fr)_minmax(260px,1fr)]">
                        <DepartmentHierarchyPanel
                            roots={roots.data ?? []}
                            rootsPending={roots.isPending}
                            rootsError={roots.error}
                            onRetryRoots={() => void roots.refetch()}
                            searchResults={searchResults}
                            searching={searching}
                            selectedId={selectedId}
                            onSelect={(id) => void setSelectedParam(id)}
                        />
                        {selectedId ? (
                            <>
                                {/* key remounts reset the members page when the selection moves. */}
                                <DepartmentMembersPanel key={selectedId} departmentId={selectedId} departmentName={selectedName} />
                                <DepartmentEditPanel departmentId={selectedId} departments={departments} onDeleted={() => void setSelectedParam(null)} />
                            </>
                        ) : null}
                    </div>
                )}
            </ScreenTemplate>
            <CreateDepartmentDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                departments={departments}
                onCreated={(created) => void setSelectedParam(created.id)}
            />
        </>
    );
}

/**
 * Frame 30 — Departments (tier 30–49): hierarchy card (roots + lazy
 * children), members grid for the selected department, and the If-Match edit
 * panel with the prompt-config bridge. Tenant-scoped: elevated sessions must
 * pick a working tenant first (every read 400s without one).
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
