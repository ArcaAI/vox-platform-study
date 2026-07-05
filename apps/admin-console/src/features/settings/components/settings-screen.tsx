'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconEye, IconEyeOff, IconFilterOff, IconLock, IconPencil, IconPlus, IconSettings, IconTrash } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import type { ListParams } from '@/shared/api';
import { RequirePermission } from '@/shared/auth/require-permission';
import { useSession } from '@/shared/auth/hooks';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { useDeleteGlobalSetting, useGlobalSettings, useRevealGlobalSetting, useTenantScopedSettings } from '../api/hooks';
import type { GlobalSetting } from '../api/types';
import { CreateSettingDialog, EditSettingDialog } from './setting-dialogs';

const DEFAULT_SORT = 'key:asc';
const DEFAULT_LIMIT = 25;
const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

/**
 * Step-up reveal (frame 24 matrix: "reveal gated by re-auth"): the caller
 * re-enters their password; every reveal is audit-logged server-side.
 */
function RevealSecretDialog({
    setting,
    onOpenChange,
    onRevealed,
}: {
    setting: GlobalSetting;
    onOpenChange: (open: boolean) => void;
    onRevealed: (value: string) => void;
}) {
    const inputId = useId();
    const [password, setPassword] = useState('');
    const revealMutation = useRevealGlobalSetting();

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        revealMutation.mutate(
            { id: setting.id, password },
            {
                onSuccess: (result) => onRevealed(result.value),
                onError: (error) => toast.error(error.message),
            },
        );
    }

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Reveal secret</DialogTitle>
                    <DialogDescription>
                        Re-enter your password to reveal <span className="font-mono">{setting.key}</span>. Every reveal is audit-logged.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={inputId}>Password</Label>
                        <Input
                            id={inputId}
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" disabled={revealMutation.isPending} onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={revealMutation.isPending || !password}>
                            {revealMutation.isPending ? <Spinner /> : null}
                            Reveal secret
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Frame 24 — Settings & secrets (/settings, tier 20-29 shared). Global and
 * working-tenant-scoped settings with masked secrets, permission-gated
 * step-up reveal, OCC If-Match value editing and create/delete flows.
 */
export function SettingsScreen() {
    const [{ scope, q, page, limit, sort }, setParams] = useQueryStates({
        scope: parseAsString.withDefault('global'),
        q: parseAsString.withDefault(''),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(DEFAULT_LIMIT),
        sort: parseAsString.withDefault(''),
    });
    const session = useSession();
    const workingTenantId = session.data?.workingTenantId ?? '';
    const workingTenantName = session.data?.workingTenantName ?? workingTenantId;
    // The tenant tab only exists with a working tenant (BFF injects X-Tenant-Id).
    const effectiveScope = scope === 'tenant' && workingTenantId ? 'tenant' : 'global';

    const listParams: ListParams = {
        page,
        limit,
        sort: sort || DEFAULT_SORT,
        ...(q ? { search: q, searchFields: 'name,key' } : {}),
    };
    const globalQuery = useGlobalSettings(listParams);
    const tenantQuery = useTenantScopedSettings(effectiveScope === 'tenant' ? workingTenantId : '', listParams);
    const active = effectiveScope === 'tenant' ? tenantQuery : globalQuery;
    const rows = active.data?.data ?? [];
    const total = active.data?.count ?? 0;

    const [createOpen, setCreateOpen] = useState(false);
    const [editTarget, setEditTarget] = useState<GlobalSetting | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<GlobalSetting | null>(null);
    const [revealTarget, setRevealTarget] = useState<GlobalSetting | null>(null);
    // Plaintext secrets revealed this session, keyed by row id — dropped on hide.
    const [revealed, setRevealed] = useState<Record<string, string>>({});

    const deleteMutation = useDeleteGlobalSetting();

    function hideSecret(id: string) {
        setRevealed(({ [id]: _hidden, ...rest }) => rest);
    }

    function confirmDelete() {
        if (!deleteTarget) return;
        deleteMutation.mutate(deleteTarget.id, {
            onSuccess: () => {
                toast.success(`${deleteTarget.key} deleted`);
                setDeleteTarget(null);
            },
            onError: (error) => toast.error(error.message),
        });
    }

    function renderValue(row: GlobalSetting) {
        if (!row.isSecret) {
            return <span className="inline-block max-w-56 truncate align-middle font-mono text-xs">{row.value || '\u2014'}</span>;
        }
        const plaintext = revealed[row.id];
        if (plaintext !== undefined) {
            return (
                <span className="flex items-center gap-1">
                    <span className="max-w-56 truncate font-mono text-xs">{plaintext}</span>
                    <CopyButton value={plaintext} label={`Copy ${row.key}`} />
                    <Button variant="ghost" size="icon-sm" aria-label={`Hide ${row.key}`} onClick={() => hideSecret(row.id)}>
                        <IconEyeOff aria-hidden />
                    </Button>
                </span>
            );
        }
        return (
            <span className="flex items-center gap-1">
                <span aria-hidden className="tracking-wider">
                    {MASK}
                </span>
                <span className="sr-only">Secret value hidden</span>
                {/* Reveal is global-admin only per the frame 24 matrix. */}
                <RequirePermission action="manage" subject="all">
                    <Button variant="ghost" size="icon-sm" aria-label={`Reveal ${row.key}`} onClick={() => setRevealTarget(row)}>
                        <IconEye aria-hidden />
                    </Button>
                </RequirePermission>
            </span>
        );
    }

    const columns: DataTableColumn<GlobalSetting>[] = [
        {
            key: 'key',
            header: 'Key',
            sortKey: 'key',
            cell: (row) => (
                <span className="flex items-center gap-1.5 font-mono text-xs">
                    {row.key}
                    {row.locked ? (
                        <>
                            <IconLock aria-hidden className="text-muted-foreground size-3.5" />
                            <span className="sr-only">locked</span>
                        </>
                    ) : null}
                </span>
            ),
        },
        {
            key: 'namespace',
            header: 'Namespace',
            cell: (row) => <span className="text-muted-foreground">{row.namespace || '\u2014'}</span>,
        },
        { key: 'type', header: 'Type', cell: (row) => <span className="text-muted-foreground">{row.dataType}</span> },
        { key: 'value', header: 'Value', cell: renderValue },
        {
            key: 'updated',
            header: 'Updated',
            sortKey: 'updatedAt',
            cell: (row) => <span className="text-muted-foreground">{formatRelativeTime(row.updatedAt)}</span>,
        },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            className: 'w-20 text-right',
            cell: (row) => (
                <span className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.key}`} onClick={() => setEditTarget(row)}>
                        <IconPencil aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${row.key}`} onClick={() => setDeleteTarget(row)}>
                        <IconTrash aria-hidden />
                    </Button>
                </span>
            ),
        },
    ];

    const hasFilters = Boolean(q);
    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No settings match your search"
            description="Try a different search term."
            action={
                <Button variant="outline" onClick={() => setParams({ q: null, page: null })}>
                    <IconFilterOff aria-hidden />
                    Clear search
                </Button>
            }
        />
    ) : effectiveScope === 'tenant' ? (
        <EmptyState
            icon={IconSettings}
            title="No tenant-scoped settings"
            description="Platform defaults apply until a setting is scoped to this tenant."
        />
    ) : (
        <EmptyState
            icon={IconSettings}
            title="No settings yet"
            description="Create the first platform-wide setting. Secret values stay masked after creation."
            action={
                <Button onClick={() => setCreateOpen(true)}>
                    <IconPlus aria-hidden />
                    New setting
                </Button>
            }
        />
    );

    const region = (
        <div className="flex flex-col gap-4">
            <FilterBar shown={rows.length} total={total}>
                <FilterSearch
                    label="Search settings"
                    placeholder={'Search settings\u2026'}
                    value={q}
                    onChange={(value) => setParams({ q: value || null, page: null })}
                />
            </FilterBar>
            <DataTable
                aria-label={effectiveScope === 'tenant' ? 'Tenant settings' : 'Global settings'}
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={active.isLoading}
                error={active.error}
                onRetry={() => active.refetch()}
                empty={empty}
                sort={sort || DEFAULT_SORT}
                onSortChange={(next) => setParams({ sort: next === DEFAULT_SORT ? null : next, page: null })}
            />
            <TablePagination
                page={page}
                limit={limit}
                total={total}
                onPageChange={(next) => setParams({ page: next || null })}
                onLimitChange={(next) => setParams({ limit: next === DEFAULT_LIMIT ? null : next, page: null })}
            />
        </div>
    );

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Settings & secrets"
                meta={
                    <>
                        {active.data ? <span>{formatNumber(total)} settings</span> : <Skeleton className="h-4 w-20" />}
                        <span aria-hidden>&middot;</span>
                        <span>secrets masked &mdash; reveal is audited</span>
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            GET /admin/settings
                        </span>
                    </>
                }
                actions={
                    <Button onClick={() => setCreateOpen(true)}>
                        <IconPlus aria-hidden />
                        New setting
                    </Button>
                }
            />
            <Tabs value={effectiveScope} onValueChange={(next) => setParams({ scope: next === 'global' ? null : next, page: null })}>
                <TabsList>
                    <TabsTrigger value="global">Global</TabsTrigger>
                    {workingTenantId ? <TabsTrigger value="tenant">Tenant: {workingTenantName}</TabsTrigger> : null}
                </TabsList>
                <TabsContent value={effectiveScope} className="mt-2">
                    {region}
                </TabsContent>
            </Tabs>
            {createOpen ? <CreateSettingDialog onOpenChange={setCreateOpen} /> : null}
            {editTarget ? (
                <EditSettingDialog
                    key={editTarget.id}
                    setting={editTarget}
                    onOpenChange={(open) => {
                        if (!open) setEditTarget(null);
                    }}
                />
            ) : null}
            {revealTarget ? (
                <RevealSecretDialog
                    key={revealTarget.id}
                    setting={revealTarget}
                    onOpenChange={(open) => {
                        if (!open) setRevealTarget(null);
                    }}
                    onRevealed={(value) => {
                        setRevealed((current) => ({ ...current, [revealTarget.id]: value }));
                        setRevealTarget(null);
                    }}
                />
            ) : null}
            <ConfirmDialog
                open={deleteTarget !== null}
                onOpenChange={(open) => {
                    if (!open) setDeleteTarget(null);
                }}
                title={`Delete ${deleteTarget?.key ?? 'setting'}?`}
                description="Consumers fall back to their built-in default for this key. Deleting a secret does not rotate downstream credentials."
                confirmLabel="Delete setting"
                destructive
                isPending={deleteMutation.isPending}
                onConfirm={confirmDelete}
            />
        </div>
    );
}
