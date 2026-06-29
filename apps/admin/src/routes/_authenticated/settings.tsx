import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Spinner } from '@arcaai/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Textarea } from '@arcaai/ui/textarea';
import { ConfigConflictError, useGlobalSettings, useUserSettings, type GlobalSetting } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ConfirmDelete } from '@/features/common/confirm-delete';
import { PageHeader } from '@/components/layout/page-header';

export const Route = createFileRoute('/_authenticated/settings')({
    component: SettingsPage,
});

const DATA_TYPES = ['String', 'Integer', 'Float', 'Boolean', 'Json', 'DateTime'] as const;

function parseValue(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) return '';
    try {
        return JSON.parse(trimmed);
    } catch {
        return text;
    }
}

function previewValue(value: unknown): string {
    if (value == null) return '—';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function editableValue(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

// ── Global settings ────────────────────────────────────────────────────────────

function GlobalCreateDialog({ onCreate }: { onCreate: (input: { key: string; value: unknown; dataType?: string; namespace?: string }) => Promise<void> }) {
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [key, setKey] = useState('');
    const [namespace, setNamespace] = useState('');
    const [dataType, setDataType] = useState<string>('String');
    const [value, setValue] = useState('');

    useEffect(() => {
        if (open) {
            setKey('');
            setNamespace('');
            setDataType('String');
            setValue('');
        }
    }, [open]);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!key.trim()) return;
        setSaving(true);
        try {
            await onCreate({ key: key.trim(), value: parseValue(value), dataType, namespace: namespace.trim() || undefined });
            setOpen(false);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button>
                    <Plus className="size-4" />
                    New setting
                </Button>
            </DialogTrigger>
            <DialogContent>
                <form onSubmit={submit}>
                    <DialogHeader>
                        <DialogTitle>New global setting</DialogTitle>
                        <DialogDescription>Platform configuration. JSON values are parsed automatically.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="setting-key">Key</Label>
                                <Input id="setting-key" value={key} onChange={(e) => setKey(e.target.value)} required autoFocus />
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="setting-namespace">Namespace</Label>
                                <Input id="setting-namespace" value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="e.g. features" />
                            </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="setting-type">Type</Label>
                            <Select value={dataType} onValueChange={setDataType}>
                                <SelectTrigger id="setting-type">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {DATA_TYPES.map((t) => (
                                        <SelectItem key={t} value={t}>
                                            {t}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="setting-value">Value</Label>
                            <Textarea id="setting-value" value={value} onChange={(e) => setValue(e.target.value)} rows={3} className="font-mono text-xs" />
                        </div>
                    </div>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button type="button" variant="outline">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={!key.trim() || saving}>
                            {saving ? <Spinner className="size-4" /> : 'Create'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function GlobalEditDialog({
    setting,
    open,
    onOpenChange,
    onSave,
}: {
    setting: GlobalSetting | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (id: string, value: unknown) => Promise<void>;
}) {
    const [saving, setSaving] = useState(false);
    const [value, setValue] = useState('');

    useEffect(() => {
        if (open && setting) setValue(editableValue(setting.value));
    }, [open, setting]);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!setting) return;
        setSaving(true);
        try {
            await onSave(setting.id, parseValue(value));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <form onSubmit={submit}>
                    <DialogHeader>
                        <DialogTitle>Edit {setting?.key}</DialogTitle>
                        <DialogDescription>Optimistic concurrency is enforced — if another admin saved first, you’ll be asked to refresh.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="edit-value">Value</Label>
                            <Textarea id="edit-value" value={value} onChange={(e) => setValue(e.target.value)} rows={4} className="font-mono text-xs" autoFocus />
                        </div>
                    </div>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button type="button" variant="outline">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={saving}>
                            {saving ? <Spinner className="size-4" /> : 'Save'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function GlobalSettingsTab() {
    const { settings, isLoading, error, list, get, create, update, remove } = useGlobalSettings();
    const [editing, setEditing] = useState<GlobalSetting | null>(null);

    useEffect(() => {
        void list().catch(() => undefined);
    }, [list]);

    const onCreate = async (input: { key: string; value: unknown; dataType?: string; namespace?: string }) => {
        try {
            await create(input);
            toast.success('Setting created');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create setting');
            throw err;
        }
    };

    // OCC requires a fresh get() (caches the ETag) before update().
    const openEdit = async (setting: GlobalSetting) => {
        try {
            const fresh = await get(setting.id);
            setEditing(fresh);
        } catch {
            setEditing(setting);
        }
    };

    const onSave = async (id: string, value: unknown) => {
        try {
            await update(id, { value });
            toast.success('Setting saved');
            setEditing(null);
        } catch (err) {
            if (err instanceof ConfigConflictError) {
                toast.error('Changed by someone else — refreshing latest value.');
                try {
                    const fresh = await get(id);
                    setEditing(fresh);
                } catch {
                    setEditing(null);
                }
                return;
            }
            toast.error(err instanceof Error ? err.message : 'Failed to save setting');
        }
    };

    const onDelete = async (setting: GlobalSetting) => {
        try {
            await remove(setting.id);
            toast.success('Setting deleted');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete setting');
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <GlobalCreateDialog onCreate={onCreate} />
            </div>
            {error ? (
                <Alert variant="destructive">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Couldn’t load settings</AlertTitle>
                    <AlertDescription>{error.message}</AlertDescription>
                </Alert>
            ) : null}
            <div className="rounded-lg border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Namespace</TableHead>
                            <TableHead>Key</TableHead>
                            <TableHead>Value</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead className="w-24 text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {isLoading && settings.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                                    Loading…
                                </TableCell>
                            </TableRow>
                        ) : settings.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                                    No settings yet.
                                </TableCell>
                            </TableRow>
                        ) : (
                            settings.map((setting) => (
                                <TableRow key={setting.id}>
                                    <TableCell className="font-mono text-xs text-muted-foreground">{setting.namespace || '—'}</TableCell>
                                    <TableCell className="font-medium">{setting.key}</TableCell>
                                    <TableCell className="max-w-xs truncate font-mono text-xs text-muted-foreground" title={previewValue(setting.value)}>
                                        {previewValue(setting.value)}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">{setting.dataType || '—'}</TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end gap-1">
                                            <Button variant="ghost" size="icon" className="size-8" onClick={() => void openEdit(setting)} aria-label={`Edit ${setting.key}`}>
                                                <Pencil className="size-4" />
                                            </Button>
                                            <ConfirmDelete
                                                trigger={
                                                    <Button variant="ghost" size="icon" className="size-8" aria-label={`Delete ${setting.key}`}>
                                                        <Trash2 className="size-4" />
                                                    </Button>
                                                }
                                                title={`Delete “${setting.key}”?`}
                                                description="This cannot be undone."
                                                onConfirm={() => onDelete(setting)}
                                            />
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>
            <GlobalEditDialog setting={editing} open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} onSave={onSave} />
        </div>
    );
}

// ── User settings (read-only; surfaces the ui.data-grid namespace, TASK-372 D8) ──

function UserSettingsTab() {
    const { settings, isLoading, error, list } = useUserSettings();

    useEffect(() => {
        void list().catch(() => undefined);
    }, [list]);

    return (
        <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
                Your saved preferences, including persisted data-grid layouts under the <code className="font-mono">ui.data-grid</code> namespace.
            </p>
            {error ? (
                <Alert variant="destructive">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Couldn’t load your settings</AlertTitle>
                    <AlertDescription>{error.message}</AlertDescription>
                </Alert>
            ) : null}
            <div className="rounded-lg border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Namespace</TableHead>
                            <TableHead>Key</TableHead>
                            <TableHead>Value</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {isLoading && settings.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                                    Loading…
                                </TableCell>
                            </TableRow>
                        ) : settings.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                                    No personal settings yet.
                                </TableCell>
                            </TableRow>
                        ) : (
                            settings.map((setting) => (
                                <TableRow key={setting.id}>
                                    <TableCell className="font-mono text-xs text-muted-foreground">{String(setting.namespace ?? '—')}</TableCell>
                                    <TableCell className="font-medium">{setting.key}</TableCell>
                                    <TableCell className="max-w-md truncate font-mono text-xs text-muted-foreground" title={previewValue(setting.value)}>
                                        {previewValue(setting.value)}
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}

function SettingsPage() {
    return (
        <div>
            <PageHeader title="Settings" description="Platform-wide global settings and your personal preferences." />
            <Tabs defaultValue="global">
                <TabsList>
                    <TabsTrigger value="global">Global</TabsTrigger>
                    <TabsTrigger value="user">My settings</TabsTrigger>
                </TabsList>
                <TabsContent value="global" className="mt-4">
                    <GlobalSettingsTab />
                </TabsContent>
                <TabsContent value="user" className="mt-4">
                    <UserSettingsTab />
                </TabsContent>
            </Tabs>
        </div>
    );
}
