'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { useCreateTemplate, useDepartments, useUpdateTemplate } from '../api/hooks';
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

/** Footer row shared by the two forms — the drawer body owns scrolling, this stays inline. */
function FormActions({ children }: { children: React.ReactNode }) {
    return <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>;
}

/**
 * Create form body (no dialog chrome) — hosted in the console-wide `DetailDrawer`
 * create mode. POST /admin/prompt-templates; v1 content is created server-side.
 */
export function CreateTemplateForm({ onCreated, onCancel }: { onCreated: (template: PromptTemplate) => void; onCancel: () => void }) {
    const createTemplate = useCreateTemplate();
    const departmentsQuery = useDepartments();
    const [name, setName] = useState('');
    const [category, setCategory] = useState<PromptTemplateCategory>('SUMMARY');
    const [status, setStatus] = useState<PromptTemplateStatus>('DRAFT');
    const [departmentId, setDepartmentId] = useState('');
    const [description, setDescription] = useState('');
    const [content, setContent] = useState('');

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
                    onCreated(template);
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the template.'),
            },
        );
    }

    return (
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
            <div className="flex min-h-40 flex-1 flex-col gap-2">
                <Label htmlFor="create-template-content">
                    Prompt content <RequiredMark />
                </Label>
                <Textarea
                    id="create-template-content"
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder={'You are a clinical scribe. Summarize {{transcript}} as…'}
                    className="min-h-40 flex-1 resize-none font-mono text-xs"
                    required
                />
            </div>
            <FormActions>
                <Button type="button" variant="outline" onClick={onCancel} disabled={createTemplate.isPending}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!name.trim() || !content || createTemplate.isPending}>
                    {createTemplate.isPending ? <Spinner /> : null}
                    Create template
                </Button>
            </FormActions>
        </form>
    );
}

/**
 * Edit form body (no dialog chrome) — hosted in the drawer's Overview tab.
 * PATCH /admin/prompt-templates/:id with optimistic concurrency; a content edit
 * bumps currentVersionNumber server-side (new PromptVersion row). 412/428 render
 * the inline OCC alert instead of a toast.
 */
export function EditTemplateForm({
    template,
    etag,
    onSaved,
    onReload,
}: {
    template: PromptTemplate;
    etag: string | null;
    onSaved: () => void;
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
                    onSaved();
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
            <div className="flex min-h-40 flex-1 flex-col gap-2">
                <Label htmlFor="edit-template-content">
                    Prompt content <RequiredMark />
                </Label>
                <Textarea
                    id="edit-template-content"
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    className="min-h-40 flex-1 resize-none font-mono text-xs"
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
            <FormActions>
                <Button type="submit" disabled={!name.trim() || !content || !etag || updateTemplate.isPending}>
                    {updateTemplate.isPending ? <Spinner /> : null}
                    Save changes
                </Button>
            </FormActions>
        </form>
    );
}
