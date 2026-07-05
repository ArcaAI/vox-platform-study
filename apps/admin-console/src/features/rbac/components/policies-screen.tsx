'use client';

import { useState } from 'react';
import { IconDots, IconLock, IconPencil, IconPlus, IconShieldSearch, IconTrash } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { BreakGlassDialog, type BreakGlassCredentials } from '@/shared/confirm/break-glass-dialog';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useDeletePolicy, usePolicies } from '../api/hooks';
import type { Policy, PolicyScope } from '../api/types';
import { PolicyFormSheet } from './policy-form-sheet';

const DEFAULT_LIMIT = 25;

const SCOPE_OPTIONS: FilterOption[] = [
    { value: 'GLOBAL', label: 'Global' },
    { value: 'TENANT', label: 'Tenant' },
];

const SCOPE_LABELS: Record<PolicyScope, string> = { GLOBAL: 'Global', TENANT: 'Tenant' };

function RowActions({ policy, onEdit, onDelete }: { policy: Policy; onEdit: () => void; onDelete: () => void }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Open actions for ${policy.name}`} onClick={(event) => event.stopPropagation()}>
                    <IconDots aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            {/* The portal content still bubbles through the React tree to the row's onClick. */}
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                <DropdownMenuItem onSelect={onEdit}>
                    <IconPencil aria-hidden />
                    Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* Protected system policies are the anti-lockout set — the gateway always refuses (403). */}
                <DropdownMenuItem variant="destructive" disabled={policy.isProtected} onSelect={onDelete}>
                    <IconTrash aria-hidden />
                    Delete
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * Frame 22 — RBAC Policies (/rbac/policies, shared tier 20-29). Paginated
 * list (one-based page + pageSize envelope) with search/scope filters, the
 * create/edit sheet hosting the JSON rules editor, and break-glass delete
 * (DELETE body carries password + confirmationName = the POLICY's exact name).
 */
export function PoliciesScreen() {
    const [{ search, scope, page, limit }, setParams] = useQueryStates({
        search: parseAsString.withDefault(''),
        scope: parseAsString.withDefault(''),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(DEFAULT_LIMIT),
    });

    const query = usePolicies({
        // TablePagination is zero-based; the RBAC gateway pages from 1.
        page: page + 1,
        pageSize: limit,
        ...(search ? { search } : {}),
        ...(scope ? { scope: scope as PolicyScope } : {}),
    });
    const rows = query.data?.data ?? [];
    const total = query.data?.total ?? 0;

    const [sheet, setSheet] = useState<{ open: boolean; policyId: string | null }>({ open: false, policyId: null });
    const [deleteTarget, setDeleteTarget] = useState<Policy | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const deletePolicy = useDeletePolicy();

    function closeDeleteDialog() {
        setDeleteTarget(null);
        setDeleteError(null);
        deletePolicy.reset();
    }

    function handleDeleteConfirm(credentials: BreakGlassCredentials) {
        if (!deleteTarget) return;
        deletePolicy.mutate(
            { id: deleteTarget.id, breakGlass: credentials },
            {
                onSuccess: () => {
                    toast.success('Policy deleted');
                    closeDeleteDialog();
                },
                // 401 wrong password / 400 name mismatch / 403 protected —
                // surfaced inside the dialog, not as a toast.
                onError: (error) => setDeleteError(error.message),
            },
        );
    }

    const columns: DataTableColumn<Policy>[] = [
        {
            key: 'name',
            header: 'Policy',
            cell: (row) => (
                <span className="flex items-center gap-2">
                    <span className="font-medium">{row.name}</span>
                    {row.isProtected ? (
                        <Badge variant="secondary">
                            <IconLock aria-hidden />
                            Protected
                        </Badge>
                    ) : null}
                </span>
            ),
        },
        { key: 'scope', header: 'Scope', cell: (row) => <Badge variant="outline">{SCOPE_LABELS[row.scope] ?? row.scope}</Badge> },
        {
            key: 'rules',
            header: 'Rules',
            cell: (row) => <span className="tabular-nums">{formatNumber(row.rules.length)}</span>,
        },
        { key: 'status', header: 'Status', cell: (row) => <ResourceStatusBadge status={row.resourceStatus} /> },
        {
            key: 'updated',
            header: 'Updated',
            cell: (row) => <span className="text-muted-foreground">{formatRelativeTime(row.updatedAt)}</span>,
        },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            className: 'w-12 text-right',
            cell: (row) => (
                <RowActions
                    policy={row}
                    onEdit={() => setSheet({ open: true, policyId: row.id })}
                    onDelete={() => setDeleteTarget(row)}
                />
            ),
        },
    ];

    const hasFilters = Boolean(search || scope);

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Policies"
                meta={
                    <>
                        {query.data ? <span>{formatNumber(total)} policies</span> : <Skeleton className="h-4 w-24" />}
                        <span>resource.action grammar</span>
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            GET /admin/rbac/policies
                        </span>
                    </>
                }
                actions={
                    <Button onClick={() => setSheet({ open: true, policyId: null })}>
                        <IconPlus aria-hidden />
                        New policy
                    </Button>
                }
            />
            <FilterBar shown={rows.length} total={total}>
                <FilterSearch
                    label="Search policies"
                    placeholder={'Search policies\u2026'}
                    value={search}
                    onChange={(value) => setParams({ search: value || null, page: null })}
                />
                <FilterSelect
                    id="policies-scope-filter"
                    label="Scope"
                    value={scope}
                    onChange={(value) => setParams({ scope: value || null, page: null })}
                    options={SCOPE_OPTIONS}
                />
            </FilterBar>
            <DataTable
                aria-label="Policies"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={query.isPending}
                error={query.error}
                onRetry={() => void query.refetch()}
                empty={
                    <EmptyState
                        icon={IconShieldSearch}
                        title="No policies match"
                        description="Seeded platform defaults always exist — adjust the filters or create a new policy."
                        action={
                            hasFilters ? (
                                <Button variant="outline" onClick={() => setParams({ search: null, scope: null, page: null })}>
                                    Clear filters
                                </Button>
                            ) : (
                                <Button onClick={() => setSheet({ open: true, policyId: null })}>
                                    <IconPlus aria-hidden />
                                    New policy
                                </Button>
                            )
                        }
                    />
                }
                onRowClick={(row) => setSheet({ open: true, policyId: row.id })}
            />
            <TablePagination
                page={page}
                limit={limit}
                total={total}
                onPageChange={(next) => setParams({ page: next || null })}
                onLimitChange={(next) => setParams({ limit: next === DEFAULT_LIMIT ? null : next, page: null })}
            />
            <PolicyFormSheet
                open={sheet.open}
                onOpenChange={(open) => setSheet((current) => ({ open, policyId: open ? current.policyId : null }))}
                policyId={sheet.policyId}
            />
            <BreakGlassDialog
                key={deleteTarget?.id ?? 'delete-policy'}
                open={deleteTarget !== null}
                onOpenChange={(open) => !open && closeDeleteDialog()}
                title="Delete policy"
                description={
                    <>
                        Soft-deletes <span className="font-mono">{deleteTarget?.name}</span>. Roles holding it lose the permissions it grants.
                        Confirm with your password and the exact policy name.
                    </>
                }
                confirmationName={deleteTarget?.name ?? ''}
                confirmLabel="Delete policy"
                onConfirm={handleDeleteConfirm}
                isPending={deletePolicy.isPending}
                error={deleteError}
            />
        </div>
    );
}
