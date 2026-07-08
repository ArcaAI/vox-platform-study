'use client';

import { useMemo, useState } from 'react';
import { IconFilterOff, IconLock, IconPlus, IconSettings, IconTrash } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { type ColumnDef, type GroupByConfig, type SortRule } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import type { ListParams } from '@/shared/api';
import { useTenantCatalog, useTenantNames } from '@/shared/catalog';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { toListParams } from '@/shared/data/grid-url-state';
import { NameWithId } from '@/shared/data/name-with-id';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { useDeleteGlobalSetting, useGlobalSettings, useSettingNamespaces } from '../api/hooks';
import type { GlobalSetting } from '../api/types';
import { SettingCreateDrawer, SettingDetailDrawer } from './setting-drawer';

/** Omni search targets (→ gateway `searchFields`) and the implicit sort — stable refs for the hook. */
const SETTING_SEARCH_FIELDS = ['name', 'key'];
/**
 * TASK-443 — namespace FIRST so the grouped list's groups are contiguous per
 * server page (grouping is display-only; the sort is what forms the groups).
 */
const SETTING_DEFAULT_SORT: SortRule[] = [
    { id: 'namespace', desc: false },
    { id: 'key', desc: false },
];
/** TASK-443 — namespace group-header rows (label + count) in the grid. */
const SETTING_GROUP_BY: GroupByConfig<GlobalSetting> = { accessor: (row) => row.namespace ?? null };
/**
 * TASK-443 — the Secrets-only chip's filter id. `isSecret` is DERIVED on the
 * gateway (encrypted value OR `secrets` namespace OR convention-named key),
 * not a column, so the rule is stripped from the bracket grammar and remapped
 * to the bespoke `secretsOnly` query param before the request is built.
 */
const SECRETS_FILTER_ID = 'isSecret';
/** `ValueType` members (packages/database enums.prisma) for the Type chip; the gateway 400s anything else. */
const VALUE_TYPE_OPTIONS: FilterOption[] = [
    'String',
    'Integer',
    'Float',
    'Double',
    'Decimal',
    'Boolean',
    'Json',
    'Date',
    'DateTime',
    'Array',
    'Uuid',
    'Binary',
    'Enum',
    'Hstore',
    'Inet',
    'Citext',
    'Interval',
].map((value) => ({ value, label: value }));
const MASK = '••••••••';
/** Sentinel `?setting=` value that opens the create drawer instead of a detail. */
const CREATE_SENTINEL = 'new';

/**
 * Frame 24 — Settings & secrets (/settings, tier 20-29 shared). AdminDataGrid
 * (omni search + sort + pager) over the settings visible to the caller. Rows are
 * read-only in the list — masked secrets, plaintext non-secrets — and clicking a
 * row (or "New setting") opens the console-wide DetailDrawer (TASK-437/439) that
 * carries the type-aware value editor (a real code editor for Json/Array),
 * permission-gated step-up reveal, guided secret rotation, OCC If-Match editing
 * and an audit-log-backed History tab. Scope is decided by the working-tenant
 * switcher; an UNSCOPED super-admin gets the cross-tenant listing (TASK-430) with
 * a Tenant column + filter.
 */
export function SettingsScreen() {
    const query = useAdminGridParams({ searchFields: SETTING_SEARCH_FIELDS, defaultSort: SETTING_DEFAULT_SORT });

    // TASK-443 — remap the Secrets-only chip: strip the derived `isSecret` rule
    // from the serialized bracket filters and carry it as the bespoke
    // `secretsOnly` extra param instead (page-reset/URL behaviour untouched —
    // the rule still lives in the grid's query state like any other filter).
    const listParams = useMemo<ListParams>(() => {
        const secretsRule = query.queryState.filters.find((rule) => rule.id === SECRETS_FILTER_ID);
        if (!secretsRule) return query.listParams;
        const withoutSecretsRule = { ...query.queryState, filters: query.queryState.filters.filter((rule) => rule.id !== SECRETS_FILTER_ID) };
        return { ...toListParams(withoutSecretsRule, { searchFields: SETTING_SEARCH_FIELDS }), secretsOnly: String(secretsRule.value) === 'true' };
    }, [query.queryState, query.listParams]);

    const settingsQuery = useGlobalSettings(listParams);
    const { rows, total } = normalizeList<GlobalSetting>(settingsQuery.data);
    const totalCount = total ?? 0;

    // TASK-430 — Tenant column + filter on the cross-tenant listing.
    const tenantNames = useTenantNames();
    const tenantCatalog = useTenantCatalog();
    const tenantOptions = useMemo<FilterOption[]>(
        () => (tenantCatalog.data ?? []).map((tenant) => ({ value: tenant.id, label: tenant.name || tenant.key || tenant.id })),
        [tenantCatalog.data],
    );

    // TASK-443 — Namespace chip options: the cached distinct-namespace catalog,
    // merged with any URL-selected values so a shared link always renders its chips.
    const namespaceCatalog = useSettingNamespaces();
    const namespaceOptions = useMemo<FilterOption[]>(() => {
        const known = new Set(namespaceCatalog.data ?? []);
        const active = query.queryState.filters.find((rule) => rule.id === 'namespace');
        if (Array.isArray(active?.value)) {
            for (const value of active.value) {
                if (typeof value === 'string' && value) known.add(value);
            }
        }
        return [...known].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }));
    }, [namespaceCatalog.data, query.queryState.filters]);

    // Drawer selection rides the URL so a row/detail is deep-linkable and back-navigable.
    const [selected, setSelected] = useQueryState('setting', parseAsString);
    const [deleteTarget, setDeleteTarget] = useState<GlobalSetting | null>(null);

    const deleteMutation = useDeleteGlobalSetting();

    function confirmDelete() {
        if (!deleteTarget) return;
        deleteMutation.mutate(deleteTarget.id, {
            onSuccess: () => {
                toast.success(`${deleteTarget.key} deleted`);
                if (selected === deleteTarget.id) void setSelected(null);
                setDeleteTarget(null);
            },
            onError: (error) => toast.error(error.message),
        });
    }

    function renderValue(row: GlobalSetting) {
        if (!row.isSecret) {
            return <span className="inline-block max-w-56 truncate align-middle font-mono text-xs">{row.value || '—'}</span>;
        }
        return (
            <span className="flex items-center gap-1">
                <span aria-hidden className="tracking-wider">
                    {MASK}
                </span>
                <span className="sr-only">Secret value hidden — open the row to reveal</span>
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
            accessorKey: 'namespace',
            header: 'Namespace',
            enableSorting: false,
            // TASK-443 — server-driven multiSelect facet (namespace[in]:…).
            meta: { label: 'Namespace', variant: 'multiSelect', options: namespaceOptions },
            size: 140,
            cell: ({ row }) => <span className="text-muted-foreground">{row.original.namespace || '—'}</span>,
        },
        {
            accessorKey: 'tenantId',
            header: 'Tenant',
            enableSorting: false,
            meta: { label: 'Tenant', variant: 'multiSelect', options: tenantOptions },
            size: 180,
            cell: ({ row }) =>
                row.original.tenantId ? (
                    <NameWithId name={tenantNames.get(row.original.tenantId)} id={row.original.tenantId} />
                ) : (
                    <span className="text-muted-foreground">{'—'}</span>
                ),
        },
        {
            // TASK-443 — the column id IS the gateway field (`dataType[in]:…`).
            accessorKey: 'dataType',
            header: 'Type',
            enableSorting: false,
            meta: { label: 'Type', variant: 'multiSelect', options: VALUE_TYPE_OPTIONS },
            size: 100,
            cell: ({ row }) => <span className="text-muted-foreground">{row.original.dataType}</span>,
        },
        {
            // TASK-443 — Secrets-only: a FILTER-ONLY virtual column (never
            // rendered; `isSecret` is derived server-side). The screen remaps
            // its rule onto the bespoke `secretsOnly` query param.
            accessorKey: SECRETS_FILTER_ID,
            enableSorting: false,
            meta: {
                label: 'Secrets',
                variant: 'boolean',
                filterOnly: true,
                options: [
                    { value: 'true', label: 'Secrets only' },
                    { value: 'false', label: 'Non-secrets' },
                ],
            },
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
            size: 56,
            minSize: 56,
            cell: ({ row }) => (
                <div className="flex items-center justify-end">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${row.original.key}`}
                        onClick={(event) => {
                            // The row's own click opens the drawer — keep delete from doing both.
                            event.stopPropagation();
                            setDeleteTarget(row.original);
                        }}
                    >
                        <IconTrash aria-hidden />
                    </Button>
                </div>
            ),
        },
    ];

    const emptyState = (
        <EmptyState
            icon={IconSettings}
            title="No settings yet"
            description="Create the first setting. Secret values stay masked after creation."
            action={
                <Button onClick={() => void setSelected(CREATE_SENTINEL)}>
                    <IconPlus aria-hidden />
                    New setting
                </Button>
            }
        />
    );

    return (
        <>
            <ScreenTemplate
                contentMode="fill"
                header={
                    <PageHeader
                        title="Settings & secrets"
                        meta={
                            <>
                                {settingsQuery.data ? <span>{formatNumber(totalCount)} settings</span> : <Skeleton className="h-4 w-20" />}
                                <span aria-hidden>&middot;</span>
                                <span>secrets masked &mdash; reveal is audited</span>
                            </>
                        }
                        actions={
                            <Button onClick={() => void setSelected(CREATE_SENTINEL)}>
                                <IconPlus aria-hidden />
                                New setting
                            </Button>
                        }
                    />
                }
                footer={
                    <StatusFooter
                        start={<span>{settingsQuery.isFetching && !settingsQuery.isLoading ? 'Refreshing' : 'Up to date'}</span>}
                        end={
                            <span aria-hidden className="font-mono">
                                GET /admin/settings
                            </span>
                        }
                    />
                }
            >
                <AdminDataGrid<GlobalSetting>
                    gridId="settings"
                    aria-label="Settings"
                    columns={columns}
                    rows={rows}
                    total={totalCount}
                    groupBy={SETTING_GROUP_BY}
                    queryState={query.queryState}
                    onQueryStateChange={query.setQueryState}
                    isLoading={settingsQuery.isLoading}
                    isBusy={settingsQuery.isFetching && !settingsQuery.isLoading}
                    error={settingsQuery.error}
                    onRetry={() => settingsQuery.refetch()}
                    onRowClick={(row) => void setSelected(row.id)}
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
            </ScreenTemplate>
            {selected === CREATE_SENTINEL ? <SettingCreateDrawer onClose={() => void setSelected(null)} /> : null}
            {selected && selected !== CREATE_SENTINEL ? (
                <SettingDetailDrawer
                    key={selected}
                    settingId={selected}
                    onClose={() => void setSelected(null)}
                    onDelete={(setting) => setDeleteTarget(setting)}
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
        </>
    );
}
