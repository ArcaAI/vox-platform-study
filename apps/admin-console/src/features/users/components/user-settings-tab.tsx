'use client';

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { IconAdjustments, IconPencil } from '@tabler/icons-react';
import { toast } from 'sonner';
import { type ColumnDef, VirtualizedDataGrid } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { useUpdateUserSetting, useUserSettings } from '../api/hooks';
import type { UserSetting } from '../api/types';

/** Embedded detail-tab grids: no personalization, client-side only (rule #2). */
const EMBEDDED_GRID_FEATURES = {
    columnReorder: false,
    columnResize: false,
    columnPinning: false,
    columnVisibility: false,
    rowSelection: false,
    globalSearch: false,
    facetedFilters: false,
    sorting: true,
} as const;

function settingPath(setting: UserSetting): string {
    return setting.namespace ? `${setting.namespace}/${setting.key}` : setting.key;
}

/** Frame 20.1 settings tab: namespace/key/value registry with per-row edit. */
export function UserSettingsTab({ id }: { id: string }) {
    const { data, isLoading, error, refetch } = useUserSettings(id);
    const updateSetting = useUpdateUserSetting();
    const [editing, setEditing] = useState<UserSetting | null>(null);
    const [draft, setDraft] = useState('');
    const rows = data ?? [];

    const openEditor = useCallback((setting: UserSetting) => {
        setEditing(setting);
        setDraft(setting.value);
    }, []);

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        // The PATCH route is keyed by namespace + key; rows without a
        // namespace cannot be addressed and their edit button is disabled.
        if (!editing?.namespace) return;
        updateSetting.mutate(
            { id, namespace: editing.namespace, key: editing.key, body: { value: draft } },
            {
                onSuccess: () => {
                    toast.success('Setting updated');
                    setEditing(null);
                },
                onError: (mutationError) => toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not update the setting.'),
            },
        );
    }

    const columns = useMemo<ColumnDef<UserSetting>[]>(
        () => [
            {
                id: 'namespace',
                header: 'Namespace',
                enableSorting: false,
                meta: { label: 'Namespace' },
                size: 140,
                cell: ({ row }) =>
                    row.original.namespace ? <span className="font-mono text-xs">{row.original.namespace}</span> : <span className="text-muted-foreground">{'\u2014'}</span>,
            },
            {
                accessorKey: 'key',
                header: 'Key',
                meta: { label: 'Key' },
                size: 160,
                cell: ({ row }) => <span className="font-mono text-xs">{row.original.key}</span>,
            },
            {
                accessorKey: 'name',
                header: 'Name',
                meta: { label: 'Name' },
                size: 160,
                cell: ({ row }) => row.original.name,
            },
            {
                id: 'type',
                header: 'Type',
                enableSorting: false,
                meta: { label: 'Type' },
                size: 110,
                cell: ({ row }) => <Badge variant="outline">{row.original.dataType}</Badge>,
            },
            {
                id: 'value',
                header: 'Value',
                enableSorting: false,
                meta: { label: 'Value' },
                size: 220,
                cell: ({ row }) => <span className="block max-w-64 truncate font-mono text-xs">{row.original.value}</span>,
            },
            {
                accessorKey: 'updatedAt',
                header: 'Updated',
                meta: { label: 'Updated' },
                size: 150,
                cell: ({ row }) => <span className="text-muted-foreground">{formatDateTime(row.original.updatedAt)}</span>,
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
                            aria-label={`Edit ${settingPath(row.original)}`}
                            disabled={!row.original.namespace}
                            title={row.original.namespace ? undefined : 'Settings without a namespace cannot be edited here'}
                            onClick={() => openEditor(row.original)}
                        >
                            <IconPencil aria-hidden />
                        </Button>
                    </div>
                ),
            },
        ],
        [openEditor],
    );

    return (
        <div className="flex flex-col gap-3">
            <VirtualizedDataGrid<UserSetting>
                aria-label="User settings"
                columns={columns}
                data={rows}
                getRowId={(row) => row.id}
                features={EMBEDDED_GRID_FEATURES}
                height={360}
                isLoading={isLoading}
                error={error}
                onRetry={() => refetch()}
                emptyState={<EmptyState icon={IconAdjustments} title="No settings" description="This user has no stored settings yet." />}
            />
            <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Edit {editing ? settingPath(editing) : ''}</DialogTitle>
                        <DialogDescription>
                            {editing?.name} <Badge variant="outline">{editing?.dataType}</Badge>
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="edit-setting-value">Value</Label>
                            <Textarea
                                id="edit-setting-value"
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                rows={4}
                                className="resize-none font-mono"
                            />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={updateSetting.isPending}>
                                {updateSetting.isPending ? <Spinner /> : null}
                                Save
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </div>
    );
}
