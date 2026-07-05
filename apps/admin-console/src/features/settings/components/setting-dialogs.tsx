'use client';

import { useId, useState, type FormEvent } from 'react';
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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useCreateGlobalSetting, useGlobalSetting, useUpdateGlobalSetting } from '../api/hooks';
import type { GlobalSetting } from '../api/types';

/** Prisma ValueType members (packages/database enums.prisma) — dataType options. */
const DATA_TYPES = ['String', 'Integer', 'Float', 'Double', 'Decimal', 'Boolean', 'Json', 'Date', 'DateTime', 'Array', 'Uuid', 'Binary'];

function isOccError(error: unknown): boolean {
    return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/** Type-aware value editor: Switch for Boolean, Textarea for Json/Array, Input otherwise. */
function ValueEditor({ id, dataType, value, onChange }: { id: string; dataType: string; value: string; onChange: (value: string) => void }) {
    if (dataType === 'Boolean') {
        return (
            <div className="flex items-center gap-2">
                <Switch id={id} checked={value === 'true'} onCheckedChange={(checked) => onChange(String(checked))} />
                <span className="text-muted-foreground font-mono text-xs">{value === 'true' ? 'true' : 'false'}</span>
            </div>
        );
    }
    if (dataType === 'Json' || dataType === 'Array') {
        return <Textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} rows={5} className="resize-none font-mono text-xs" />;
    }
    return <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} className="font-mono" />;
}

function EditSettingForm({
    setting,
    etag,
    onDone,
    onCancel,
    onReloadLatest,
}: {
    setting: GlobalSetting;
    etag: string;
    onDone: () => void;
    onCancel: () => void;
    onReloadLatest: () => void;
}) {
    const uid = useId();
    // Secrets serialize with an empty value — the editor starts blank and a
    // non-empty entry REPLACES the stored secret.
    const [value, setValue] = useState(setting.value);
    const updateMutation = useUpdateGlobalSetting();

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        updateMutation.mutate(
            { id: setting.id, patch: { value }, etag },
            {
                onSuccess: () => {
                    toast.success(`${setting.key} updated`);
                    onDone();
                },
                onError: (error) => {
                    // OCC conflicts render the inline alert instead.
                    if (!isOccError(error)) toast.error(error.message);
                },
            },
        );
    }

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <Label htmlFor={`${uid}-value`}>Value</Label>
                <ValueEditor id={`${uid}-value`} dataType={setting.dataType} value={value} onChange={setValue} />
                {setting.isSecret ? (
                    <p className="text-muted-foreground text-xs">
                        The current secret is never shown here. Entering a value replaces it.
                    </p>
                ) : null}
            </div>
            <OccConflictAlert
                error={updateMutation.error}
                onReload={() => {
                    updateMutation.reset();
                    onReloadLatest();
                }}
            />
            <DialogFooter>
                <Button type="button" variant="outline" disabled={updateMutation.isPending} onClick={onCancel}>
                    Cancel
                </Button>
                <Button type="submit" disabled={updateMutation.isPending || (setting.isSecret && !value)}>
                    {updateMutation.isPending ? <Spinner /> : null}
                    Save changes
                </Button>
            </DialogFooter>
        </form>
    );
}

/**
 * Per-row edit dialog (frame 24): reads `{ data, etag }` through
 * useGlobalSetting so the PATCH carries If-Match + expectedVersion; a 412
 * surfaces the OCC alert with "reload latest" (refreshes the ETag in place,
 * local edits kept).
 */
export function EditSettingDialog({ setting, onOpenChange }: { setting: GlobalSetting; onOpenChange: (open: boolean) => void }) {
    const detail = useGlobalSetting(setting.id);
    const loaded = detail.data?.data ?? null;

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>
                        Edit <span className="font-mono">{setting.key}</span>
                    </DialogTitle>
                    <DialogDescription>
                        {setting.name} &mdash; saved with optimistic concurrency (If-Match).
                    </DialogDescription>
                </DialogHeader>
                {detail.isPending ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-4 w-16" />
                        <Skeleton className="h-9 w-full" />
                    </div>
                ) : detail.error || !loaded ? (
                    <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
                ) : (
                    <EditSettingForm
                        key={loaded.id}
                        setting={loaded}
                        etag={detail.data?.etag ?? ''}
                        onDone={() => onOpenChange(false)}
                        onCancel={() => onOpenChange(false)}
                        onReloadLatest={() => void detail.refetch()}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

/** Create dialog from CreateGlobalSettingRequest — optional fields are omitted. */
export function CreateSettingDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
    const uid = useId();
    const [name, setName] = useState('');
    const [key, setKey] = useState('');
    const [value, setValue] = useState('');
    const [dataType, setDataType] = useState('String');
    const [namespace, setNamespace] = useState('');
    const [description, setDescription] = useState('');
    const createMutation = useCreateGlobalSetting();

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        createMutation.mutate(
            {
                name: name.trim(),
                key: key.trim(),
                value,
                dataType,
                ...(namespace.trim() ? { namespace: namespace.trim() } : {}),
                ...(description.trim() ? { description: description.trim() } : {}),
            },
            {
                onSuccess: () => {
                    toast.success('Setting created');
                    onOpenChange(false);
                },
                onError: (error) => toast.error(error.message),
            },
        );
    }

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>New setting</DialogTitle>
                    <DialogDescription>Platform-wide configuration row. Tenant overrides live on the tenant configs.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="flex flex-col gap-2">
                            <Label htmlFor={`${uid}-name`}>
                                Name
                                <span aria-hidden className="text-destructive">
                                    *
                                </span>
                            </Label>
                            <Input id={`${uid}-name`} value={name} onChange={(event) => setName(event.target.value)} required />
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor={`${uid}-key`}>
                                Key
                                <span aria-hidden className="text-destructive">
                                    *
                                </span>
                            </Label>
                            <Input
                                id={`${uid}-key`}
                                value={key}
                                onChange={(event) => setKey(event.target.value)}
                                required
                                className="font-mono"
                                placeholder="smtp.host"
                            />
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={`${uid}-value`}>
                            Value
                            <span aria-hidden className="text-destructive">
                                *
                            </span>
                        </Label>
                        <ValueEditor id={`${uid}-value`} dataType={dataType} value={value} onChange={setValue} />
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="flex flex-col gap-2">
                            <Label htmlFor={`${uid}-type`}>Type</Label>
                            <Select value={dataType} onValueChange={setDataType}>
                                <SelectTrigger id={`${uid}-type`} className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {DATA_TYPES.map((option) => (
                                        <SelectItem key={option} value={option}>
                                            {option}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor={`${uid}-namespace`}>Namespace</Label>
                            <Input
                                id={`${uid}-namespace`}
                                value={namespace}
                                onChange={(event) => setNamespace(event.target.value)}
                                className="font-mono"
                                placeholder="smtp"
                            />
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={`${uid}-description`}>Description</Label>
                        <Textarea
                            id={`${uid}-description`}
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            rows={2}
                            className="resize-none"
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" disabled={createMutation.isPending} onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={createMutation.isPending}>
                            {createMutation.isPending ? <Spinner /> : null}
                            Create setting
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
