'use client';

import { useState, type FormEvent } from 'react';
import { IconAlertTriangle, IconKey, IconPlus, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useAccessKeys, useCreateAccessKey, useDeleteAccessKey } from '../api/hooks';
import type { StorageAccessKey, StorageAccessKeyWithSecret } from '../api/types';

function CreateAccessKeyDialog({
    open,
    onOpenChange,
    onCreated,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: (key: StorageAccessKeyWithSecret) => void;
}) {
    const createKey = useCreateAccessKey();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');

    function handleOpenChange(next: boolean) {
        if (!next) {
            setName('');
            setDescription('');
            createKey.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        createKey.mutate(
            { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) },
            {
                onSuccess: (created) => {
                    toast.success('Access key created');
                    handleOpenChange(false);
                    onCreated(created);
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the access key.'),
            },
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Create access key</DialogTitle>
                    <DialogDescription>Scoped S3 credentials for this tenant. The secret is shown exactly once after creation.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="access-key-name">
                            Name
                            <span aria-hidden className="text-destructive">
                                *
                            </span>
                        </Label>
                        <Input id="access-key-name" value={name} onChange={(event) => setName(event.target.value)} required />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="access-key-description">Description</Label>
                        <Input id="access-key-description" value={description} onChange={(event) => setDescription(event.target.value)} />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={createKey.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!name.trim() || createKey.isPending}>
                            {createKey.isPending ? <Spinner /> : null}
                            Create key
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Shows the freshly created secret exactly once; closing discards it. */
function SecretRevealDialog({ created, onClose }: { created: StorageAccessKeyWithSecret | null; onClose: () => void }) {
    return (
        <Dialog open={created !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Access key created</DialogTitle>
                    <DialogDescription>Copy the secret before closing this dialog.</DialogDescription>
                </DialogHeader>
                {created ? (
                    <div className="flex flex-col gap-4">
                        <Alert>
                            <IconAlertTriangle aria-hidden />
                            <AlertTitle>Store this secret now {'\u2014'} it won{'\u2019'}t be shown again.</AlertTitle>
                            <AlertDescription>The gateway keeps only a hash; a lost secret means creating a new key.</AlertDescription>
                        </Alert>
                        <div className="flex flex-col gap-1">
                            <span className="text-muted-foreground text-xs font-medium">Access key ID</span>
                            <span className="flex items-center gap-1">
                                <span className="font-mono text-sm break-all">{created.accessKeyId}</span>
                                <CopyButton value={created.accessKeyId} label="Copy access key ID" />
                            </span>
                        </div>
                        <div className="flex flex-col gap-1">
                            <span className="text-muted-foreground text-xs font-medium">Secret access key</span>
                            <span className="flex items-center gap-1">
                                <span className="font-mono text-sm break-all">{created.secretAccessKey}</span>
                                <CopyButton value={created.secretAccessKey} label="Copy secret access key" />
                            </span>
                        </div>
                    </div>
                ) : null}
                <DialogFooter>
                    <Button onClick={onClose}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Frame 14 access-keys section: scoped keys list + show-once create + delete. */
export function AccessKeysTab() {
    const { data, isLoading, error, refetch } = useAccessKeys();
    const deleteKey = useDeleteAccessKey();
    const [createOpen, setCreateOpen] = useState(false);
    const [created, setCreated] = useState<StorageAccessKeyWithSecret | null>(null);
    const [deleting, setDeleting] = useState<StorageAccessKey | null>(null);

    const rows = data ?? [];

    const columns: ColumnDef<StorageAccessKey>[] = [
        {
            accessorKey: 'name',
            header: 'Name',
            meta: { label: 'Name' },
            // Single line — a stacked cell outgrows the fixed-height grid row (TASK-429).
            cell: ({ row }) => (
                <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-medium">{row.original.name}</span>
                    {row.original.description ? <span className="text-muted-foreground min-w-0 truncate text-xs">{row.original.description}</span> : null}
                </span>
            ),
        },
        {
            accessorKey: 'accessKeyId',
            header: 'Access key ID',
            meta: { label: 'Access key ID' },
            cell: ({ row }) => (
                <span className="flex items-center gap-1">
                    <span className="font-mono text-xs">{row.original.accessKeyId}</span>
                    <CopyButton value={row.original.accessKeyId} label={`Copy access key ID for ${row.original.name}`} />
                </span>
            ),
        },
        {
            id: 'permissions',
            accessorFn: (row) => row.permissions.join(', '),
            header: 'Permissions',
            meta: { label: 'Permissions' },
            cell: ({ row }) =>
                row.original.permissions.length > 0 ? row.original.permissions.join(', ') : <span className="text-muted-foreground">{'\u2014'}</span>,
        },
        {
            id: 'buckets',
            accessorFn: (row) => row.bucketIds.length,
            header: 'Buckets',
            meta: { label: 'Buckets' },
            cell: ({ row }) =>
                row.original.bucketIds.length > 0 ? `${formatNumber(row.original.bucketIds.length)} scoped` : <span className="text-muted-foreground">All</span>,
        },
        {
            accessorKey: 'expiresAt',
            header: 'Expires',
            meta: { label: 'Expires' },
            cell: ({ row }) => (row.original.expiresAt ? formatDateTime(row.original.expiresAt, 'date') : <span className="text-muted-foreground">Never</span>),
        },
        {
            accessorKey: 'lastUsedAt',
            header: 'Last used',
            meta: { label: 'Last used' },
            cell: ({ row }) => <span className="text-muted-foreground">{row.original.lastUsedAt ? formatRelativeTime(row.original.lastUsedAt) : 'Never'}</span>,
        },
        {
            accessorKey: 'createdAt',
            header: 'Created',
            meta: { label: 'Created' },
            cell: ({ row }) => <span className="text-muted-foreground">{formatDateTime(row.original.createdAt, 'date')}</span>,
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
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete access key ${row.original.name}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            setDeleting(row.original);
                        }}
                    >
                        <IconTrash aria-hidden />
                    </Button>
                </div>
            ),
        },
    ];

    function handleDeleteConfirmed() {
        if (!deleting) return;
        deleteKey.mutate(deleting.id, {
            onSuccess: () => {
                toast.success('Access key deleted');
                setDeleting(null);
            },
            onError: (mutationError) => {
                toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not delete the access key.');
                setDeleting(null);
            },
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex justify-end">
                <Button onClick={() => setCreateOpen(true)}>
                    <IconPlus aria-hidden />
                    Create access key
                </Button>
            </div>
            <VirtualizedDataGrid<StorageAccessKey>
                aria-label="Storage access keys"
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
                        icon={IconKey}
                        title="No access keys yet"
                        description="Create a scoped key for services that talk to tenant storage directly."
                        action={
                            <Button onClick={() => setCreateOpen(true)}>
                                <IconPlus aria-hidden />
                                Create access key
                            </Button>
                        }
                    />
                }
            />
            <CreateAccessKeyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={setCreated} />
            <SecretRevealDialog created={created} onClose={() => setCreated(null)} />
            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                title="Delete access key?"
                description={deleting ? `Clients authenticating with ${deleting.name} lose access immediately.` : ''}
                confirmLabel="Delete key"
                destructive
                onConfirm={handleDeleteConfirmed}
                isPending={deleteKey.isPending}
            />
        </div>
    );
}
