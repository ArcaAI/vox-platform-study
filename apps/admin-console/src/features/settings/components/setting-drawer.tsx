'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconEye, IconEyeOff, IconRefreshDot, IconTrash } from '@tabler/icons-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { RequirePermission } from '@/shared/auth/require-permission';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatRelativeTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useCreateGlobalSetting, useGlobalSetting, useRevealGlobalSetting, useRotateGlobalSetting, useUpdateGlobalSetting } from '../api/hooks';
import type { GlobalSetting } from '../api/types';
import { SettingHistoryTab } from './setting-history-tab';
import { isJsonType, isValueValid, ValueEditorPane } from './value-editor-pane';

/** Prisma ValueType members (packages/database enums.prisma) — dataType options. */
const DATA_TYPES = ['String', 'Integer', 'Float', 'Double', 'Decimal', 'Boolean', 'Json', 'Date', 'DateTime', 'Array', 'Uuid', 'Binary'];
const MASK = '••••••••';

function isOccError(error: unknown): boolean {
    return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/**
 * Step-up reveal (frame 24 matrix): the caller re-enters their password; every
 * reveal is audit-logged server-side. A short break-glass confirmation, so it
 * stays a Dialog per the UX rules (dialogs remain for step-up).
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
 * Server-side rotation (TASK-445): POST :id/rotate — an atomic, audited,
 * step-up-gated replace of the secret under OCC (If-Match from the drawer's
 * read ETag). Collects the replacement value + the caller's password; errors
 * surface in-dialog per the house break-glass style. The response is the
 * masked setting — the plaintext never reaches the client.
 */
function RotateSecretDialog({
    setting,
    etag,
    onOpenChange,
}: {
    setting: GlobalSetting;
    etag: string;
    onOpenChange: (open: boolean) => void;
}) {
    const uid = useId();
    const [newValue, setNewValue] = useState('');
    const [password, setPassword] = useState('');
    const rotateMutation = useRotateGlobalSetting();

    const errorMessage = rotateMutation.error
        ? isOccError(rotateMutation.error)
            ? 'This setting changed since you loaded it. Close the drawer to reload the latest version, then rotate again.'
            : rotateMutation.error.message
        : null;

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        rotateMutation.mutate(
            { id: setting.id, body: { password, newValue }, etag },
            {
                onSuccess: () => {
                    toast.success(`${setting.key} rotated`);
                    onOpenChange(false);
                },
            },
        );
    }

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Rotate secret</DialogTitle>
                    <DialogDescription>
                        Atomically replaces <span className="font-mono">{setting.key}</span> with a new value; the old secret stops working
                        immediately. Every rotation is audit-logged.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={`${uid}-new`}>New secret value</Label>
                        <Input
                            id={`${uid}-new`}
                            type="text"
                            autoComplete="off"
                            className="font-mono"
                            value={newValue}
                            onChange={(event) => setNewValue(event.target.value)}
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={`${uid}-password`}>Password</Label>
                        <Input
                            id={`${uid}-password`}
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                        />
                    </div>
                    {errorMessage ? (
                        <p role="alert" className="text-destructive text-sm">
                            {errorMessage}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="outline" disabled={rotateMutation.isPending} onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={rotateMutation.isPending || !password || !newValue}>
                            {rotateMutation.isPending ? <Spinner /> : null}
                            Rotate secret
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Header badges shared by the detail drawer: type + secret + locked. */
function SettingBadges({ setting }: { setting: GlobalSetting }) {
    return (
        <>
            <Badge variant="outline">{setting.dataType}</Badge>
            {setting.isSecret ? <Badge variant="secondary">Secret</Badge> : null}
            {setting.locked ? <Badge variant="outline">Locked</Badge> : null}
        </>
    );
}

/** Meta line under the header: namespace · scope · version · updated. */
function SettingMeta({ setting }: { setting: GlobalSetting }) {
    return (
        <>
            <span>{setting.namespace || 'no namespace'}</span>
            <span aria-hidden>&middot;</span>
            <span>{setting.tenantId ? 'Tenant-scoped' : 'Global'}</span>
            <span aria-hidden>&middot;</span>
            <span className="font-mono">v{setting.version}</span>
            <span aria-hidden>&middot;</span>
            <span>updated {formatRelativeTime(setting.updatedAt)}</span>
        </>
    );
}

/** The secret Value pane: reveal current value (audited) + a write-only replace field + server-side Rotate (TASK-445). */
function SecretValuePane({
    setting,
    newValue,
    onNewValueChange,
    onRotate,
}: {
    setting: GlobalSetting;
    newValue: string;
    onNewValueChange: (value: string) => void;
    onRotate: () => void;
}) {
    const uid = useId();
    const [revealTarget, setRevealTarget] = useState<GlobalSetting | null>(null);
    const [revealed, setRevealed] = useState<string | null>(null);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
                <span className="text-muted-foreground text-xs font-medium">Current value</span>
                {revealed !== null ? (
                    <div className="flex items-center gap-1">
                        <span className="min-w-0 truncate font-mono text-sm">{revealed}</span>
                        <CopyButton value={revealed} label={`Copy ${setting.key}`} />
                        <Button variant="ghost" size="icon-sm" aria-label={`Hide ${setting.key}`} onClick={() => setRevealed(null)}>
                            <IconEyeOff aria-hidden />
                        </Button>
                    </div>
                ) : (
                    <div className="flex items-center gap-1">
                        <span aria-hidden className="tracking-wider">
                            {MASK}
                        </span>
                        <span className="sr-only">Secret value hidden</span>
                        {/* Reveal and rotate are global-admin only per the frame 24 matrix. */}
                        <RequirePermission action="manage" subject="all">
                            <Button variant="ghost" size="icon-sm" aria-label={`Reveal ${setting.key}`} onClick={() => setRevealTarget(setting)}>
                                <IconEye aria-hidden />
                            </Button>
                            {/* TASK-445 — opens the audited server-side rotation dialog (no longer a guided replace). */}
                            <Button variant="ghost" size="sm" onClick={onRotate}>
                                <IconRefreshDot aria-hidden />
                                Rotate
                            </Button>
                        </RequirePermission>
                    </div>
                )}
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor={`${uid}-new`}>New value</Label>
                <Input
                    id={`${uid}-new`}
                    type="text"
                    autoComplete="off"
                    value={newValue}
                    onChange={(event) => onNewValueChange(event.target.value)}
                    className="font-mono"
                    placeholder="Enter a new value to replace the secret"
                />
                <p className="text-muted-foreground text-xs">The current secret is never shown here. Entering a value replaces it on save.</p>
            </div>
            {revealTarget ? (
                <RevealSecretDialog
                    setting={revealTarget}
                    onOpenChange={(open) => {
                        if (!open) setRevealTarget(null);
                    }}
                    onRevealed={(value) => {
                        setRevealed(value);
                        setRevealTarget(null);
                    }}
                />
            ) : null}
        </div>
    );
}

/** The loaded body of the detail drawer — value editing with OCC + tabs. */
function SettingDetailBody({
    setting,
    etag,
    onDone,
    onReloadLatest,
    onDelete,
    onClose,
}: {
    setting: GlobalSetting;
    etag: string;
    onDone: () => void;
    onReloadLatest: () => void;
    onDelete: () => void;
    onClose: () => void;
}) {
    const uid = useId();
    const [tab, setTab] = useState('value');
    const [value, setValue] = useState(setting.value);
    const [newValue, setNewValue] = useState('');
    const [rotateOpen, setRotateOpen] = useState(false);
    const updateMutation = useUpdateGlobalSetting();

    const jsonInvalid = !setting.isSecret && isJsonType(setting.dataType) && !isValueValid(setting.dataType, value);
    const dirty = setting.isSecret ? newValue.length > 0 : value !== setting.value;
    const saveDisabled = updateMutation.isPending || !dirty || jsonInvalid || (setting.isSecret && !newValue) || setting.locked;

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        updateMutation.mutate(
            { id: setting.id, patch: { value: setting.isSecret ? newValue : value }, etag },
            {
                onSuccess: () => {
                    toast.success(`${setting.key} updated`);
                    onDone();
                },
                onError: (error) => {
                    if (!isOccError(error)) toast.error(error.message);
                },
            },
        );
    }

    return (
        <Tabs value={tab} onValueChange={setTab} className="contents">
            <DetailDrawer
                open
                onOpenChange={(open) => {
                    if (!open) onClose();
                }}
                size="lg"
                title={<span className="font-mono">{setting.key}</span>}
                badges={<SettingBadges setting={setting} />}
                meta={<SettingMeta setting={setting} />}
                tabs={
                    <TabsList variant="line" className="mt-1">
                        <TabsTrigger value="value">Value</TabsTrigger>
                        <TabsTrigger value="details">Details</TabsTrigger>
                        <TabsTrigger value="history">History</TabsTrigger>
                    </TabsList>
                }
                footer={
                    <form id={`${uid}-form`} onSubmit={handleSubmit} className="flex w-full items-center justify-between gap-2">
                        <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={onDelete}>
                            <IconTrash aria-hidden />
                            Delete
                        </Button>
                        <div className="flex items-center gap-2">
                            <Button type="button" variant="outline" disabled={updateMutation.isPending} onClick={onClose}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={saveDisabled}>
                                {updateMutation.isPending ? <Spinner /> : null}
                                Save changes
                            </Button>
                        </div>
                    </form>
                }
            >
                <TabsContent value="value" className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        {setting.isSecret ? (
                            <SecretValuePane
                                setting={setting}
                                newValue={newValue}
                                onNewValueChange={setNewValue}
                                onRotate={() => setRotateOpen(true)}
                            />
                        ) : (
                            <>
                                <Label htmlFor={`${uid}-value`}>Value</Label>
                                <ValueEditorPane
                                    id={`${uid}-value`}
                                    ariaLabel="Value"
                                    dataType={setting.dataType}
                                    value={value}
                                    onChange={setValue}
                                    disabled={setting.locked}
                                />
                            </>
                        )}
                        {setting.locked ? (
                            <p className="text-muted-foreground text-xs">This platform default is locked. Only a global admin may change it.</p>
                        ) : null}
                    </div>
                    <OccConflictAlert
                        error={updateMutation.error}
                        onReload={() => {
                            updateMutation.reset();
                            onReloadLatest();
                        }}
                    />
                </TabsContent>
                <TabsContent value="details" className="flex flex-col gap-3 text-sm">
                    <MetaRow label="Name">{setting.name}</MetaRow>
                    {setting.description ? <MetaRow label="Description">{setting.description}</MetaRow> : null}
                    <MetaRow label="Key">
                        <span className="font-mono">{setting.key}</span>
                    </MetaRow>
                    <MetaRow label="Namespace">{setting.namespace || '—'}</MetaRow>
                    <MetaRow label="Type">{setting.dataType}</MetaRow>
                    <MetaRow label="Version">
                        <span className="font-mono">v{setting.version}</span>
                    </MetaRow>
                </TabsContent>
                <TabsContent value="history">
                    <SettingHistoryTab settingId={setting.id} active={tab === 'history'} />
                </TabsContent>
                {/* TASK-445 — server-side rotation; on success the settings caches
                    invalidate so the drawer picks up the new version/ETag in place. */}
                {rotateOpen ? (
                    <RotateSecretDialog
                        setting={setting}
                        etag={etag}
                        onOpenChange={(open) => {
                            if (!open) setRotateOpen(false);
                        }}
                    />
                ) : null}
            </DetailDrawer>
        </Tabs>
    );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground text-xs">{label}</span>
            <span className="min-w-0 truncate text-right">{children}</span>
        </div>
    );
}

/**
 * Detail/edit drawer (TASK-439): reads `{ data, etag }` through useGlobalSetting
 * so the PATCH carries If-Match + expectedVersion; a 412 surfaces the OCC alert
 * with "reload latest" (refreshes the ETag in place, local edits kept). Replaces
 * the retired EditSettingDialog.
 */
export function SettingDetailDrawer({ settingId, onClose, onDelete }: { settingId: string; onClose: () => void; onDelete: (setting: GlobalSetting) => void }) {
    const detail = useGlobalSetting(settingId);
    const loaded = detail.data?.data ?? null;

    if (detail.isPending) return null;

    if (detail.error || !loaded) {
        return (
            <DetailDrawer
                open
                onOpenChange={(open) => {
                    if (!open) onClose();
                }}
                size="lg"
                title={<span className="font-mono">Setting</span>}
            >
                {detail.error ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : (
                    <div className="flex flex-col gap-3">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-24 w-full" />
                    </div>
                )}
            </DetailDrawer>
        );
    }

    return (
        <SettingDetailBody
            key={loaded.id}
            setting={loaded}
            etag={detail.data?.etag ?? ''}
            onDone={onClose}
            onClose={onClose}
            onReloadLatest={() => void detail.refetch()}
            onDelete={() => onDelete(loaded)}
        />
    );
}

/**
 * Create drawer (TASK-439): the "New setting" surface, replacing the retired
 * CreateSettingDialog. Value tab carries the type-aware editor; Details tab
 * carries name/key/namespace/description.
 */
export function SettingCreateDrawer({ onClose }: { onClose: () => void }) {
    const uid = useId();
    const [tab, setTab] = useState('value');
    const [name, setName] = useState('');
    const [key, setKey] = useState('');
    const [value, setValue] = useState('');
    const [dataType, setDataType] = useState('String');
    const [namespace, setNamespace] = useState('');
    const [description, setDescription] = useState('');
    const createMutation = useCreateGlobalSetting();

    const jsonInvalid = isJsonType(dataType) && !isValueValid(dataType, value);
    const createDisabled = createMutation.isPending || !name.trim() || !key.trim() || jsonInvalid;

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
                    onClose();
                },
                onError: (error) => toast.error(error.message),
            },
        );
    }

    return (
        <Tabs value={tab} onValueChange={setTab} className="contents">
            <DetailDrawer
                open
                onOpenChange={(open) => {
                    if (!open) onClose();
                }}
                size="lg"
                title="New setting"
                tabs={
                    <TabsList variant="line" className="mt-1">
                        <TabsTrigger value="value">Value</TabsTrigger>
                        <TabsTrigger value="details">Details</TabsTrigger>
                    </TabsList>
                }
                footer={
                    <div className="flex w-full items-center justify-end gap-2">
                        <Button type="button" variant="outline" disabled={createMutation.isPending} onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" form={`${uid}-form`} disabled={createDisabled}>
                            {createMutation.isPending ? <Spinner /> : null}
                            Create setting
                        </Button>
                    </div>
                }
            >
                <form id={`${uid}-form`} onSubmit={handleSubmit} className="contents">
                    <TabsContent value="value" className="flex flex-col gap-4">
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
                            <Label htmlFor={`${uid}-value`}>Value</Label>
                            <ValueEditorPane id={`${uid}-value`} ariaLabel="Value" dataType={dataType} value={value} onChange={setValue} />
                        </div>
                    </TabsContent>
                    <TabsContent value="details" className="flex flex-col gap-4">
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
                            <Input id={`${uid}-key`} value={key} onChange={(event) => setKey(event.target.value)} required className="font-mono" placeholder="smtp.host" />
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor={`${uid}-namespace`}>Namespace</Label>
                            <Input id={`${uid}-namespace`} value={namespace} onChange={(event) => setNamespace(event.target.value)} className="font-mono" placeholder="smtp" />
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor={`${uid}-description`}>Description</Label>
                            <Textarea id={`${uid}-description`} value={description} onChange={(event) => setDescription(event.target.value)} rows={2} className="resize-none" />
                        </div>
                    </TabsContent>
                </form>
            </DetailDrawer>
        </Tabs>
    );
}
