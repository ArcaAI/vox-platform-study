'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
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
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useCreateTemplate, useDepartments, useTemplate, useUpdateTemplate } from '../api/hooks';
import type { PromptTemplate, PromptTemplateCategory, PromptTemplateStatus } from '../api/types';

const CATEGORY_OPTIONS: { value: PromptTemplateCategory; label: string }[] = [
    { value: 'SYSTEM', label: 'System' },
    { value: 'SUMMARY', label: 'Summary' },
    { value: 'DNA_ANALYSIS', label: 'DNA analysis' },
    { value: 'CUSTOM', label: 'Custom' },
];

const STATUS_OPTIONS: { value: PromptTemplateStatus; label: string }[] = [
    { value: 'DRAFT', label: 'Draft' },
    { value: 'PUBLISHED', label: 'Published' },
];

function RequiredMark() {
    return (
        <span aria-hidden className="text-destructive">
            *
        </span>
    );
}

/** POST /admin/prompt-templates — v1 is created server-side. */
export function CreateTemplateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const createTemplate = useCreateTemplate();
    const departmentsQuery = useDepartments();
    const [name, setName] = useState('');
    const [category, setCategory] = useState<PromptTemplateCategory>('SUMMARY');
    const [status, setStatus] = useState<PromptTemplateStatus>('DRAFT');
    const [departmentId, setDepartmentId] = useState('');
    const [description, setDescription] = useState('');
    const [content, setContent] = useState('');

    function handleOpenChange(next: boolean) {
        if (!next) {
            setName('');
            setCategory('SUMMARY');
            setStatus('DRAFT');
            setDepartmentId('');
            setDescription('');
            setContent('');
            createTemplate.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        createTemplate.mutate(
            {
                name: name.trim(),
                category,
                status,
                content,
                description: description.trim() || undefined,
                departmentId: departmentId || undefined,
            },
            {
                onSuccess: (template) => {
                    toast.success(`Template "${template.name}" created`);
                    handleOpenChange(false);
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the template.'),
            },
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="flex h-[70vh] flex-col sm:max-w-[50vw]">
                <DialogHeader>
                    <DialogTitle>New prompt template</DialogTitle>
                    <DialogDescription>
                        Creates the template with its v1 content. <span className="font-mono text-xs">POST /admin/prompt-templates</span>
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="create-template-name">
                                Name <RequiredMark />
                            </Label>
                            <Input
                                id="create-template-name"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="e.g. Cardiology Notes"
                                autoComplete="off"
                                required
                            />
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="create-template-category">
                                Category <RequiredMark />
                            </Label>
                            <Select value={category} onValueChange={(next) => setCategory(next as PromptTemplateCategory)}>
                                <SelectTrigger id="create-template-category" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {CATEGORY_OPTIONS.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="create-template-status">Status</Label>
                            <Select value={status} onValueChange={(next) => setStatus(next as PromptTemplateStatus)}>
                                <SelectTrigger id="create-template-status" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {STATUS_OPTIONS.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="create-template-department">Department</Label>
                            <Select value={departmentId || 'none'} onValueChange={(next) => setDepartmentId(next === 'none' ? '' : next)}>
                                <SelectTrigger id="create-template-department" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="none">All departments</SelectItem>
                                    {(departmentsQuery.data ?? []).map((department) => (
                                        <SelectItem key={department.id} value={department.id}>
                                            {department.code ?? department.name ?? department.id}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="create-template-description">Description</Label>
                        <Input
                            id="create-template-description"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            placeholder="What this agent produces"
                            autoComplete="off"
                        />
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col gap-2">
                        <Label htmlFor="create-template-content">
                            Prompt content <RequiredMark />
                        </Label>
                        <Textarea
                            id="create-template-content"
                            value={content}
                            onChange={(event) => setContent(event.target.value)}
                            placeholder={'You are a clinical scribe. Summarize {{transcript}} as\u2026'}
                            className="min-h-0 flex-1 resize-none font-mono text-xs"
                            required
                        />
                    </div>
                    <DialogFooter className="shrink-0">
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={createTemplate.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!name.trim() || !content || createTemplate.isPending}>
                            {createTemplate.isPending ? <Spinner /> : null}
                            Create template
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function EditTemplateForm({
    template,
    etag,
    onClose,
    onReload,
}: {
    template: PromptTemplate;
    etag: string | null;
    onClose: () => void;
    onReload: () => void;
}) {
    const updateTemplate = useUpdateTemplate();
    const [name, setName] = useState(template.name);
    const [description, setDescription] = useState(template.description ?? '');
    const [content, setContent] = useState(template.content);
    const [status, setStatus] = useState<PromptTemplateStatus>(template.status);
    const [changeReason, setChangeReason] = useState('');
    const occError =
        updateTemplate.error instanceof GatewayError && (updateTemplate.error.isVersionConflict || updateTemplate.error.isMissingPrecondition)
            ? updateTemplate.error
            : null;

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!etag) return;
        updateTemplate.mutate(
            {
                id: template.id,
                patch: {
                    name: name.trim(),
                    description: description.trim() || undefined,
                    content,
                    status,
                    changeReason: changeReason.trim() || undefined,
                },
                etag,
            },
            {
                onSuccess: () => {
                    toast.success('Template updated');
                    onClose();
                },
                onError: (error) => {
                    // A 412/428 renders the inline OCC alert instead of a toast.
                    if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
                    toast.error(error instanceof GatewayError ? error.message : 'Could not update the template.');
                },
            },
        );
    }

    return (
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
            <OccConflictAlert
                error={occError}
                onReload={() => {
                    // Keeps the local edits; the refetched ETag arms the next save.
                    onReload();
                    updateTemplate.reset();
                }}
            />
            <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                    <Label htmlFor="edit-template-name">
                        Name <RequiredMark />
                    </Label>
                    <Input id="edit-template-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" required />
                </div>
                <div className="flex flex-col gap-2">
                    <Label htmlFor="edit-template-status">Status</Label>
                    <Select value={status} onValueChange={(next) => setStatus(next as PromptTemplateStatus)}>
                        <SelectTrigger id="edit-template-status" className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {STATUS_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="edit-template-description">Description</Label>
                <Input
                    id="edit-template-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    autoComplete="off"
                />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2">
                <Label htmlFor="edit-template-content">
                    Prompt content <RequiredMark />
                </Label>
                <Textarea
                    id="edit-template-content"
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    className="min-h-0 flex-1 resize-none font-mono text-xs"
                    required
                />
            </div>
            <div className="flex flex-col gap-2">
                <Label htmlFor="edit-template-change-reason">Change reason</Label>
                <Input
                    id="edit-template-change-reason"
                    value={changeReason}
                    onChange={(event) => setChangeReason(event.target.value)}
                    placeholder="Stored in the version history"
                    autoComplete="off"
                />
            </div>
            <DialogFooter className="shrink-0">
                <Button type="button" variant="outline" onClick={onClose} disabled={updateTemplate.isPending}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!name.trim() || !content || !etag || updateTemplate.isPending}>
                    {updateTemplate.isPending ? <Spinner /> : null}
                    Save changes
                </Button>
            </DialogFooter>
        </form>
    );
}

/**
 * PATCH /admin/prompt-templates/:id — optimistic concurrency. The dialog does
 * its own detail read so the If-Match ETag is fresh at open time; a content
 * edit bumps currentVersionNumber server-side (new PromptVersion row).
 */
export function EditTemplateDialog({ templateId, onOpenChange }: { templateId: string; onOpenChange: (open: boolean) => void }) {
    const detail = useTemplate(templateId);

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[70vh] flex-col sm:max-w-[50vw]">
                <DialogHeader>
                    <DialogTitle>Edit template</DialogTitle>
                    <DialogDescription>
                        Saving a content change creates the next version. <span className="font-mono text-xs">PATCH /admin/prompt-templates/:id</span>
                    </DialogDescription>
                </DialogHeader>
                {detail.isPending ? (
                    <div className="flex flex-col gap-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Skeleton className="h-9 w-full" />
                            <Skeleton className="h-9 w-full" />
                        </div>
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-40 w-full" />
                    </div>
                ) : detail.error || !detail.data ? (
                    <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
                ) : (
                    <EditTemplateForm
                        key={templateId}
                        template={detail.data.data}
                        etag={detail.data.etag}
                        onClose={() => onOpenChange(false)}
                        onReload={() => void detail.refetch()}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
