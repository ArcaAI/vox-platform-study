'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconEye, IconEyeOff, IconFilterOff, IconLock, IconPencil, IconPlus, IconSettings, IconTrash } from '@tabler/icons-react';
import { parseAsString, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
import { type ColumnDef, type SortRule } from '@arcaai/ui';
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
import { RequirePermission } from '@/shared/auth/require-permission';
import { useSession } from '@/shared/auth/hooks';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { useDeleteGlobalSetting, useGlobalSettings, useRevealGlobalSetting, useTenantScopedSettings } from '../api/hooks';
import type { GlobalSetting } from '../api/types';
import { CreateSettingDialog, EditSettingDialog } from './setting-dialogs';

/** Omni search targets (→ gateway `searchFields`) and the implicit sort — stable refs for the hook. */
const SETTING_SEARCH_FIELDS = ['name', 'key'];
const SETTING_DEFAULT_SORT: SortRule[] = [{ id: 'key', desc: false }];
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
 * Frame 24 — Settings & secrets (/settings, tier 20-29 shared). AdminDataGrid
 * (omni search + sort + pager) over global and working-tenant-scoped settings
 * with masked secrets, permission-gated step-up reveal, OCC If-Match value
 * editing and create/delete flows. The scope tab rides its own URL param
 * (orthogonal to the grid's query-state) and switches the active list hook.
 */
export function SettingsScreen() {
    const [{ scope }, setScopeParams] = useQueryStates({ scope: parseAsString.withDefault('global') });
    const query = useAdminGridParams({ searchFields: SETTING_SEARCH_FIELDS, defaultSort: SETTING_DEFAULT_SORT });

    const session = useSession();
    const workingTenantId = session.data?.workingTenantId ?? '';
    const workingTenantName = session.data?.workingTenantName ?? workingTenantId;
    // The tenant tab only exists with a working tenant (BFF injects X-Tenant-Id).
    const effectiveScope = scope === 'tenant' && workingTenantId ? 'tenant' : 'global';

    const globalQuery = useGlobalSettings(query.listParams);
    const tenantQuery = useTenantScopedSettings(effectiveScope === 'tenant' ? workingTenantId : '', query.listParams);
    const active = effectiveScope === 'tenant' ? tenantQuery : globalQuery;
    const { rows, total } = normalizeList<GlobalSetting>(active.data);
    const totalCount = total ?? 0;

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

    const columns: ColumnDef<GlobalSetting>[] = [
        {
            accessorKey: 'key',
            header: 'Key',
            meta: { label: 'Key' },
            size: 240,
            minSize: 160,
            cell: ({ row }) => (
                <span className="flex items-center gap-1.5 font-mono text-xs">
                    {row.original.key}
                    {row.original.locked ? (
                        <>
                            <IconLock aria-hidden className="text-muted-foreground size-3.5" />
                            <span className="sr-only">locked</span>
                        </>
                    ) : null}
                </span>
            ),
        },
        {
            id: 'namespace',
            header: 'Namespace',
            enableSorting: false,
            meta: { label: 'Namespace' },
            size: 140,
            cell: ({ row }) => <span className="text-muted-foreground">{row.original.namespace || '\u2014'}</span>,
        },
        {
            id: 'type',
            header: 'Type',
            enableSorting: false,
            meta: { label: 'Type' },
            size: 100,
            cell: ({ row }) => <span className="text-muted-foreground">{row.original.dataType}</span>,
        },
        {
            id: 'value',
            header: 'Value',
            enableSorting: false,
            meta: { label: 'Value' },
            size: 260,
            cell: ({ row }) => renderValue(row.original),
        },
        {
            accessorKey: 'updatedAt',
            header: 'Updated',
            meta: { label: 'Updated' },
            size: 150,
            cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.updatedAt)}</span>,
        },
        {
            id: 'actions',
            header: () => <span className="sr-only">Actions</span>,
            meta: { label: 'Actions' },
            enableSorting: false,
            enableHiding: false,
            enableResizing: false,
            size: 88,
            minSize: 88,
            cell: ({ row }) => (
                <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.original.key}`} onClick={() => setEditTarget(row.original)}>
                        <IconPencil aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${row.original.key}`} onClick={() => setDeleteTarget(row.original)}>
                        <IconTrash aria-hidden />
                    </Button>
                </div>
            ),
        },
    ];

    const emptyState =
        effectiveScope === 'tenant' ? (
            <EmptyState icon={IconSettings} title="No tenant-scoped settings" description="Platform defaults apply until a setting is scoped to this tenant." />
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

    return (
        <Tabs
            className="flex min-h-0 flex-1 flex-col"
            value={effectiveScope}
            onValueChange={(next) => {
                setScopeParams({ scope: next === 'global' ? null : next });
                // Switching scope swaps the result set — return to the first page (legacy parity).
                const limit = query.queryState.pagination.mode === 'offset' ? query.queryState.pagination.limit : DEFAULT_LIMIT;
                query.setQueryState({ ...query.queryState, pagination: { mode: 'offset', page: 0, limit } });
            }}
        >
            <ScreenTemplate
                contentMode="fill"
                header={
                    <PageHeader
                        title="Settings & secrets"
                        meta={
                            <>
                                {active.data ? <span>{formatNumber(totalCount)} settings</span> : <Skeleton className="h-4 w-20" />}
                                <span aria-hidden>&middot;</span>
                                <span>secrets masked &mdash; reveal is audited</span>
                            </>
                        }
                        actions={
                            <Button onClick={() => setCreateOpen(true)}>
                                <IconPlus aria-hidden />
                                New setting
                            </Button>
                        }
                    />
                }
                tabs={
                    <TabsList>
                        <TabsTrigger value="global">Global</TabsTrigger>
                        {workingTenantId ? <TabsTrigger value="tenant">Tenant: {workingTenantName}</TabsTrigger> : null}
                    </TabsList>
                }
                footer={
                    <StatusFooter
                        start={<span>{active.isFetching && !active.isLoading ? 'Refreshing' : 'Up to date'}</span>}
                        end={
                            <span aria-hidden className="font-mono">
                                GET /admin/settings
                            </span>
                        }
                    />
                }
            >
                <TabsContent value={effectiveScope}>
                    <AdminDataGrid<GlobalSetting>
                        gridId="settings"
                        aria-label={effectiveScope === 'tenant' ? 'Tenant settings' : 'Global settings'}
                        columns={columns}
                        rows={rows}
                        total={totalCount}
                        queryState={query.queryState}
                        onQueryStateChange={query.setQueryState}
                        isLoading={active.isLoading}
                        isBusy={active.isFetching && !active.isLoading}
                        error={active.error}
                        onRetry={() => active.refetch()}
                        emptyState={emptyState}
                        emptyFilteredState={
                            <EmptyState
                                icon={IconFilterOff}
                                title="No settings match your search"
                                description="Try a different search term."
                                action={
                                    <Button
                                        variant="outline"
                                        onClick={() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] })}
                                    >
                                        <IconFilterOff aria-hidden />
                                        Clear search
                                    </Button>
                                }
                            />
                        }
                    />
                </TabsContent>
            </ScreenTemplate>
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
        </Tabs>
    );
}
