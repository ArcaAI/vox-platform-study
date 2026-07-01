import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Spinner } from '@arcaai/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared';
import { useApiKeys, type ApiKey, type ApiKeyWithRawKey } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Ban, Copy, KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ConfirmDelete } from '@/features/common/confirm-delete';
import { PageHeader } from '@/components/layout/page-header';
import { maskedKey, scopesSummary } from '@/features/api-keys/api-key-format';
import { formatDateTime } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/api-keys')({
    component: ApiKeysPage,
});

const KEY_TYPES = ['SDK', 'WEBHOOK', 'INTEGRATION', 'SERVICE_ACCOUNT'] as const;

function keyStatusRole(status?: string): StatusColorRole {
    switch ((status ?? '').toLowerCase()) {
        case 'active':
            return 'success';
        case 'revoked':
            return 'destructive';
        case 'expired':
            return 'warning';
        case 'inactive':
            return 'neutral';
        default:
            return 'neutral';
    }
}

function keyStatusLabel(status?: string): string {
    if (!status) return 'Unknown';
    return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

async function copyToClipboard(text: string) {
    try {
        await navigator.clipboard.writeText(text);
        toast.success('Copied to clipboard');
    } catch {
        toast.error('Copy failed — copy it manually');
    }
}

function CreateKeyDialog({ onCreate }: { onCreate: (input: { name: string; type: string; scopes?: string[]; expiresAt?: string }) => Promise<ApiKeyWithRawKey> }) {
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState('');
    const [type, setType] = useState<string>('SDK');
    const [scopes, setScopes] = useState('');
    const [expiresAt, setExpiresAt] = useState('');
    const [created, setCreated] = useState<ApiKeyWithRawKey | null>(null);

    useEffect(() => {
        if (open) {
            setName('');
            setType('SDK');
            setScopes('');
            setExpiresAt('');
            setCreated(null);
        }
    }, [open]);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;
        setSaving(true);
        try {
            const scopeList = scopes
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            const result = await onCreate({
                name: name.trim(),
                type,
                scopes: scopeList.length > 0 ? scopeList : undefined,
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
            });
            setCreated(result);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button>
                    <Plus className="size-4" />
                    New API key
                </Button>
            </DialogTrigger>
            <DialogContent>
                {created ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>Copy your API key</DialogTitle>
                            <DialogDescription>This secret is shown only once. Store it securely — you won’t be able to see it again.</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3 py-2">
                            <Alert>
                                <KeyRound className="size-4" />
                                <AlertTitle>{created.name}</AlertTitle>
                                <AlertDescription>Type: {created.type ?? type}</AlertDescription>
                            </Alert>
                            <div className="flex items-center gap-2">
                                <Input readOnly value={created.rawKey} className="font-mono text-xs" aria-label="API key secret" />
                                <Button type="button" variant="outline" size="icon" onClick={() => void copyToClipboard(created.rawKey)} aria-label="Copy API key">
                                    <Copy className="size-4" />
                                </Button>
                            </div>
                        </div>
                        <DialogFooter>
                            <Button onClick={() => setOpen(false)}>Done</Button>
                        </DialogFooter>
                    </>
                ) : (
                    <form onSubmit={submit}>
                        <DialogHeader>
                            <DialogTitle>New API key</DialogTitle>
                            <DialogDescription>Programmatic access scoped to your tenant.</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="key-name">Name</Label>
                                <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="flex flex-col gap-1.5">
                                    <Label htmlFor="key-type">Type</Label>
                                    <Select value={type} onValueChange={setType}>
                                        <SelectTrigger id="key-type">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {KEY_TYPES.map((t) => (
                                                <SelectItem key={t} value={t}>
                                                    {t}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <Label htmlFor="key-expires">Expires</Label>
                                    <Input id="key-expires" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                                </div>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="key-scopes">Scopes</Label>
                                <Input id="key-scopes" value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="comma,separated,scopes" />
                                <p className="text-xs text-muted-foreground">Optional. Leave blank for default scopes.</p>
                            </div>
                        </div>
                        <DialogFooter>
                            <DialogClose asChild>
                                <Button type="button" variant="outline">
                                    Cancel
                                </Button>
                            </DialogClose>
                            <Button type="submit" disabled={!name.trim() || saving}>
                                {saving ? <Spinner className="size-4" /> : 'Create key'}
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

/**
 * TASK-391 #23 (K5) — rotate a key. Two-phase dialog: a confirm that explains the
 * 24-hour grace window, then a reveal showing the NEW secret exactly once (the
 * old key keeps working during the window so integrations can cut over). Calls
 * the SDK `useApiKeys().rotate(id)`.
 */
function RotateKeyDialog({ apiKey, onRotate }: { apiKey: ApiKey; onRotate: (id: string) => Promise<ApiKeyWithRawKey> }) {
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [rotated, setRotated] = useState<ApiKeyWithRawKey | null>(null);

    useEffect(() => {
        if (open) {
            setSaving(false);
            setRotated(null);
        }
    }, [open]);

    const doRotate = async () => {
        setSaving(true);
        try {
            setRotated(await onRotate(apiKey.id));
        } catch {
            // onRotate surfaces the toast; keep the confirm open so the user can retry.
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" aria-label={`Rotate ${apiKey.name}`}>
                    <RotateCw className="size-4" />
                </Button>
            </DialogTrigger>
            <DialogContent>
                {rotated ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>Copy your new API key</DialogTitle>
                            <DialogDescription>
                                This secret is shown only once. The previous key keeps working for a 24-hour grace window so you can migrate integrations without downtime.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3 py-2">
                            <Alert>
                                <KeyRound className="size-4" />
                                <AlertTitle>{rotated.name ?? apiKey.name}</AlertTitle>
                                <AlertDescription>Rotated — the old key stays valid for 24 hours, then stops working.</AlertDescription>
                            </Alert>
                            <div className="flex items-center gap-2">
                                <Input readOnly value={rotated.rawKey} className="font-mono text-xs" aria-label="New API key secret" />
                                <Button type="button" variant="outline" size="icon" onClick={() => void copyToClipboard(rotated.rawKey)} aria-label="Copy new API key">
                                    <Copy className="size-4" />
                                </Button>
                            </div>
                        </div>
                        <DialogFooter>
                            <Button onClick={() => setOpen(false)}>Done</Button>
                        </DialogFooter>
                    </>
                ) : (
                    <>
                        <DialogHeader>
                            <DialogTitle>Rotate “{apiKey.name}”?</DialogTitle>
                            <DialogDescription>
                                A new secret is generated now and shown once. The current key stays valid for a 24-hour grace window, so clients can cut over before it stops working.
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                            <DialogClose asChild>
                                <Button type="button" variant="outline">
                                    Cancel
                                </Button>
                            </DialogClose>
                            <Button type="button" onClick={() => void doRotate()} disabled={saving}>
                                {saving ? <Spinner className="size-4" /> : 'Rotate key'}
                            </Button>
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

function ApiKeysPage() {
    const { apiKeys, isLoading, error, list, create, revoke, remove, rotate } = useApiKeys();

    useEffect(() => {
        void list().catch(() => undefined);
    }, [list]);

    const onCreate = async (input: { name: string; type: string; scopes?: string[]; expiresAt?: string }) => {
        try {
            const result = await create(input);
            toast.success('API key created');
            void list().catch(() => undefined);
            return result;
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create key');
            throw err;
        }
    };

    const onRevoke = async (key: ApiKey) => {
        try {
            await revoke(key.id);
            toast.success('API key revoked');
            void list().catch(() => undefined);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to revoke key');
        }
    };

    const onDelete = async (key: ApiKey) => {
        try {
            await remove(key.id);
            toast.success('API key deleted');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete key');
        }
    };

    const onRotate = async (id: string) => {
        try {
            const result = await rotate(id);
            toast.success('API key rotated — copy the new secret now');
            void list().catch(() => undefined);
            return result;
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to rotate key');
            throw err;
        }
    };

    return (
        <div>
            <PageHeader
                title="API Keys"
                description="Programmatic credentials for SDK and service access. Secrets are shown once at creation."
                actions={<CreateKeyDialog onCreate={onCreate} />}
            />
            {error ? (
                <Alert variant="destructive" className="mb-4">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Couldn’t load API keys</AlertTitle>
                    <AlertDescription>{error.message}</AlertDescription>
                </Alert>
            ) : null}
            <div className="rounded-lg border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Key</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>Scopes</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Last used</TableHead>
                            <TableHead>Expires</TableHead>
                            <TableHead className="w-32 text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {isLoading && apiKeys.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                                    Loading…
                                </TableCell>
                            </TableRow>
                        ) : apiKeys.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                                    No API keys yet.
                                </TableCell>
                            </TableRow>
                        ) : (
                            apiKeys.map((key) => {
                                const status = (key.status ?? '').toLowerCase();
                                const isRevoked = status === 'revoked';
                                // The server refuses to rotate a revoked/expired key — mirror that.
                                const canRotate = status !== 'revoked' && status !== 'expired';
                                return (
                                    <TableRow key={key.id}>
                                        <TableCell className="font-medium">{key.name}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{maskedKey(key)}</TableCell>
                                        <TableCell className="text-muted-foreground">{key.type ?? '—'}</TableCell>
                                        <TableCell className="text-muted-foreground">{scopesSummary(key.scopes)}</TableCell>
                                        <TableCell>
                                            <StatusBadge label={keyStatusLabel(key.status)} colorRole={keyStatusRole(key.status)} />
                                        </TableCell>
                                        <TableCell className="text-muted-foreground">{formatDateTime(key.lastUsedAt)}</TableCell>
                                        <TableCell className="text-muted-foreground">{formatDateTime(key.expiresAt)}</TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex justify-end gap-1">
                                                {canRotate ? (
                                                    <RotateKeyDialog apiKey={key} onRotate={onRotate} />
                                                ) : (
                                                    <span title="Revoked and expired keys cannot be rotated." className="inline-flex">
                                                        <Button variant="ghost" size="icon" className="size-8" disabled aria-label={`Rotate ${key.name} (unavailable — key is ${status})`}>
                                                            <RotateCw className="size-4" />
                                                        </Button>
                                                    </span>
                                                )}
                                                <ConfirmDelete
                                                    trigger={
                                                        <Button variant="ghost" size="icon" className="size-8" disabled={isRevoked} aria-label={`Revoke ${key.name}`}>
                                                            <Ban className="size-4" />
                                                        </Button>
                                                    }
                                                    title={`Revoke “${key.name}”?`}
                                                    description="The key stops working immediately. Existing integrations using it will fail."
                                                    confirmLabel="Revoke"
                                                    onConfirm={() => onRevoke(key)}
                                                />
                                                <ConfirmDelete
                                                    trigger={
                                                        <Button variant="ghost" size="icon" className="size-8" aria-label={`Delete ${key.name}`}>
                                                            <Trash2 className="size-4" />
                                                        </Button>
                                                    }
                                                    title={`Delete “${key.name}”?`}
                                                    description="This permanently removes the key record. This cannot be undone."
                                                    onConfirm={() => onDelete(key)}
                                                />
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })
                        )}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}
