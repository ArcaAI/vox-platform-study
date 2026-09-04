'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { cx } from '@/shared/cx';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useCreateModel, useModel, useUpdateModel } from '../api/hooks';
import type { AiDeploymentKind, AiModel, AiModelFormat, AiModelSource, CreateModelRequest, ModelCategory, ModelType, UpdateModelRequest } from '../api/types';
import { ModelDownloadPanel } from './model-download';
import {
  CATEGORY_OPTIONS,
  DEPLOYMENT_KIND_LABELS,
  DEPLOYMENT_KIND_OPTIONS,
  FORMAT_OPTIONS,
  LIBRARY_OPTIONS,
  MODEL_TYPE_OPTIONS,
  RUNTIME_PROVIDER_OPTIONS,
  SERVED_BY_OPTIONS,
  SOURCE_LABELS,
  SOURCE_OPTIONS,
  deriveLocalPath,
  humanizeEnum,
} from './model-meta';
import { ModelRegistryConnectionStatus } from './model-registry-connection-status';

/** Radix SelectItem forbids the empty string; sentinel for "no runtime provider". */
const PROVIDER_NONE = 'none';

/** The two string vocabularies render verbatim (they are identifiers, not enums to humanise). */
const LIBRARY_LABELS = Object.fromEntries(LIBRARY_OPTIONS.map((library) => [library, library])) as Record<string, string>;
const SERVED_BY_LABELS = Object.fromEntries(SERVED_BY_OPTIONS.map((workload) => [workload, workload])) as Record<string, string>;

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
  provider: string;
  architecture: string;
  memorySizeMb: string;
  computeType: string;
  tags: string;
  // ── Hugging Face taxonomy + serving identity (TASK-860) ──────────────────
  libraryName: string;
  servedBy: string;
  deploymentKind: AiDeploymentKind;
  wireModelId: string;
  license: string;
  gated: boolean;
  baseModel: string;
  languages: string;
  hfRevision: string;
  /** Bucket identity — normally written by the publish job; typed only when registering weights already in the bucket. */
  bucketPrefix: string;
  primaryObject: string;
}

/** Pre-fill for "register from the bucket" (the inventory's unregistered prefixes). */
export type ModelFormSeed = Partial<Pick<ModelFormValues, 'name' | 'slug' | 'bucketPrefix' | 'primaryObject'>>;

function toValues(model?: AiModel, seed?: ModelFormSeed): ModelFormValues {
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
    provider: model?.provider ?? '',
    architecture: model?.architecture ?? '',
    memorySizeMb: model?.memorySizeMb != null ? String(model.memorySizeMb) : '',
    computeType: model?.computeType ?? '',
    tags: model?.tags.join(', ') ?? '',
    libraryName: model?.libraryName ?? 'transformers',
    servedBy: model?.servedBy ?? 'nlp',
    deploymentKind: model?.deploymentKind ?? 'SELF_HOSTED',
    wireModelId: model?.wireModelId ?? '',
    license: model?.license ?? '',
    gated: model?.gated ?? false,
    baseModel: model?.baseModel ?? '',
    languages: model?.languages.join(', ') ?? '',
    hfRevision: model?.hfRevision ?? '',
    bucketPrefix: model?.bucketPrefix ?? '',
    primaryObject: model?.primaryObject ?? '',
    ...(seed ?? {}),
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
    // "(none)" omits the field — the gateway DTO rejects null/empty (@IsIn).
    ...(values.provider ? { provider: values.provider } : {}),
    ...(values.architecture.trim() ? { architecture: values.architecture.trim() } : {}),
    ...(values.sourceRevision.trim() ? { sourceRevision: values.sourceRevision.trim() } : {}),
    ...(values.memorySizeMb.trim() ? { memorySizeMb: Number(values.memorySizeMb) } : {}),
    ...(values.computeType.trim() ? { computeType: values.computeType.trim() } : {}),
    ...(values.tags.trim() ? { tags: splitList(values.tags) } : {}),
    // Registry identity (TASK-860). `localPath` is never sent — the gateway derives it.
    libraryName: values.libraryName,
    servedBy: values.servedBy,
    deploymentKind: values.deploymentKind,
    ...(values.wireModelId.trim() ? { wireModelId: values.wireModelId.trim() } : {}),
    ...(values.license.trim() ? { license: values.license.trim() } : {}),
    ...(values.gated ? { gated: true } : {}),
    ...(values.baseModel.trim() ? { baseModel: values.baseModel.trim() } : {}),
    ...(values.languages.trim() ? { languages: splitList(values.languages) } : {}),
    ...(values.hfRevision.trim() ? { hfRevision: values.hfRevision.trim() } : {}),
    ...(values.bucketPrefix.trim() ? { bucketPrefix: values.bucketPrefix.trim() } : {}),
    ...(values.primaryObject.trim() ? { primaryObject: values.primaryObject.trim() } : {}),
  };
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Same payload as `toRequest`, but the nullable registry fields are ALWAYS
 * sent (an empty string clears them — the DTO's documented semantics) so an
 * edit that blanks a wire id, licence or bucket prefix removes it rather than
 * silently keeping the old value. `gated` travels as a boolean either way.
 */
function toUpdateRequest(values: ModelFormValues): UpdateModelRequest {
  return {
    ...toRequest(values),
    wireModelId: values.wireModelId.trim(),
    license: values.license.trim(),
    gated: values.gated,
    baseModel: values.baseModel.trim(),
    languages: splitList(values.languages),
    hfRevision: values.hfRevision.trim(),
    bucketPrefix: values.bucketPrefix.trim(),
    primaryObject: values.primaryObject.trim(),
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

/** Skeleton mirroring the form layout while the edited row loads (rule 10). */
function ModelFormSkeleton() {
  return (
    <div className="grid grid-cols-1 content-start gap-4 sm:grid-cols-2">
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
 * Which row the local field state was seeded from. `closed`/`pending`/`create`
 * all seed the empty form; `row:<id>` seeds from the loaded model. A refetch
 * after a 412 keeps the same `row:<id>`, so the ETag refreshes WITHOUT
 * clobbering local edits (the OCC alert promises "your unsaved edits are kept
 * locally") — the guarantee the retired `key={model.id}` remount used to give.
 */
function seedKeyOf(open: boolean, isEdit: boolean, model: AiModel | null): string {
  if (!open) return 'closed';
  if (!isEdit) return 'create';
  return model ? `row:${model.id}` : 'pending';
}

/**
 * Register/edit drawer (frame 15), hosted in the console-wide DetailDrawer:
 * fields in the scrolling body, actions in the pinned footer (submit reaches
 * the form through `form={formId}`). Edit mode reads `{ data, etag }` through
 * useModel so the PATCH carries If-Match + expectedVersion; a 412 surfaces the
 * OCC alert with "reload latest" (which refreshes the ETag in place). Closing
 * with unsaved edits asks before discarding them.
 */
export function ModelFormSheet({
  open,
  onOpenChange,
  modelId,
  seed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = register mode. */
  modelId: string | null;
  /** Register-mode pre-fill (from an inventory-reported bucket prefix). */
  seed?: ModelFormSeed;
}) {
  const uid = useId();
  const formId = `${uid}-form`;
  const isEdit = modelId !== null;
  const detail = useModel(modelId ?? '');
  const model = detail.data?.data ?? null;
  const etag = detail.data?.etag ?? '';

  const createMutation = useCreateModel();
  const updateMutation = useUpdateModel();
  const isPending = createMutation.isPending || updateMutation.isPending;

  const [values, setValues] = useState<ModelFormValues>(() => toValues());
  const [baseline, setBaseline] = useState<ModelFormValues>(() => toValues());
  const [seededFor, setSeededFor] = useState<string>('closed');
  const [discarding, setDiscarding] = useState(false);

  // Seed during render (never in an effect): the fields must already hold the
  // loaded row on the commit that first shows them.
  const seedKey = seedKeyOf(open, isEdit, model) + (seed ? `:${seed.bucketPrefix ?? ''}${seed.slug ?? ''}` : '');
  if (seedKey !== seededFor) {
    const seeded = seedKey.startsWith('row:') && model ? toValues(model) : toValues(undefined, seed);
    setSeededFor(seedKey);
    setValues(seeded);
    setBaseline(seeded);
  }

  const isDirty = JSON.stringify(values) !== JSON.stringify(baseline);
  const showForm = !isEdit || (!detail.isPending && !detail.error && model !== null);

  function set<K extends keyof ModelFormValues>(key: K, value: ModelFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  /** Closes for real and drops mutation state so a reopen starts clean. */
  function close() {
    setDiscarding(false);
    createMutation.reset();
    updateMutation.reset();
    onOpenChange(false);
  }

  /** Esc / overlay / Cancel — never discards unsaved edits without asking. */
  function handleOpenChange(next: boolean) {
    if (next) {
      onOpenChange(true);
      return;
    }
    // Blocked while a mutation is in flight. The DetailDrawer is told WHY via
    // `closeBlockedReason`, so the close control is properly disabled and named
    // rather than staying focusable and silently doing nothing (WCAG 4.1.2).
    if (isPending) return;
    if (isDirty) {
      setDiscarding(true);
      return;
    }
    close();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isEdit && model) {
      updateMutation.mutate(
        { id: model.id, patch: toUpdateRequest(values), etag },
        {
          onSuccess: () => {
            toast.success('Model updated');
            close();
          },
          onError: (error) => {
            // OCC conflicts render the inline alert instead.
            if (!isOccError(error)) toast.error(error.message);
          },
        },
      );
      return;
    }
    createMutation.mutate(toRequest(values), {
      onSuccess: () => {
        toast.success('Model registered');
        close();
      },
      onError: (error) => toast.error(error.message),
    });
  }

  function handleReloadLatest() {
    updateMutation.reset();
    void detail.refetch();
  }

  return (
    <>
      <DetailDrawer
        closeBlockedReason={isPending ? 'Saving the model — wait for it to finish.' : undefined}
        open={open}
        onOpenChange={handleOpenChange}
        title={isEdit ? 'Edit model' : 'Register model'}
        meta={
          <>
            <span>
              {isEdit
                ? 'Changes are saved with optimistic concurrency (If-Match).'
                : 'Register a row in the platform catalogue (SYSTEM tenant) — agents bind to it, tenants read it.'}
            </span>
            {isEdit && model ? (
              <>
                <span className="font-mono">{model.id}</span>
                <CopyButton value={model.id} label="Copy model id" />
              </>
            ) : null}
          </>
        }
        footer={
          showForm ? (
            <div className="flex w-full flex-col gap-2">
              {isEdit ? <OccConflictAlert error={updateMutation.error} onReload={handleReloadLatest} /> : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
                  Cancel
                </Button>
                <Button type="submit" form={formId} disabled={isPending}>
                  {isPending ? <Spinner /> : null}
                  {isEdit ? 'Save changes' : 'Register model'}
                </Button>
              </div>
            </div>
          ) : null
        }
      >
        {!open ? null : isEdit && detail.isPending ? (
          <ModelFormSkeleton />
        ) : isEdit && !showForm ? (
          <ErrorState
            error={detail.error ?? new GatewayError(404, 'This model does not exist or is outside your access scope.')}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <>
            <form id={formId} onSubmit={handleSubmit} className="grid auto-rows-min grid-cols-1 content-start gap-4 sm:grid-cols-2">
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
                <EnumSelect id={`${uid}-category`} value={values.category} onChange={(value) => set('category', value)} options={CATEGORY_OPTIONS} />
              </Field>
              <Field id={`${uid}-model-type`} label="Model type" required>
                <EnumSelect
                  id={`${uid}-model-type`}
                  value={values.modelType}
                  onChange={(value) => set('modelType', value)}
                  options={MODEL_TYPE_OPTIONS}
                />
              </Field>
              <Field id={`${uid}-task-type`} label="Task (Hugging Face pipeline tag)" required className="sm:col-span-2">
                <Input
                  id={`${uid}-task-type`}
                  value={values.taskType}
                  onChange={(event) => set('taskType', event.target.value)}
                  required
                  className="font-mono"
                  placeholder="AUTOMATIC_SPEECH_RECOGNITION"
                />
              </Field>
              <Field id={`${uid}-library`} label="Serving library" required>
                <EnumSelect id={`${uid}-library`} value={values.libraryName} onChange={(value) => set('libraryName', value)} options={[...LIBRARY_OPTIONS]} labels={LIBRARY_LABELS} />
              </Field>
              <Field id={`${uid}-served-by`} label="Served by" required>
                <EnumSelect id={`${uid}-served-by`} value={values.servedBy} onChange={(value) => set('servedBy', value)} options={[...SERVED_BY_OPTIONS]} labels={SERVED_BY_LABELS} />
              </Field>
              <Field id={`${uid}-deployment`} label="Deployment" required>
                <EnumSelect
                  id={`${uid}-deployment`}
                  value={values.deploymentKind}
                  onChange={(value) => set('deploymentKind', value)}
                  options={DEPLOYMENT_KIND_OPTIONS}
                  labels={DEPLOYMENT_KIND_LABELS}
                />
              </Field>
              <Field id={`${uid}-wire-model-id`} label="Wire model id" required={values.deploymentKind === 'CLOUD'}>
                <Input
                  id={`${uid}-wire-model-id`}
                  value={values.wireModelId}
                  onChange={(event) => set('wireModelId', event.target.value)}
                  required={values.deploymentKind === 'CLOUD'}
                  disabled={values.deploymentKind !== 'CLOUD'}
                  className="font-mono"
                  placeholder="gpt-transcribe"
                  aria-describedby={`${uid}-wire-model-id-hint`}
                />
                <p id={`${uid}-wire-model-id-hint`} className="text-muted-foreground text-xs">
                  {values.deploymentKind === 'CLOUD' ? 'The id the vendor is invoked with.' : 'Cloud rows only — self-hosted rows are identified by their bucket prefix.'}
                </p>
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
                <EnumSelect id={`${uid}-format`} value={values.format} onChange={(value) => set('format', value)} options={FORMAT_OPTIONS} />
              </Field>
              <Field id={`${uid}-provider`} label="Runtime provider">
                <Select
                  value={values.provider === '' ? PROVIDER_NONE : values.provider}
                  onValueChange={(next) => set('provider', next === PROVIDER_NONE ? '' : next)}
                >
                  <SelectTrigger id={`${uid}-provider`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PROVIDER_NONE}>(none)</SelectItem>
                    {RUNTIME_PROVIDER_OPTIONS.map((provider) => (
                      <SelectItem key={provider} value={provider} className="font-mono">
                        {provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id={`${uid}-architecture`} label="Architecture">
                <Input
                  id={`${uid}-architecture`}
                  value={values.architecture}
                  onChange={(event) => set('architecture', event.target.value)}
                  className="font-mono"
                  placeholder="gemma4"
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
                  aria-describedby={`${uid}-weight-source-help`}
                />
              </Field>
              <Field id={`${uid}-license`} label="Licence">
                <Input id={`${uid}-license`} value={values.license} onChange={(event) => set('license', event.target.value)} className="font-mono" placeholder="apache-2.0" />
              </Field>
              <Field id={`${uid}-base-model`} label="Base model">
                <Input
                  id={`${uid}-base-model`}
                  value={values.baseModel}
                  onChange={(event) => set('baseModel', event.target.value)}
                  className="font-mono"
                  placeholder="openai/whisper-large-v3-turbo"
                />
              </Field>
              <Field id={`${uid}-languages`} label="Languages (comma-separated ISO codes)">
                <Input id={`${uid}-languages`} value={values.languages} onChange={(event) => set('languages', event.target.value)} placeholder="en, ml" />
              </Field>
              <div className="flex items-center gap-2 self-end pb-2">
                <Checkbox id={`${uid}-gated`} checked={values.gated} onCheckedChange={(checked) => set('gated', checked === true)} />
                <Label htmlFor={`${uid}-gated`}>Gated Hub repo (needs the platform token)</Label>
              </div>
              <Field id={`${uid}-bucket-prefix`} label="Bucket prefix" className="sm:col-span-2">
                <Input
                  id={`${uid}-bucket-prefix`}
                  value={values.bucketPrefix}
                  onChange={(event) => set('bucketPrefix', event.target.value)}
                  className="font-mono"
                  placeholder="<slug>/<version>/ or hf/hub/models--org--repo/snapshots/<sha>/"
                  aria-describedby={`${uid}-bucket-help`}
                />
              </Field>
              <Field id={`${uid}-primary-object`} label="Primary object (single-file loaders)">
                <Input
                  id={`${uid}-primary-object`}
                  value={values.primaryObject}
                  onChange={(event) => set('primaryObject', event.target.value)}
                  className="font-mono"
                  placeholder="ggml-model-q8_0.bin"
                  aria-describedby={`${uid}-bucket-help`}
                />
              </Field>
              <Field id={`${uid}-hf-revision`} label="Hub revision (sha)">
                <Input id={`${uid}-hf-revision`} value={values.hfRevision} onChange={(event) => set('hfRevision', event.target.value)} className="font-mono" />
              </Field>
              <div id={`${uid}-bucket-help`} className="text-muted-foreground flex flex-col gap-1.5 rounded-md border border-dashed p-3 text-xs sm:col-span-2">
                <p>
                  <span className="text-foreground font-medium">Where the weights live.</span> Every serving pod mounts{' '}
                  <code className="font-mono">s3://hope-models</code> read-only at <code className="font-mono">/mnt/models-bucket</code>. The
                  bucket prefix is normally written by <span className="text-foreground font-medium">Publish to bucket</span> (below, once the row
                  exists) — type it only when registering weights the inventory found already in the bucket.
                </p>
                <p>
                  <span className="text-foreground font-medium">Derived local path:</span>{' '}
                  <code className="font-mono" data-testid="derived-local-path">
                    {values.bucketPrefix.trim() ? deriveLocalPath(values.bucketPrefix.trim(), values.primaryObject.trim() || null) : '— (not published)'}
                  </code>{' '}
                  — the services read it as the highest-precedence weight location; it is never typed by hand.
                </p>
                <ModelRegistryConnectionStatus />
              </div>
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
            </form>
            {/* Publish needs an id — no create-time equivalent, so this is edit-only. */}
            {isEdit && model ? <ModelDownloadPanel model={model} /> : null}
          </>
        )}
      </DetailDrawer>
      <ConfirmDialog
        open={discarding}
        onOpenChange={(next) => setDiscarding(next)}
        title="Discard unsaved changes?"
        description="This drawer has edits that have not been saved. Closing it discards them."
        confirmLabel="Discard changes"
        destructive
        onConfirm={close}
      />
    </>
  );
}
