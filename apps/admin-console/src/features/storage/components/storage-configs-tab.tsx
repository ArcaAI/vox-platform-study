'use client';

import { useState, type FormEvent } from 'react';
import { IconPencil, IconPlus, IconServer, IconTrash } from '@tabler/icons-react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useBuckets, useDeleteStorageConfig, useStorageConfigs, useUpsertStorageConfig } from '../api/hooks';
import type { StorageProviderType, StorageTopologyType, TenantBucket, TenantStorageConfig, UpsertStorageConfigRequest } from '../api/types';

const PROVIDER_LABELS: Record<StorageProviderType, string> = {
    MINIO: 'MinIO',
    AWS_S3: 'AWS S3',
    AZURE_BLOB: 'Azure Blob',
};

const TOPOLOGY_LABELS: Record<StorageTopologyType, string> = {
    SHARED: 'Shared',
    DEDICATED: 'Dedicated',
};

/** Radix Select reserves '', so the tenant-wide scope maps through a sentinel. */
const TENANT_WIDE = '__tenant_wide__';

interface ConfigFormValues {
    provider: StorageProviderType;
    topology: StorageTopologyType;
    bucketId: string;
    endpoint: string;
    region: string;
    forcePathStyle: boolean;
    accountName: string;
    endpointSuffix: string;
    containerPrefix: string;
    credentialsRef: string;
}

function toFormValues(config: TenantStorageConfig | null): ConfigFormValues {
    return {
        provider: config?.provider ?? 'MINIO',
        topology: config?.topology ?? 'SHARED',
        bucketId: config?.bucketId ?? TENANT_WIDE,
        endpoint: config?.endpoint ?? '',
        region: config?.region ?? '',
        forcePathStyle: config?.forcePathStyle ?? false,
        accountName: config?.accountName ?? '',
        endpointSuffix: config?.endpointSuffix ?? '',
        containerPrefix: config?.containerPrefix ?? '',
        credentialsRef: config?.credentialsRef ?? '',
    };
}

/** Optional empty fields are OMITTED so the wire payload stays minimal. */
function toRequest(values: ConfigFormValues): UpsertStorageConfigRequest {
    const isAzure = values.provider === 'AZURE_BLOB';
    return {
        provider: values.provider,
        topology: values.topology,
        bucketId: values.bucketId === TENANT_WIDE ? null : values.bucketId,
        ...(values.credentialsRef.trim() ? { credentialsRef: values.credentialsRef.trim() } : {}),
        ...(isAzure
            ? {
                  ...(values.accountName.trim() ? { accountName: values.accountName.trim() } : {}),
                  ...(values.endpointSuffix.trim() ? { endpointSuffix: values.endpointSuffix.trim() } : {}),
                  ...(values.containerPrefix.trim() ? { containerPrefix: values.containerPrefix.trim() } : {}),
              }
            : {
                  ...(values.endpoint.trim() ? { endpoint: values.endpoint.trim() } : {}),
                  ...(values.region.trim() ? { region: values.region.trim() } : {}),
                  forcePathStyle: values.forcePathStyle,
              }),
    };
}

function ConfigFormDialog({
    open,
    initial,
    buckets,
    onOpenChange,
}: {
    open: boolean;
    /** null = add mode; a row seeds edit mode (PUT upserts by scope). */
    initial: TenantStorageConfig | null;
    buckets: TenantBucket[];
    onOpenChange: (open: boolean) => void;
}) {
    const upsert = useUpsertStorageConfig();
    const [values, setValues] = useState<ConfigFormValues>(() => toFormValues(initial));
    const [seededFrom, setSeededFrom] = useState(initial?.id ?? null);

    // Re-seed when the dialog switches between rows / add mode (render-time
    // derived-state reset, not an effect).
    if ((initial?.id ?? null) !== seededFrom) {
        setSeededFrom(initial?.id ?? null);
        setValues(toFormValues(initial));
    }

    function set<K extends keyof ConfigFormValues>(key: K, value: ConfigFormValues[K]) {
        setValues((current) => ({ ...current, [key]: value }));
    }

    function handleOpenChange(next: boolean) {
        if (!next) {
            setValues(toFormValues(initial));
            upsert.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        upsert.mutate(toRequest(values), {
            onSuccess: () => {
                toast.success('Storage config saved');
                handleOpenChange(false);
            },
            onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not save the storage config.'),
        });
    }

    const isAzure = values.provider === 'AZURE_BLOB';

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{initial ? 'Edit storage config' : 'Add storage config'}</DialogTitle>
                    <DialogDescription>
                        Provider settings for this tenant {'\u2014'} scope to one bucket or leave tenant-wide. Credentials stay in Vault
                        (reference only).
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="config-provider">Provider</Label>
                            <Select value={values.provider} onValueChange={(next) => set('provider', next as StorageProviderType)}>
                                <SelectTrigger id="config-provider" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {(Object.keys(PROVIDER_LABELS) as StorageProviderType[]).map((provider) => (
                                        <SelectItem key={provider} value={provider}>
                                            {PROVIDER_LABELS[provider]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="config-topology">Topology</Label>
                            <Select value={values.topology} onValueChange={(next) => set('topology', next as StorageTopologyType)}>
                                <SelectTrigger id="config-topology" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {(Object.keys(TOPOLOGY_LABELS) as StorageTopologyType[]).map((topology) => (
                                        <SelectItem key={topology} value={topology}>
                                            {TOPOLOGY_LABELS[topology]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex flex-col gap-2 sm:col-span-2">
                            <Label htmlFor="config-scope">Scope</Label>
                            <Select value={values.bucketId} onValueChange={(next) => set('bucketId', next)}>
                                <SelectTrigger id="config-scope" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={TENANT_WIDE}>Tenant-wide (all buckets)</SelectItem>
                                    {buckets.map((bucket) => (
                                        <SelectItem key={bucket.id} value={bucket.id}>
                                            {bucket.name} ({bucket.slug})
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        {isAzure ? (
                            <>
                                <div className="flex flex-col gap-2">
                                    <Label htmlFor="config-account-name">Account name</Label>
                                    <Input
                                        id="config-account-name"
                                        value={values.accountName}
                                        onChange={(event) => set('accountName', event.target.value)}
                                        className="font-mono"
                                    />
                                </div>
                                <div className="flex flex-col gap-2">
                                    <Label htmlFor="config-endpoint-suffix">Endpoint suffix</Label>
                                    <Input
                                        id="config-endpoint-suffix"
                                        value={values.endpointSuffix}
                                        onChange={(event) => set('endpointSuffix', event.target.value)}
                                        className="font-mono"
                                        placeholder="core.windows.net"
                                    />
                                </div>
                                <div className="flex flex-col gap-2 sm:col-span-2">
                                    <Label htmlFor="config-container-prefix">Container prefix</Label>
                                    <Input
                                        id="config-container-prefix"
                                        value={values.containerPrefix}
                                        onChange={(event) => set('containerPrefix', event.target.value)}
                                        className="font-mono"
                                    />
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="flex flex-col gap-2">
                                    <Label htmlFor="config-endpoint">Endpoint</Label>
                                    <Input
                                        id="config-endpoint"
                                        value={values.endpoint}
                                        onChange={(event) => set('endpoint', event.target.value)}
                                        className="font-mono"
                                        placeholder="http://minio:9000"
                                    />
                                </div>
                                <div className="flex flex-col gap-2">
                                    <Label htmlFor="config-region">Region</Label>
                                    <Input
                                        id="config-region"
                                        value={values.region}
                                        onChange={(event) => set('region', event.target.value)}
                                        className="font-mono"
                                        placeholder="us-east-1"
                                    />
                                </div>
                                <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 sm:col-span-2">
                                    <Label htmlFor="config-force-path-style" className="font-normal">
                                        Force path-style addressing
                                    </Label>
                                    <Switch
                                        id="config-force-path-style"
                                        checked={values.forcePathStyle}
                                        onCheckedChange={(next) => set('forcePathStyle', next)}
                                    />
                                </div>
                            </>
                        )}
                        <div className="flex flex-col gap-2 sm:col-span-2">
                            <Label htmlFor="config-credentials-ref">Credentials ref</Label>
                            <Input
                                id="config-credentials-ref"
                                value={values.credentialsRef}
                                onChange={(event) => set('credentialsRef', event.target.value)}
                                className="font-mono"
                                placeholder="vault:storage/minio"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={upsert.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={upsert.isPending}>
                            {upsert.isPending ? <Spinner /> : null}
                            Save config
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Frame 14 storage-configs section: provider rows + PUT upsert + delete. */
export function StorageConfigsTab() {
    const [includeDisabled, setIncludeDisabled] = useQueryState('disabled', parseAsBoolean.withDefault(false));
    const { data, isLoading, error, refetch } = useStorageConfigs(includeDisabled || undefined);
    const bucketsQuery = useBuckets();
    const deleteConfig = useDeleteStorageConfig();
    const [formOpen, setFormOpen] = useState(false);
    const [editing, setEditing] = useState<TenantStorageConfig | null>(null);
    const [deleting, setDeleting] = useState<TenantStorageConfig | null>(null);

    const rows = data ?? [];
    const buckets = bucketsQuery.data ?? [];

    function scopeLabel(config: TenantStorageConfig): string {
        if (!config.bucketId) return 'Tenant-wide';
        const bucket = buckets.find((candidate) => candidate.id === config.bucketId);
        return bucket ? `${bucket.name} (${bucket.slug})` : config.bucketId;
    }

    const columns: ColumnDef<TenantStorageConfig>[] = [
        {
            accessorKey: 'provider',
            header: 'Provider',
            meta: { label: 'Provider' },
            cell: ({ row }) => <span className="font-medium">{PROVIDER_LABELS[row.original.provider]}</span>,
        },
        { accessorKey: 'topology', header: 'Topology', meta: { label: 'Topology' }, cell: ({ row }) => TOPOLOGY_LABELS[row.original.topology] },
        {
            id: 'scope',
            accessorFn: (row) => (row.bucketId ? scopeLabel(row) : 'Tenant-wide'),
            header: 'Scope',
            meta: { label: 'Scope' },
            cell: ({ row }) => (row.original.bucketId ? scopeLabel(row.original) : <span className="text-muted-foreground">Tenant-wide</span>),
        },
        {
            id: 'endpoint',
            accessorFn: (row) => row.endpoint ?? row.accountName ?? '',
            header: 'Endpoint',
            meta: { label: 'Endpoint' },
            cell: ({ row }) => (
                <span className="font-mono text-xs">{row.original.endpoint ?? row.original.accountName ?? <span className="text-muted-foreground">{'\u2014'}</span>}</span>
            ),
        },
        {
            accessorKey: 'credentialsRef',
            header: 'Credentials ref',
            meta: { label: 'Credentials ref' },
            cell: ({ row }) => <span className="font-mono text-xs">{row.original.credentialsRef ?? <span className="text-muted-foreground">{'\u2014'}</span>}</span>,
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
            size: 88,
            minSize: 88,
            cell: ({ row }) => (
                <span className="flex w-full justify-end gap-1">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit config ${PROVIDER_LABELS[row.original.provider]}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            setEditing(row.original);
                            setFormOpen(true);
                        }}
                    >
                        <IconPencil aria-hidden />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete config ${PROVIDER_LABELS[row.original.provider]}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            setDeleting(row.original);
                        }}
                    >
                        <IconTrash aria-hidden />
                    </Button>
                </span>
            ),
        },
    ];

    function handleDeleteConfirmed() {
        if (!deleting) return;
        deleteConfig.mutate(deleting.id, {
            onSuccess: () => {
                toast.success('Storage config deleted');
                setDeleting(null);
            },
            onError: (mutationError) => {
                toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not delete the storage config.');
                setDeleting(null);
            },
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <Switch
                        id="configs-show-disabled"
                        checked={includeDisabled}
                        onCheckedChange={(next) => setIncludeDisabled(next || null)}
                    />
                    <Label htmlFor="configs-show-disabled" className="font-normal">
                        Show disabled
                    </Label>
                </div>
                <Button
                    onClick={() => {
                        setEditing(null);
                        setFormOpen(true);
                    }}
                >
                    <IconPlus aria-hidden />
                    Add config
                </Button>
            </div>
            <VirtualizedDataGrid<TenantStorageConfig>
                aria-label="Storage configs"
                columns={columns}
                data={rows}
                getRowId={(row) => row.id}
                height={360}
                features={{
                    columnReorder: false,
                    columnResize: false,
                    columnPinning: false,
                    columnVisibility: false,
                    rowSelection: false,
                    globalSearch: false,
                    facetedFilters: false,
                    sorting: true,
                }}
                isLoading={isLoading}
                error={error}
                onRetry={() => refetch()}
                errorState={(err) => <ErrorState error={err} onRetry={() => refetch()} />}
                emptyState={
                    <EmptyState
                        icon={IconServer}
                        title="No storage configs yet"
                        description="The tenant uses the platform default provider until a config is added."
                    />
                }
            />
            <ConfigFormDialog open={formOpen} initial={editing} buckets={buckets} onOpenChange={setFormOpen} />
            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                title="Delete storage config?"
                description={
                    deleting
                        ? `${PROVIDER_LABELS[deleting.provider]} (${deleting.bucketId ? 'bucket-scoped' : 'tenant-wide'}) is removed and affected buckets fall back to the platform default provider.`
                        : ''
                }
                confirmLabel="Delete config"
                destructive
                onConfirm={handleDeleteConfirmed}
                isPending={deleteConfig.isPending}
            />
        </div>
    );
}
