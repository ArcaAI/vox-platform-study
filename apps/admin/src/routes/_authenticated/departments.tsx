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
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useDepartments, usePrompts, type PromptTemplate, type PromptTemplateCategory } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ConfirmDelete } from '@/features/common/confirm-delete';
import { PageHeader } from '@/components/layout/page-header';
import { formatDateTime } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/departments')({
    component: DepartmentsPage,
});

type Department = ReturnType<typeof useDepartments>['departments'][number];

const PROMPT_CATEGORIES: PromptTemplateCategory[] = ['SYSTEM', 'SUMMARY', 'DNA_ANALYSIS', 'CUSTOM'];
const PROMPT_STATUSES = ['DRAFT', 'PUBLISHED'] as const;

// ── Departments tab ────────────────────────────────────────────────────────────

function DepartmentFormDialog({
    mode,
    initial,
    onSave,
    trigger,
    open,
    onOpenChange,
}: {
    mode: 'create' | 'edit';
    initial?: Department | null;
    onSave: (data: { name: string; code?: string }) => Promise<void>;
    trigger?: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}) {
    const [internalOpen, setInternalOpen] = useState(false);
    const isOpen = open ?? internalOpen;
    const setOpen = onOpenChange ?? setInternalOpen;
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState('');
    const [code, setCode] = useState('');

    useEffect(() => {
        if (isOpen) {
            setName(initial?.name ?? '');
            setCode(String(initial?.code ?? ''));
        }
    }, [isOpen, initial]);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;
        setSaving(true);
        try {
            await onSave({ name: name.trim(), code: code.trim() || undefined });
            setOpen(false);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={setOpen}>
            {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
            <DialogContent>
                <form onSubmit={submit}>
                    <DialogHeader>
                        <DialogTitle>{mode === 'create' ? 'New department' : 'Edit department'}</DialogTitle>
                        <DialogDescription>Departments group clinicians and hold default prompt configuration.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="dept-name">Name</Label>
                            <Input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="dept-code">Code</Label>
                            <Input id="dept-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. CARD" />
                        </div>
                    </div>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button type="button" variant="outline">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={!name.trim() || saving}>
                            {saving ? <Spinner className="size-4" /> : mode === 'create' ? 'Create' : 'Save'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function DepartmentsTab() {
    const { departments, isLoading, error, list, create, update, remove } = useDepartments();
    const [editing, setEditing] = useState<Department | null>(null);

    useEffect(() => {
        void list().catch(() => undefined);
    }, [list]);

    const onCreate = async (data: { name: string; code?: string }) => {
        try {
            await create(data);
            toast.success('Department created');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create department');
            throw err;
        }
    };

    const onUpdate = async (data: { name: string; code?: string }) => {
        if (!editing) return;
        try {
            await update(editing.id, data);
            toast.success('Department updated');
            setEditing(null);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update department');
            throw err;
        }
    };

    const onDelete = async (dept: Department) => {
        try {
            await remove(dept.id);
            toast.success('Department deleted');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete department');
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <DepartmentFormDialog
                    mode="create"
                    onSave={onCreate}
                    trigger={
                        <Button>
                            <Plus className="size-4" />
                            New department
                        </Button>
                    }
                />
            </div>
            {error ? (
                <Alert variant="destructive">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Couldn’t load departments</AlertTitle>
                    <AlertDescription>{error.message}</AlertDescription>
                </Alert>
            ) : null}
            <div className="rounded-lg border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Code</TableHead>
                            <TableHead className="w-24 text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {isLoading && departments.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                                    Loading…
                                </TableCell>
                            </TableRow>
                        ) : departments.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                                    No departments yet.
                                </TableCell>
                            </TableRow>
                        ) : (
                            departments.map((dept) => (
                                <TableRow key={dept.id}>
                                    <TableCell className="font-medium">{dept.name}</TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">{String(dept.code ?? '—')}</TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end gap-1">
                                            <Button variant="ghost" size="icon" className="size-8" onClick={() => setEditing(dept)} aria-label={`Edit ${dept.name}`}>
                                                <Pencil className="size-4" />
                                            </Button>
                                            <ConfirmDelete
                                                trigger={
                                                    <Button variant="ghost" size="icon" className="size-8" aria-label={`Delete ${dept.name}`}>
                                                        <Trash2 className="size-4" />
                                                    </Button>
                                                }
                                                title={`Delete department “${dept.name}”?`}
                                                description="This cannot be undone."
                                                onConfirm={() => onDelete(dept)}
                                            />
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>
            <DepartmentFormDialog mode="edit" initial={editing} onSave={onUpdate} open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} />
        </div>
    );
}

// ── Prompts tab ────────────────────────────────────────────────────────────────

export interface PromptFormPayload {
    name: string;
    category: PromptTemplateCategory;
    status: 'DRAFT' | 'PUBLISHED';
    content: string;
    description?: string;
    /** Edit-only: recorded on the new version the update creates. */
    changeReason?: string;
}

/**
 * Create/edit prompt-template dialog (TASK-374). `name` + `category` are set at
 * creation and immutable thereafter (the SDK `UpdatePromptInput` omits them), so
 * they render read-only in edit mode; editing `content`/`status`/`description`
 * creates a new version (an optional change reason is recorded). `create`/`update`
 * are SDK `usePrompts()` methods.
 */
function PromptFormDialog({
    mode,
    initial,
    onSave,
    trigger,
    open,
    onOpenChange,
}: {
    mode: 'create' | 'edit';
    initial?: PromptTemplate | null;
    onSave: (payload: PromptFormPayload) => Promise<void>;
    trigger?: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}) {
    const [internalOpen, setInternalOpen] = useState(false);
    const isOpen = open ?? internalOpen;
    const setOpen = onOpenChange ?? setInternalOpen;
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState('');
    const [category, setCategory] = useState<PromptTemplateCategory>('CUSTOM');
    const [status, setStatus] = useState<'DRAFT' | 'PUBLISHED'>('DRAFT');
    const [content, setContent] = useState('');
    const [description, setDescription] = useState('');
    const [changeReason, setChangeReason] = useState('');

    const isEdit = mode === 'edit';

    useEffect(() => {
        if (!isOpen) return;
        setName(initial?.name ?? '');
        setCategory(initial?.category ?? 'CUSTOM');
        setStatus(initial?.status ?? 'DRAFT');
        setContent(initial?.content ?? '');
        setDescription(initial?.description ?? '');
        setChangeReason('');
    }, [isOpen, initial]);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!name.trim() || !content.trim()) return;
        setSaving(true);
        try {
            await onSave({
                name: name.trim(),
                category,
                status,
                content,
                description: description.trim() || undefined,
                changeReason: isEdit ? changeReason.trim() || undefined : undefined,
            });
            setOpen(false);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={setOpen}>
            {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
            <DialogContent className="sm:max-w-2xl">
                <form onSubmit={submit}>
                    <DialogHeader>
                        <DialogTitle>{isEdit ? 'Edit prompt template' : 'New prompt template'}</DialogTitle>
                        <DialogDescription>
                            {isEdit
                                ? 'Editing the content or status creates a new version. Name and category are immutable.'
                                : 'Templates drive summaries and DNA analysis. New templates start at version 1.'}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="prompt-name">
                                    Name {isEdit ? <span className="font-normal text-muted-foreground">(immutable)</span> : null}
                                </Label>
                                <Input id="prompt-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus={!isEdit} disabled={isEdit} />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div className="flex flex-col gap-1.5">
                                    <Label htmlFor="prompt-category">
                                        Category {isEdit ? <span className="font-normal text-muted-foreground">(immutable)</span> : null}
                                    </Label>
                                    <Select value={category} onValueChange={(v) => setCategory(v as PromptTemplateCategory)} disabled={isEdit}>
                                        <SelectTrigger id="prompt-category">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {PROMPT_CATEGORIES.map((c) => (
                                                <SelectItem key={c} value={c}>
                                                    {c}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <Label htmlFor="prompt-status">Status</Label>
                                    <Select value={status} onValueChange={(v) => setStatus(v as 'DRAFT' | 'PUBLISHED')}>
                                        <SelectTrigger id="prompt-status">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {PROMPT_STATUSES.map((s) => (
                                                <SelectItem key={s} value={s}>
                                                    {s}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="prompt-desc">Description</Label>
                            <Input id="prompt-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="prompt-content">Content</Label>
                            <Textarea id="prompt-content" value={content} onChange={(e) => setContent(e.target.value)} rows={8} required className="font-mono text-xs" />
                        </div>
                        {isEdit ? (
                            <div className="flex flex-col gap-1.5">
                                <Label htmlFor="prompt-change-reason">Change reason</Label>
                                <Input
                                    id="prompt-change-reason"
                                    value={changeReason}
                                    onChange={(e) => setChangeReason(e.target.value)}
                                    placeholder="Optional — recorded on the new version"
                                />
                            </div>
                        ) : null}
                    </div>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button type="button" variant="outline">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={!name.trim() || !content.trim() || saving}>
                            {saving ? <Spinner className="size-4" /> : isEdit ? 'Save changes' : 'Create'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function PromptViewDialog({ prompt, open, onOpenChange }: { prompt: PromptTemplate | null; open: boolean; onOpenChange: (open: boolean) => void }) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{prompt?.name ?? 'Prompt'}</DialogTitle>
                    <DialogDescription>{prompt?.description || `${prompt?.category ?? ''} · v${prompt?.currentVersionNumber ?? 1}`}</DialogDescription>
                </DialogHeader>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">{prompt?.content}</pre>
                <DialogFooter>
                    <DialogClose asChild>
                        <Button variant="outline">Close</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function PromptsTab() {
    const { prompts, isLoading, error, list, create, update, remove } = usePrompts();
    const [viewing, setViewing] = useState<PromptTemplate | null>(null);
    const [editing, setEditing] = useState<PromptTemplate | null>(null);

    useEffect(() => {
        void list().catch(() => undefined);
    }, [list]);

    const onCreate = async (payload: PromptFormPayload) => {
        try {
            await create({ name: payload.name, category: payload.category, status: payload.status, content: payload.content, description: payload.description });
            toast.success('Prompt created');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create prompt');
            throw err;
        }
    };

    const onUpdate = async (payload: PromptFormPayload) => {
        if (!editing) return;
        try {
            // name/category are immutable; editing content/status creates a new
            // version. Echo the OCC token so the server can Compare-And-Set.
            await update(editing.id, {
                content: payload.content,
                status: payload.status,
                description: payload.description,
                changeReason: payload.changeReason,
                expectedVersion: editing.version,
            });
            toast.success('Prompt updated');
            setEditing(null);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update prompt');
            throw err;
        }
    };

    const onDelete = async (prompt: PromptTemplate) => {
        try {
            await remove(prompt.id);
            toast.success('Prompt deleted');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete prompt');
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <PromptFormDialog
                    mode="create"
                    onSave={onCreate}
                    trigger={
                        <Button>
                            <Plus className="size-4" />
                            New prompt
                        </Button>
                    }
                />
            </div>
            {error ? (
                <Alert variant="destructive">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Couldn’t load prompts</AlertTitle>
                    <AlertDescription>{error.message}</AlertDescription>
                </Alert>
            ) : null}
            <div className="rounded-lg border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Category</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Version</TableHead>
                            <TableHead>Updated</TableHead>
                            <TableHead className="w-24 text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {isLoading && prompts.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                                    Loading…
                                </TableCell>
                            </TableRow>
                        ) : prompts.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                                    No prompt templates yet.
                                </TableCell>
                            </TableRow>
                        ) : (
                            prompts.map((prompt) => (
                                <TableRow key={prompt.id}>
                                    <TableCell className="font-medium">{prompt.name}</TableCell>
                                    <TableCell className="text-muted-foreground">{prompt.category}</TableCell>
                                    <TableCell>
                                        <StatusBadge
                                            label={prompt.status === 'PUBLISHED' ? 'Published' : 'Draft'}
                                            colorRole={prompt.status === 'PUBLISHED' ? 'success' : 'neutral'}
                                        />
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">v{prompt.currentVersionNumber}</TableCell>
                                    <TableCell className="text-muted-foreground">{formatDateTime(prompt.updatedAt)}</TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end gap-1">
                                            <Button variant="ghost" size="icon" className="size-8" onClick={() => setViewing(prompt)} aria-label={`View ${prompt.name}`}>
                                                <Eye className="size-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="size-8" onClick={() => setEditing(prompt)} aria-label={`Edit ${prompt.name}`}>
                                                <Pencil className="size-4" />
                                            </Button>
                                            <ConfirmDelete
                                                trigger={
                                                    <Button variant="ghost" size="icon" className="size-8" aria-label={`Delete ${prompt.name}`}>
                                                        <Trash2 className="size-4" />
                                                    </Button>
                                                }
                                                title={`Delete prompt “${prompt.name}”?`}
                                                description="All versions of this template will be removed. This cannot be undone."
                                                onConfirm={() => onDelete(prompt)}
                                            />
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>
            <PromptViewDialog prompt={viewing} open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)} />
            <PromptFormDialog mode="edit" initial={editing} onSave={onUpdate} open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} />
        </div>
    );
}

function DepartmentsPage() {
    return (
        <div>
            <PageHeader title="Departments & Prompts" description="Clinical departments and the prompt templates that drive summaries and DNA analysis." />
            <Tabs defaultValue="departments">
                <TabsList>
                    <TabsTrigger value="departments">Departments</TabsTrigger>
                    <TabsTrigger value="prompts">Prompt templates</TabsTrigger>
                </TabsList>
                <TabsContent value="departments" className="mt-4">
                    <DepartmentsTab />
                </TabsContent>
                <TabsContent value="prompts" className="mt-4">
                    <PromptsTab />
                </TabsContent>
            </Tabs>
        </div>
    );
}
