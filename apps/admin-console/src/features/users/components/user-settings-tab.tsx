'use client';

import { useState, type FormEvent } from 'react';
import { IconAdjustments, IconPencil } from '@tabler/icons-react';
import { toast } from 'sonner';
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
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { useUpdateUserSetting, useUserSettings } from '../api/hooks';
import type { UserSetting } from '../api/types';

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

    function openEditor(setting: UserSetting) {
        setEditing(setting);
        setDraft(setting.value);
    }

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

    const columns: DataTableColumn<UserSetting>[] = [
        {
            key: 'namespace',
            header: 'Namespace',
            mono: true,
            cell: (row) => row.namespace ?? <span className="text-muted-foreground">{'\u2014'}</span>,
        },
        { key: 'key', header: 'Key', mono: true, cell: (row) => row.key },
        { key: 'name', header: 'Name', cell: (row) => row.name },
        { key: 'type', header: 'Type', cell: (row) => <Badge variant="outline">{row.dataType}</Badge> },
        { key: 'value', header: 'Value', mono: true, cell: (row) => <span className="block max-w-64 truncate">{row.value}</span> },
        { key: 'updated', header: 'Updated', cell: (row) => <span className="text-muted-foreground">{formatDateTime(row.updatedAt)}</span> },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            className: 'w-12 text-right',
            cell: (row) => (
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${settingPath(row)}`}
                    disabled={!row.namespace}
                    title={row.namespace ? undefined : 'Settings without a namespace cannot be edited here'}
                    onClick={() => openEditor(row)}
                >
                    <IconPencil aria-hidden />
                </Button>
            ),
        },
    ];

    return (
        <div className="flex flex-col gap-3">
            <DataTable
                aria-label="User settings"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={isLoading}
                error={error}
                onRetry={() => refetch()}
                skeletonRows={3}
                empty={<EmptyState icon={IconAdjustments} title="No settings" description="This user has no stored settings yet." />}
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
