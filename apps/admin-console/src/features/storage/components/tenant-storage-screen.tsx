'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { IconBucket, IconBuilding, IconDatabase, IconDots, IconFilterOff, IconFolderOpen, IconTrash } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth';
import { useTenantCatalog, useTenantNames } from '@/shared/catalog';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import type { FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { NameWithId } from '@/shared/data/name-with-id';
import { formatBytes, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useBuckets, useDeleteBucket, useProvisionTenantBuckets } from '../api/hooks';
import type { TenantBucket, TenantBucketPurpose } from '../api/types';
import { AccessKeysTab } from './access-keys-tab';
import { BucketBrowserSheet } from './bucket-browser-sheet';
import { BucketDefaultsTab } from './bucket-defaults-tab';
import { StorageConfigsTab } from './storage-configs-tab';

const TAB_VALUES = ['buckets', 'defaults', 'configs', 'keys'] as const;

const PURPOSE_LABELS: Record<TenantBucketPurpose, string> = {
    AUDIO: 'Audio',
    ATTACHMENTS: 'Attachments',
    MISC: 'Misc',
    CUSTOM: 'Custom',
};

const PURPOSE_OPTIONS: FilterOption[] = Object.entries(PURPOSE_LABELS).map(([value, label]) => ({ value, label }));

const TYPE_OPTIONS: FilterOption[] = [
    { value: 'SYSTEM', label: 'System' },
    { value: 'CUSTOM', label: 'Custom' },
];

function BucketRowActions({ bucket, onBrowse, onDelete }: { bucket: TenantBucket; onBrowse: () => void; onDelete: () => void }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Open actions for ${bucket.name}`} onClick={(event) => event.stopPropagation()}>
                    <IconDots aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            {/* The portal content still bubbles through the React tree to the row's onClick. */}
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                <DropdownMenuItem onSelect={onBrowse}>
                    <IconFolderOpen aria-hidden />
                    Browse objects
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                    <IconTrash aria-hidden />
                    Delete
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * Frame 14 buckets list: embedded grid (client search + faceted filters).
 * TASK-430 — spans all tenants for an unscoped elevated session, so the grid
 * carries a Tenant column and tenant/purpose/type filters.
 */
function BucketsTab({ onProvision }: { onProvision: () => void }) {
    const { data, isLoading, error, refetch } = useBuckets();
    const deleteBucket = useDeleteBucket();
    const [browsing, setBrowsing] = useState<TenantBucket | null>(null);
    const [deleting, setDeleting] = useState<TenantBucket | null>(null);

    const tenantNames = useTenantNames();
    const tenantCatalog = useTenantCatalog();
    const tenantOptions = useMemo<FilterOption[]>(
        () => (tenantCatalog.data ?? []).map((tenant) => ({ value: tenant.id, label: tenant.name || tenant.key || tenant.id })),
        [tenantCatalog.data],
    );

    const buckets = data ?? [];

    const columns: ColumnDef<TenantBucket>[] = [
        { accessorKey: 'name', header: 'Name', meta: { label: 'Name' }, cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
        { accessorKey: 'slug', header: 'Slug', meta: { label: 'Slug' }, cell: ({ row }) => <span className="font-mono text-xs">{row.original.slug}</span> },
        {
            accessorKey: 'tenantId',
            header: 'Tenant',
            enableSorting: false,
            filterFn: 'equalsString',
            meta: { label: 'Tenant', variant: 'select', options: tenantOptions },
            size: 180,
            cell: ({ row }) => <NameWithId name={tenantNames.get(row.original.tenantId)} id={row.original.tenantId} />,
        },
        {
            accessorKey: 'purpose',
            header: 'Purpose',
            filterFn: 'equalsString',
            meta: { label: 'Purpose', variant: 'select', options: PURPOSE_OPTIONS },
            cell: ({ row }) => <Badge variant="outline">{PURPOSE_LABELS[row.original.purpose]}</Badge>,
        },
        {
            id: 'type',
            accessorFn: (row) => row.bucketType,
            header: 'Type',
            filterFn: 'equalsString',
            meta: { label: 'Type', variant: 'select', options: TYPE_OPTIONS },
            cell: ({ row }) => (
                <Badge variant={row.original.bucketType === 'SYSTEM' ? 'secondary' : 'outline'}>{row.original.bucketType === 'SYSTEM' ? 'System' : 'Custom'}</Badge>
            ),
        },
        {
            accessorKey: 'quotaBytes',
            header: 'Quota',
            meta: { label: 'Quota' },
            cell: ({ row }) =>
                row.original.quotaBytes != null ? (
                    <span className="tabular-nums">{formatBytes(row.original.quotaBytes)}</span>
                ) : (
                    <span className="text-muted-foreground">{'\u2014'}</span>
                ),
        },
        { accessorKey: 'resourceStatus', header: 'Status', meta: { label: 'Status' }, cell: ({ row }) => <ResourceStatusBadge status={row.original.resourceStatus} /> },
        {
            accessorKey: 'updatedAt',
            header: 'Updated',
            meta: { label: 'Updated' },
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
                <div className="flex w-full justify-end">
                    <BucketRowActions bucket={row.original} onBrowse={() => setBrowsing(row.original)} onDelete={() => setDeleting(row.original)} />
                </div>
            ),
        },
    ];

    // No buckets at all → provision CTA; buckets exist but the search hides them → filtered-empty.
    const emptyState =
        buckets.length === 0 ? (
            <EmptyState
                icon={IconBucket}
                title="No buckets provisioned yet"
                description="Buckets are created automatically on first upload, or provision the standard set for a tenant."
                action={
                    <Button onClick={onProvision}>
                        <IconDatabase aria-hidden />
                        Provision buckets
                    </Button>
                }
            />
        ) : (
            <EmptyState icon={IconFilterOff} title="No buckets match your filters" description="Try a different search term or clear the active filters." />
        );

    function handleDeleteConfirmed() {
        if (!deleting) return;
        deleteBucket.mutate(deleting.id, {
            onSuccess: () => {
                toast.success('Bucket deleted');
                setDeleting(null);
            },
            onError: (mutationError) => {
                toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not delete the bucket.');
                setDeleting(null);
            },
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <VirtualizedDataGrid<TenantBucket>
                aria-label="Tenant buckets"
                columns={columns}
                data={buckets}
                getRowId={(row) => row.id}
                height={360}
                persistence={gridPersistence('tenant-storage-buckets')}
                features={{
                    columnReorder: true,
                    columnResize: true,
                    columnPinning: true,
                    columnVisibility: true,
                    rowSelection: false,
                    globalSearch: true,
                    facetedFilters: true,
                    sorting: true,
                }}
                isLoading={isLoading}
                error={error}
                onRetry={() => refetch()}
                errorState={(err) => <ErrorState error={err} onRetry={() => refetch()} />}
                emptyState={emptyState}
                onRowClick={(row) => setBrowsing(row)}
            />
            <BucketBrowserSheet bucket={browsing} onOpenChange={(open) => !open && setBrowsing(null)} />
            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                title="Delete bucket?"
                description={
                    deleting ? `This permanently deletes ${deleting.name} and its contents become unreachable. This cannot be undone.` : ''
                }
                confirmLabel="Delete bucket"
                destructive
                typeToConfirm={deleting?.slug}
                onConfirm={handleDeleteConfirmed}
                isPending={deleteBucket.isPending}
            />
        </div>
    );
}

/** Provisions the standard system buckets for an explicit tenant id. */
function ProvisionBucketsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const provision = useProvisionTenantBuckets();
    const [tenantId, setTenantId] = useState('');

    function handleOpenChange(next: boolean) {
        if (!next) {
            setTenantId('');
            provision.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        provision.mutate(tenantId.trim(), {
            onSuccess: (buckets) => {
                toast.success(`${formatNumber(buckets.length)} buckets provisioned`);
                handleOpenChange(false);
            },
            onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not provision the buckets.'),
        });
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Provision tenant buckets</DialogTitle>
                    <DialogDescription>
                        Creates the standard system buckets (audio, attachments, misc) for the tenant if they are missing. Existing buckets
                        are left untouched.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="provision-tenant-id">
                            Tenant ID
                            <span aria-hidden className="text-destructive">
                                *
                            </span>
                        </Label>
                        <Input
                            id="provision-tenant-id"
                            value={tenantId}
                            onChange={(event) => setTenantId(event.target.value)}
                            placeholder="Tenant UUID from the Tenants list"
                            className="font-mono"
                            required
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={provision.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!tenantId.trim() || provision.isPending}>
                            {provision.isPending ? <Spinner /> : null}
                            Provision
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Frame 14 — Tenant storage administration: buckets, defaults, configs, keys. */
/**
 * TASK-430 — the buckets list works CROSS-TENANT for an unscoped elevated
 * session (GLOBAL_ADMIN with no working tenant): the backend returns every
 * tenant's buckets and the grid shows a Tenant column + filter. Defaults,
 * configs and access keys remain per-tenant wiring, so those tabs still ask
 * for a working tenant when the session is unscoped.
 */
export function TenantStorageScreen() {
    const session = useSession();

    // Don't mount the data tabs until the scope is known.
    if (!session.data) {
        return (
            <div className="flex flex-col gap-4">
                <PageHeader title="Tenant Storage Administration" meta={<Skeleton className="h-4 w-40" />} />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    const scoped = !session.data.isElevated || Boolean(session.data.workingTenantId);
    return <StorageScreenBody scoped={scoped} />;
}

/** Per-tenant tabs (defaults / configs / keys) still need a working tenant. */
function PickTenantState() {
    return (
        <EmptyState
            icon={IconBuilding}
            title="Select a working tenant"
            description="This section is administered per tenant. Pick a working tenant from the switcher in the top bar to load it."
        />
    );
}

function StorageScreenBody({ scoped }: { scoped: boolean }) {
    const bucketsQuery = useBuckets();
    const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('buckets'));
    const [provisionOpen, setProvisionOpen] = useState(false);

    const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'buckets';
    const buckets = bucketsQuery.data ?? [];
    const totalQuota = buckets.reduce((sum, bucket) => sum + (bucket.quotaBytes ?? 0), 0);

    return (
        <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => setTabParam(next === 'buckets' ? null : next)}>
            <ScreenTemplate
                header={
                    <PageHeader
                        title="Tenant Storage Administration"
                        meta={
                            <>
                                {bucketsQuery.data ? (
                                    <span>
                                        {formatNumber(buckets.length)} buckets {'\u00b7'} {formatBytes(totalQuota)} quota
                                    </span>
                                ) : (
                                    <Skeleton className="h-4 w-40" />
                                )}
                            </>
                        }
                        actions={
                            <Button variant="outline" onClick={() => setProvisionOpen(true)}>
                                <IconDatabase aria-hidden />
                                Provision buckets
                            </Button>
                        }
                    />
                }
                tabs={
                    <TabsList variant="line">
                        <TabsTrigger value="buckets">Buckets</TabsTrigger>
                        <TabsTrigger value="defaults">Defaults</TabsTrigger>
                        <TabsTrigger value="configs">Configs</TabsTrigger>
                        <TabsTrigger value="keys">Access keys</TabsTrigger>
                    </TabsList>
                }
                footer={
                    <StatusFooter
                        end={
                            <span aria-hidden className="font-mono">
                                GET /admin/tenants/storage/buckets
                            </span>
                        }
                    />
                }
            >
                <TabsContent value="buckets">
                    <BucketsTab onProvision={() => setProvisionOpen(true)} />
                </TabsContent>
                <TabsContent value="defaults">{scoped ? <BucketDefaultsTab /> : <PickTenantState />}</TabsContent>
                <TabsContent value="configs">{scoped ? <StorageConfigsTab /> : <PickTenantState />}</TabsContent>
                <TabsContent value="keys">{scoped ? <AccessKeysTab /> : <PickTenantState />}</TabsContent>
            </ScreenTemplate>
            <ProvisionBucketsDialog open={provisionOpen} onOpenChange={setProvisionOpen} />
        </Tabs>
    );
}
