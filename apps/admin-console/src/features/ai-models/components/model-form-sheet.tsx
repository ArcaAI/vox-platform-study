'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
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
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from '@arcaai/ui/components/shadcn/sheet';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { cx } from '@/shared/cx';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useCreateModel, useModel, useUpdateModel } from '../api/hooks';
import type { AiModel, AiModelFormat, AiModelSource, CreateModelRequest, ModelCategory, ModelType } from '../api/types';
import { CATEGORY_OPTIONS, FORMAT_OPTIONS, MODEL_TYPE_OPTIONS, SOURCE_LABELS, SOURCE_OPTIONS, humanizeEnum } from './model-meta';

interface ModelFormValues {
    name: string;
    slug: string;
    description: string;
    category: ModelCategory;
    taskType: string;
    modelType: ModelType;
    source: AiModelSource;
    sourceUri: string;
    sourceRevision: string;
    format: AiModelFormat;
    memorySizeMb: string;
    computeType: string;
    tags: string;
}

function toValues(model?: AiModel): ModelFormValues {
    return {
        name: model?.name ?? '',
        slug: model?.slug ?? '',
        description: model?.description ?? '',
        category: model?.category ?? 'UNKNOWN',
        taskType: model?.taskType ?? '',
        modelType: model?.modelType ?? 'BASE_MODEL',
        source: model?.source ?? 'HUGGINGFACE',
        sourceUri: model?.sourceUri ?? '',
        sourceRevision: model?.sourceRevision ?? '',
        format: model?.format ?? 'SAFETENSOR',
        memorySizeMb: model?.memorySizeMb != null ? String(model.memorySizeMb) : '',
        computeType: model?.computeType ?? '',
        tags: model?.tags.join(', ') ?? '',
    };
}

/** Optional empty fields are OMITTED so the wire payload stays minimal. */
function toRequest(values: ModelFormValues): CreateModelRequest {
    return {
        name: values.name.trim(),
        slug: values.slug.trim(),
        category: values.category,
        taskType: values.taskType.trim(),
        modelType: values.modelType,
        source: values.source,
        sourceUri: values.sourceUri.trim(),
        format: values.format,
        ...(values.description.trim() ? { description: values.description.trim() } : {}),
        ...(values.sourceRevision.trim() ? { sourceRevision: values.sourceRevision.trim() } : {}),
        ...(values.memorySizeMb.trim() ? { memorySizeMb: Number(values.memorySizeMb) } : {}),
        ...(values.computeType.trim() ? { computeType: values.computeType.trim() } : {}),
        ...(values.tags.trim()
            ? {
                  tags: values.tags
                      .split(',')
                      .map((tag) => tag.trim())
                      .filter(Boolean),
              }
            : {}),
    };
}

function isOccError(error: unknown): boolean {
    return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

function Field({
    id,
    label,
    required,
    className,
    children,
}: {
    id: string;
    label: string;
    required?: boolean;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div className={cx('flex flex-col gap-2', className)}>
            <Label htmlFor={id}>
                {label}
                {required ? (
                    <span aria-hidden className="text-destructive">
                        *
                    </span>
                ) : null}
            </Label>
            {children}
        </div>
    );
}

function EnumSelect<T extends string>({
    id,
    value,
    onChange,
    options,
    labels,
}: {
    id: string;
    value: T;
    onChange: (value: T) => void;
    options: T[];
    labels?: Partial<Record<T, string>>;
}) {
    return (
        <Select value={value} onValueChange={(next) => onChange(next as T)}>
            <SelectTrigger id={id} className="w-full">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {options.map((option) => (
                    <SelectItem key={option} value={option}>
                        {labels?.[option] ?? humanizeEnum(option)}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

/**
 * Register/edit form (frame 15). Field state initializes from the loaded row
 * once; a reload after a 412 refreshes the ETag WITHOUT clobbering local
 * edits (the OCC alert promises "your unsaved edits are kept locally").
 */
function ModelForm({
    initial,
    etag,
    onDone,
    onCancel,
    onReloadLatest,
}: {
    initial?: AiModel;
    etag?: string;
    onDone: () => void;
    onCancel: () => void;
    onReloadLatest?: () => void;
}) {
    const uid = useId();
    const [values, setValues] = useState<ModelFormValues>(() => toValues(initial));
    const createMutation = useCreateModel();
    const updateMutation = useUpdateModel();
    const isEdit = initial !== undefined;
    const isPending = createMutation.isPending || updateMutation.isPending;

    function set<K extends keyof ModelFormValues>(key: K, value: ModelFormValues[K]) {
        setValues((current) => ({ ...current, [key]: value }));
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const body = toRequest(values);
        if (isEdit) {
            updateMutation.mutate(
                { id: initial.id, patch: body, etag: etag ?? '' },
                {
                    onSuccess: () => {
                        toast.success('Model updated');
                        onDone();
                    },
                    onError: (error) => {
                        // OCC conflicts render the inline alert instead.
                        if (!isOccError(error)) toast.error(error.message);
                    },
                },
            );
        } else {
            createMutation.mutate(body, {
                onSuccess: () => {
                    toast.success('Model registered');
                    onDone();
                },
                onError: (error) => toast.error(error.message),
            });
        }
    }

    function handleReloadLatest() {
        updateMutation.reset();
        onReloadLatest?.();
    }

    return (
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 content-start gap-4 overflow-y-auto p-4 sm:grid-cols-2">
                <Field id={`${uid}-name`} label="Name" required className="sm:col-span-2">
                    <Input id={`${uid}-name`} value={values.name} onChange={(event) => set('name', event.target.value)} required />
                </Field>
                <Field id={`${uid}-slug`} label="Slug" required className="sm:col-span-2">
                    <Input
                        id={`${uid}-slug`}
                        value={values.slug}
                        onChange={(event) => set('slug', event.target.value)}
                        required
                        className="font-mono"
                        placeholder="whisper-large-v4"
                    />
                </Field>
                <Field id={`${uid}-description`} label="Description" className="sm:col-span-2">
                    <Textarea
                        id={`${uid}-description`}
                        value={values.description}
                        onChange={(event) => set('description', event.target.value)}
                        rows={2}
                    />
                </Field>
                <Field id={`${uid}-category`} label="Category" required>
                    <EnumSelect
                        id={`${uid}-category`}
                        value={values.category}
                        onChange={(value) => set('category', value)}
                        options={CATEGORY_OPTIONS}
                    />
                </Field>
                <Field id={`${uid}-model-type`} label="Model type" required>
                    <EnumSelect
                        id={`${uid}-model-type`}
                        value={values.modelType}
                        onChange={(value) => set('modelType', value)}
                        options={MODEL_TYPE_OPTIONS}
                    />
                </Field>
                <Field id={`${uid}-task-type`} label="Task type" required className="sm:col-span-2">
                    <Input
                        id={`${uid}-task-type`}
                        value={values.taskType}
                        onChange={(event) => set('taskType', event.target.value)}
                        required
                        className="font-mono"
                        placeholder="AUTOMATIC_SPEECH_RECOGNITION"
                    />
                </Field>
                <Field id={`${uid}-source`} label="Source" required>
                    <EnumSelect
                        id={`${uid}-source`}
                        value={values.source}
                        onChange={(value) => set('source', value)}
                        options={SOURCE_OPTIONS}
                        labels={SOURCE_LABELS}
                    />
                </Field>
                <Field id={`${uid}-format`} label="Format" required>
                    <EnumSelect
                        id={`${uid}-format`}
                        value={values.format}
                        onChange={(value) => set('format', value)}
                        options={FORMAT_OPTIONS}
                    />
                </Field>
                <Field id={`${uid}-source-uri`} label="Source URI" required className="sm:col-span-2">
                    <Input
                        id={`${uid}-source-uri`}
                        value={values.sourceUri}
                        onChange={(event) => set('sourceUri', event.target.value)}
                        required
                        className="font-mono"
                        placeholder="openai/whisper-large-v4"
                    />
                </Field>
                <Field id={`${uid}-source-revision`} label="Source revision">
                    <Input
                        id={`${uid}-source-revision`}
                        value={values.sourceRevision}
                        onChange={(event) => set('sourceRevision', event.target.value)}
                        className="font-mono"
                    />
                </Field>
                <Field id={`${uid}-memory`} label="Memory size (MB)">
                    <Input
                        id={`${uid}-memory`}
                        type="number"
                        min={0}
                        value={values.memorySizeMb}
                        onChange={(event) => set('memorySizeMb', event.target.value)}
                    />
                </Field>
                <Field id={`${uid}-compute-type`} label="Compute type">
                    <Input
                        id={`${uid}-compute-type`}
                        value={values.computeType}
                        onChange={(event) => set('computeType', event.target.value)}
                        placeholder="float16"
                    />
                </Field>
                <Field id={`${uid}-tags`} label="Tags (comma-separated)">
                    <Input id={`${uid}-tags`} value={values.tags} onChange={(event) => set('tags', event.target.value)} placeholder="stt, fallback" />
                </Field>
            </div>
            <SheetFooter className="border-t">
                {isEdit ? <OccConflictAlert error={updateMutation.error} onReload={handleReloadLatest} /> : null}
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
                        Cancel
                    </Button>
                    <Button type="submit" disabled={isPending}>
                        {isPending ? <Spinner /> : null}
                        {isEdit ? 'Save changes' : 'Register model'}
                    </Button>
                </div>
            </SheetFooter>
        </form>
    );
}

/** Skeleton mirroring the form layout while the edited row loads (rule 10). */
function ModelFormSkeleton() {
    return (
        <div className="grid grid-cols-1 content-start gap-4 p-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2 sm:col-span-2">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-9 w-full" />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-9 w-full" />
            </div>
            {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-9 w-full" />
                </div>
            ))}
        </div>
    );
}

/**
 * Register/edit drawer (frame 15). Edit mode reads `{ data, etag }` through
 * useModel so the PATCH carries If-Match + expectedVersion; a 412 surfaces
 * the OCC alert with "reload latest" (which refreshes the ETag in place).
 */
export function ModelFormSheet({
    open,
    onOpenChange,
    modelId,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** null = register mode. */
    modelId: string | null;
}) {
    const isEdit = modelId !== null;
    const detail = useModel(modelId ?? '');
    const model = detail.data?.data ?? null;

    function close() {
        onOpenChange(false);
    }

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl">
                <SheetHeader className="border-b">
                    <SheetTitle>{isEdit ? 'Edit model' : 'Register model'}</SheetTitle>
                    <SheetDescription>
                        {isEdit
                            ? 'Changes are saved with optimistic concurrency (If-Match).'
                            : 'Register a model so tenants can be assigned to it.'}
                    </SheetDescription>
                    {isEdit && model ? (
                        <div className="text-muted-foreground flex items-center gap-1 text-xs">
                            <span className="font-mono">{model.id}</span>
                            <CopyButton value={model.id} label="Copy model id" />
                        </div>
                    ) : null}
                </SheetHeader>
                {!isEdit ? (
                    <ModelForm onDone={close} onCancel={close} />
                ) : detail.isPending ? (
                    <ModelFormSkeleton />
                ) : detail.error || !model ? (
                    <div className="p-4">
                        <ErrorState
                            error={detail.error ?? new GatewayError(404, 'This model does not exist or is outside your access scope.')}
                            onRetry={() => void detail.refetch()}
                        />
                    </div>
                ) : (
                    <ModelForm
                        key={model.id}
                        initial={model}
                        etag={detail.data?.etag ?? ''}
                        onDone={close}
                        onCancel={close}
                        onReloadLatest={() => void detail.refetch()}
                    />
                )}
            </SheetContent>
        </Sheet>
    );
}
