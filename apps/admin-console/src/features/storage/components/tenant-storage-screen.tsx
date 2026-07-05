'use client';

import { useState, type FormEvent } from 'react';
import { IconBucket, IconBuilding, IconDatabase, IconDots, IconFilterOff, IconFolderOpen, IconTrash } from '@tabler/icons-react';
import { parseAsString, useQueryState, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
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
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { formatBytes, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
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

const PURPOSE_OPTIONS: FilterOption[] = (Object.keys(PURPOSE_LABELS) as TenantBucketPurpose[]).map((purpose) => ({
    value: purpose,
    label: PURPOSE_LABELS[purpose],
}));

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

/** Frame 14 buckets list: client-side filters over the working tenant's buckets. */
function BucketsTab({ onProvision }: { onProvision: () => void }) {
    const { data, isLoading, error, refetch } = useBuckets();
    const deleteBucket = useDeleteBucket();
    const [{ search, purpose }, setParams] = useQueryStates({
        search: parseAsString.withDefault(''),
        purpose: parseAsString.withDefault(''),
    });
    const [browsing, setBrowsing] = useState<TenantBucket | null>(null);
    const [deleting, setDeleting] = useState<TenantBucket | null>(null);

    const buckets = data ?? [];
    const rows = buckets.filter((bucket) => {
        if (purpose && bucket.purpose !== purpose) return false;
        if (!search) return true;
        const needle = search.toLowerCase();
        return bucket.name.toLowerCase().includes(needle) || bucket.slug.toLowerCase().includes(needle);
    });
    const hasFilters = Boolean(search || purpose);

    const columns: DataTableColumn<TenantBucket>[] = [
        { key: 'name', header: 'Name', cell: (row) => <span className="font-medium">{row.name}</span> },
        { key: 'slug', header: 'Slug', mono: true, cell: (row) => row.slug },
        { key: 'purpose', header: 'Purpose', cell: (row) => <Badge variant="outline">{PURPOSE_LABELS[row.purpose]}</Badge> },
        {
            key: 'type',
            header: 'Type',
            cell: (row) => <Badge variant={row.bucketType === 'SYSTEM' ? 'secondary' : 'outline'}>{row.bucketType === 'SYSTEM' ? 'System' : 'Custom'}</Badge>,
        },
        {
            key: 'quota',
            header: 'Quota',
            cell: (row) =>
                row.quotaBytes != null ? <span className="tabular-nums">{formatBytes(row.quotaBytes)}</span> : <span className="text-muted-foreground">{'\u2014'}</span>,
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
            cell: (row) => <BucketRowActions bucket={row} onBrowse={() => setBrowsing(row)} onDelete={() => setDeleting(row)} />,
        },
    ];

    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No buckets match your filters"
            description="Try a different search or clear the filters."
            action={
                <Button variant="outline" onClick={() => setParams({ search: null, purpose: null })}>
                    <IconFilterOff aria-hidden />
                    Clear filters
                </Button>
            }
        />
    ) : (
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
            <FilterBar shown={rows.length} total={buckets.length}>
                <FilterSearch
                    label="Search buckets"
                    placeholder={'Search buckets\u2026'}
                    value={search}
                    onChange={(value) => setParams({ search: value || null })}
                />
                <FilterSelect
                    id="buckets-purpose-filter"
                    label="Purpose"
                    value={purpose}
                    onChange={(value) => setParams({ purpose: value || null })}
                    options={PURPOSE_OPTIONS}
                />
            </FilterBar>
            <DataTable
                aria-label="Tenant buckets"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={isLoading}
                error={error}
                onRetry={() => refetch()}
                empty={empty}
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
 * Storage administration is tenant-scoped (matrix row 5): elevated sessions
 * must pick a working tenant first or every call 400s with "Tenant ID is
 * required". Gate before mounting any query.
 */
export function TenantStorageScreen() {
    const session = useSession();

    // Don't mount the data tabs until the scope is known — an elevated session
    // without a working tenant would fire queries that can only 400.
    if (!session.data) {
        return (
            <div className="flex flex-col gap-4">
                <PageHeader title="Tenant Storage Administration" meta={<Skeleton className="h-4 w-40" />} />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (session.data.isElevated && !session.data.workingTenantId) {
        return (
            <div className="flex flex-col gap-4">
                <PageHeader
                    title="Tenant Storage Administration"
                    meta={
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            GET /admin/tenants/storage/buckets
                        </span>
                    }
                />
                <EmptyState
                    icon={IconBuilding}
                    title="Select a working tenant"
                    description="Storage is administered per tenant. Pick a working tenant from the switcher in the top bar to load its buckets, configs and access keys."
                />
            </div>
        );
    }

    return <StorageScreenBody />;
}

function StorageScreenBody() {
    const bucketsQuery = useBuckets();
    const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('buckets'));
    const [provisionOpen, setProvisionOpen] = useState(false);

    const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'buckets';
    const buckets = bucketsQuery.data ?? [];
    const totalQuota = buckets.reduce((sum, bucket) => sum + (bucket.quotaBytes ?? 0), 0);

    return (
        <div className="flex flex-col gap-4">
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
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            GET /admin/tenants/storage/buckets
                        </span>
                    </>
                }
                actions={
                    <Button variant="outline" onClick={() => setProvisionOpen(true)}>
                        <IconDatabase aria-hidden />
                        Provision buckets
                    </Button>
                }
            />
            <Tabs value={tab} onValueChange={(next) => setTabParam(next === 'buckets' ? null : next)} className="gap-4">
                <TabsList variant="line">
                    <TabsTrigger value="buckets">Buckets</TabsTrigger>
                    <TabsTrigger value="defaults">Defaults</TabsTrigger>
                    <TabsTrigger value="configs">Configs</TabsTrigger>
                    <TabsTrigger value="keys">Access keys</TabsTrigger>
                </TabsList>
                <TabsContent value="buckets">
                    <BucketsTab onProvision={() => setProvisionOpen(true)} />
                </TabsContent>
                <TabsContent value="defaults">
                    <BucketDefaultsTab />
                </TabsContent>
                <TabsContent value="configs">
                    <StorageConfigsTab />
                </TabsContent>
                <TabsContent value="keys">
                    <AccessKeysTab />
                </TabsContent>
            </Tabs>
            <ProvisionBucketsDialog open={provisionOpen} onOpenChange={setProvisionOpen} />
        </div>
    );
}
