'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { cx } from '@/shared/cx';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useDeleteDepartment, useDepartment, useUpdateDepartment, useUpdateDepartmentPromptConfig } from '../api/hooks';
import type { Department, UpdateDepartmentPromptConfigRequest, UpdateDepartmentRequest } from '../api/types';

/** Radix Select reserves '', so "no parent" maps through a sentinel. */
const ROOT_SENTINEL = '__root__';

function isOccError(error: unknown): boolean {
    return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <Label htmlFor={id}>{label}</Label>
            {children}
            {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
        </div>
    );
}

/**
 * A parent must not be the department itself or anything below it — the
 * gateway only rejects direct self-parenting, so the deeper-cycle guard is
 * client-side, derived from the flat list's parentDepartmentId edges.
 */
function descendantIds(departments: Department[], rootId: string): Set<string> {
    const childrenByParent = new Map<string, string[]>();
    for (const department of departments) {
        if (!department.parentDepartmentId) continue;
        const siblings = childrenByParent.get(department.parentDepartmentId) ?? [];
        siblings.push(department.id);
        childrenByParent.set(department.parentDepartmentId, siblings);
    }
    const collected = new Set<string>([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
        const current = queue.pop() as string;
        for (const childId of childrenByParent.get(current) ?? []) {
            if (collected.has(childId)) continue;
            collected.add(childId);
            queue.push(childId);
        }
    }
    return collected;
}

interface EditFormValues {
    name: string;
    code: string;
    description: string;
    parent: string;
    status: 'ENABLED' | 'DISABLED';
}

interface PromptConfigValues {
    preSummaryPromptId: string;
    newPatientPromptId: string;
    revisitPromptId: string;
    dnaWritingStylePromptId: string;
}

function toEditValues(department: Department): EditFormValues {
    return {
        name: department.name ?? '',
        code: department.code ?? '',
        description: department.description ?? '',
        parent: department.parentDepartmentId ?? ROOT_SENTINEL,
        status: department.resourceStatus === 'DISABLED' ? 'DISABLED' : 'ENABLED',
    };
}

function toPromptValues(department: Department): PromptConfigValues {
    return {
        preSummaryPromptId: department.preSummaryPromptId ?? '',
        newPatientPromptId: department.newPatientPromptId ?? '',
        revisitPromptId: department.revisitPromptId ?? '',
        dnaWritingStylePromptId: department.dnaWritingStylePromptId ?? '',
    };
}

/** Only fields that drifted from the loaded row go on the wire (a no-change PATCH 400s). */
function toUpdatePatch(values: EditFormValues, department: Department): UpdateDepartmentRequest {
    const patch: UpdateDepartmentRequest = {};
    if (values.name.trim() !== (department.name ?? '')) patch.name = values.name.trim();
    if (values.code.trim() !== (department.code ?? '')) patch.code = values.code.trim();
    if (values.description.trim() !== (department.description ?? '')) patch.description = values.description.trim();
    const currentParent = department.parentDepartmentId ?? ROOT_SENTINEL;
    if (values.parent !== currentParent) patch.parentDepartmentId = values.parent === ROOT_SENTINEL ? null : values.parent;
    const currentStatus = department.resourceStatus === 'DISABLED' ? 'DISABLED' : 'ENABLED';
    if (values.status !== currentStatus) patch.resourceStatus = values.status;
    return patch;
}

function toPromptPatch(values: PromptConfigValues, department: Department): UpdateDepartmentPromptConfigRequest {
    const patch: UpdateDepartmentPromptConfigRequest = {};
    const current = toPromptValues(department);
    for (const key of Object.keys(current) as (keyof PromptConfigValues)[]) {
        if (values[key].trim() !== current[key]) patch[key] = values[key].trim();
    }
    return patch;
}

function EditForm({
    department,
    etag,
    departments,
    onReloadLatest,
}: {
    department: Department;
    etag: string;
    departments: Department[];
    onReloadLatest: () => void;
}) {
    const uid = useId();
    const update = useUpdateDepartment();
    const updatePromptConfig = useUpdateDepartmentPromptConfig();
    const [values, setValues] = useState<EditFormValues>(() => toEditValues(department));
    const [promptValues, setPromptValues] = useState<PromptConfigValues>(() => toPromptValues(department));

    const excludedParents = descendantIds(departments, department.id);
    const parentOptions = departments.filter((candidate) => !excludedParents.has(candidate.id));
    const patch = toUpdatePatch(values, department);
    const promptPatch = toPromptPatch(promptValues, department);
    const dirty = Object.keys(patch).length > 0;
    const promptDirty = Object.keys(promptPatch).length > 0;

    function set<K extends keyof EditFormValues>(key: K, value: EditFormValues[K]) {
        setValues((current) => ({ ...current, [key]: value }));
    }

    function setPrompt<K extends keyof PromptConfigValues>(key: K, value: string) {
        setPromptValues((current) => ({ ...current, [key]: value }));
    }

    function handleReloadLatest() {
        // Local edits are kept (the OCC alert promises no silent loss);
        // reloading refreshes the row version behind the next save.
        update.reset();
        updatePromptConfig.reset();
        onReloadLatest();
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!dirty) return;
        update.mutate(
            { id: department.id, patch, etag },
            {
                onSuccess: () => toast.success('Department updated'),
                onError: (error) => {
                    if (!isOccError(error)) toast.error(error instanceof GatewayError ? error.message : 'Could not update the department.');
                },
            },
        );
    }

    function handlePromptSave() {
        if (!promptDirty) return;
        updatePromptConfig.mutate(
            { id: department.id, patch: promptPatch, etag },
            {
                onSuccess: () => toast.success('Prompt config updated'),
                onError: (error) => {
                    if (!isOccError(error)) toast.error(error instanceof GatewayError ? error.message : 'Could not update the prompt config.');
                },
            },
        );
    }

    const promptFields: { key: keyof PromptConfigValues; label: string }[] = [
        { key: 'preSummaryPromptId', label: 'Pre-summary prompt ID' },
        { key: 'newPatientPromptId', label: 'New patient prompt ID' },
        { key: 'revisitPromptId', label: 'Revisit prompt ID' },
        { key: 'dnaWritingStylePromptId', label: 'DNA writing-style prompt ID' },
    ];

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <OccConflictAlert error={update.error ?? updatePromptConfig.error} onReload={handleReloadLatest} />
            <Field id={`${uid}-name`} label="Name">
                <Input id={`${uid}-name`} value={values.name} onChange={(event) => set('name', event.target.value)} />
            </Field>
            <Field id={`${uid}-code`} label="Code" hint="Unique per tenant.">
                <Input id={`${uid}-code`} value={values.code} onChange={(event) => set('code', event.target.value)} className="font-mono" />
            </Field>
            <Field id={`${uid}-description`} label="Description">
                <Textarea
                    id={`${uid}-description`}
                    value={values.description}
                    onChange={(event) => set('description', event.target.value)}
                    rows={2}
                    className="resize-none"
                />
            </Field>
            <Field id={`${uid}-parent`} label="Parent">
                <Select value={values.parent} onValueChange={(next) => set('parent', next)}>
                    <SelectTrigger id={`${uid}-parent`} className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ROOT_SENTINEL}>{'\u2014'} Root (no parent) {'\u2014'}</SelectItem>
                        {parentOptions.map((candidate) => (
                            <SelectItem key={candidate.id} value={candidate.id}>
                                {candidate.name || candidate.code || candidate.id}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
            <Field id={`${uid}-status`} label="Status">
                <Select value={values.status} onValueChange={(next) => set('status', next as EditFormValues['status'])}>
                    <SelectTrigger id={`${uid}-status`} className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="ENABLED">Active</SelectItem>
                        <SelectItem value="DISABLED">Disabled</SelectItem>
                    </SelectContent>
                </Select>
            </Field>
            <div className="flex items-center justify-between gap-2">
                <p aria-hidden className="text-muted-foreground font-mono text-xs">
                    v{department.version} {'\u00b7'} If-Match on save
                </p>
                <Button type="submit" size="sm" disabled={!dirty || update.isPending}>
                    {update.isPending ? <Spinner /> : null}
                    Save changes
                </Button>
            </div>
            <div className="flex flex-col gap-4 border-t pt-4">
                <div className="flex flex-col gap-0.5">
                    <h3 className="text-xs font-semibold tracking-wide uppercase">Prompt config</h3>
                    <p className="text-muted-foreground text-xs">
                        Default prompts for this department{'\u2019'}s summaries {'\u2014'} bridges to Agents &amp; Prompt Templates.{' '}
                        <span aria-hidden className="font-mono">
                            PATCH :id/prompt-config
                        </span>
                    </p>
                </div>
                {promptFields.map((field) => (
                    <Field key={field.key} id={`${uid}-${field.key}`} label={field.label}>
                        <Input
                            id={`${uid}-${field.key}`}
                            value={promptValues[field.key]}
                            onChange={(event) => setPrompt(field.key, event.target.value)}
                            className="font-mono"
                            placeholder="Prompt template ID"
                        />
                    </Field>
                ))}
                <div className="flex justify-end">
                    <Button type="button" size="sm" variant="outline" disabled={!promptDirty || updatePromptConfig.isPending} onClick={handlePromptSave}>
                        {updatePromptConfig.isPending ? <Spinner /> : null}
                        Save prompt config
                    </Button>
                </div>
            </div>
        </form>
    );
}

/** Skeleton mirroring the edit form (rule 10). */
function EditPanelSkeleton() {
    return (
        <div className="flex flex-col gap-4" aria-hidden>
            {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-9 w-full" />
                </div>
            ))}
        </div>
    );
}

/**
 * Frame 30 edit card: If-Match form for the selected department, the prompt-
 * config section on its own OCC PATCH, and the type-to-confirm delete.
 */
export function DepartmentEditPanel({
    departmentId,
    departments,
    onDeleted,
}: {
    departmentId: string;
    departments: Department[];
    onDeleted: () => void;
}) {
    const detail = useDepartment(departmentId);
    const deleteDepartment = useDeleteDepartment();
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    const department = detail.data?.data ?? null;
    const title = department ? `Edit: ${department.name || department.code || department.id}` : 'Edit';
    const confirmToken = department ? department.code || department.name || department.id : '';

    function handleDeleteConfirmed() {
        if (!department) return;
        deleteDepartment.mutate(department.id, {
            onSuccess: () => {
                toast.success('Department deleted');
                setConfirmingDelete(false);
                onDeleted();
            },
            onError: (error) => {
                // 400 carries the "has children" guidance from the gateway.
                toast.error(error instanceof GatewayError ? error.message : 'Could not delete the department.');
                setConfirmingDelete(false);
            },
        });
    }

    return (
        <Card className={cx('gap-3 p-4', department?.resourceStatus === 'DISABLED' && 'border-dashed')}>
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="truncate text-sm font-semibold">{title}</h2>
                    <p aria-hidden className="text-muted-foreground font-mono text-xs">
                        PATCH :id (If-Match)
                    </p>
                </div>
                {department ? (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${department.name || department.code || department.id}`}
                        className="text-destructive hover:text-destructive"
                        onClick={() => setConfirmingDelete(true)}
                    >
                        <IconTrash aria-hidden />
                    </Button>
                ) : null}
            </div>
            {detail.isPending ? (
                <EditPanelSkeleton />
            ) : detail.error || !department ? (
                <ErrorState
                    error={detail.error ?? new GatewayError(404, 'This department does not exist or is outside your tenant scope.')}
                    onRetry={() => void detail.refetch()}
                />
            ) : (
                <EditForm
                    key={department.id}
                    department={department}
                    etag={detail.data?.etag ?? ''}
                    departments={departments}
                    onReloadLatest={() => void detail.refetch()}
                />
            )}
            <ConfirmDialog
                open={confirmingDelete}
                onOpenChange={(open) => !open && setConfirmingDelete(false)}
                title="Delete department?"
                description={
                    department
                        ? `This soft-deletes ${department.name || department.code || department.id}. Departments with sub-departments cannot be deleted — reassign the children first.`
                        : ''
                }
                confirmLabel="Delete department"
                destructive
                typeToConfirm={confirmToken}
                onConfirm={handleDeleteConfirmed}
                isPending={deleteDepartment.isPending}
            />
        </Card>
    );
}
