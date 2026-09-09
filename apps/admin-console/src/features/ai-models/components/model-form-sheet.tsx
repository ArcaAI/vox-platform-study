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
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { cx } from '@/shared/cx';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useCreateModel, useModel, useUpdateModel } from '../api/hooks';
import {
  AI_MODEL_ASR_PROFILE_DECODING_RANGES,
  AI_MODEL_ASR_PROFILE_HOTWORDS_MAX_ITEMS,
  AI_MODEL_ASR_PROFILE_INITIAL_PROMPT_MAX_LENGTH,
  AI_MODEL_ASR_PROFILE_WINDOW_RANGES,
  ASR_TASK_TYPE,
  type AiDeploymentKind,
  type AiModel,
  type AiModelAsrProfile,
  type AiModelAsrProfileDecoding,
  type AiModelFormat,
  type AiModelSource,
  type CreateModelRequest,
  type ModelCategory,
  type ModelType,
  type UpdateModelRequest,
} from '../api/types';
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
  // ── ASR decode profile (`_metadata.asr`, TASK-934) — rendered only when
  // `taskType` is `AUTOMATIC_SPEECH_RECOGNITION`; every field optional/blank-
  // clearable, mirroring the rest of this form's string-input convention.
  asrMaxDecodeWindowSec: string;
  asrPartialWindowSec: string;
  asrBeamSize: string;
  asrTemperature: string;
  asrNoSpeechThreshold: string;
  asrCompressionRatioThreshold: string;
  asrLogprobThreshold: string;
  asrConditionOnPrevTokens: boolean;
  asrNoRepeatNgramSize: string;
  asrPrevTextContextWords: string;
  asrHotwords: string;
  asrInitialPrompt: string;
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
    asrMaxDecodeWindowSec: numOrEmpty(model?.asrProfile?.maxDecodeWindowSec),
    asrPartialWindowSec: numOrEmpty(model?.asrProfile?.partialWindowSec),
    asrBeamSize: numOrEmpty(model?.asrProfile?.decoding?.beamSize),
    asrTemperature: numOrEmpty(model?.asrProfile?.decoding?.temperature),
    asrNoSpeechThreshold: numOrEmpty(model?.asrProfile?.decoding?.noSpeechThreshold),
    asrCompressionRatioThreshold: numOrEmpty(model?.asrProfile?.decoding?.compressionRatioThreshold),
    asrLogprobThreshold: numOrEmpty(model?.asrProfile?.decoding?.logprobThreshold),
    asrConditionOnPrevTokens: model?.asrProfile?.decoding?.conditionOnPrevTokens ?? false,
    asrNoRepeatNgramSize: numOrEmpty(model?.asrProfile?.decoding?.noRepeatNgramSize),
    asrPrevTextContextWords: numOrEmpty(model?.asrProfile?.decoding?.prevTextContextWords),
    asrHotwords: model?.asrProfile?.decoding?.hotwords?.join(', ') ?? '',
    asrInitialPrompt: model?.asrProfile?.initialPrompt ?? '',
    ...(seed ?? {}),
  };
}

function numOrEmpty(value: number | undefined): string {
  return value != null ? String(value) : '';
}

/** `decoding`, built from the ASR fields. `undefined` when every one is blank, so the profile omits an empty object. */
function toAsrProfileDecoding(values: ModelFormValues): AiModelAsrProfileDecoding | undefined {
  const decoding: AiModelAsrProfileDecoding = {};
  if (values.asrBeamSize.trim()) decoding.beamSize = Number(values.asrBeamSize);
  if (values.asrTemperature.trim()) decoding.temperature = Number(values.asrTemperature);
  if (values.asrNoSpeechThreshold.trim()) decoding.noSpeechThreshold = Number(values.asrNoSpeechThreshold);
  if (values.asrCompressionRatioThreshold.trim()) decoding.compressionRatioThreshold = Number(values.asrCompressionRatioThreshold);
  if (values.asrLogprobThreshold.trim()) decoding.logprobThreshold = Number(values.asrLogprobThreshold);
  if (values.asrConditionOnPrevTokens) decoding.conditionOnPrevTokens = true;
  if (values.asrNoRepeatNgramSize.trim()) decoding.noRepeatNgramSize = Number(values.asrNoRepeatNgramSize);
  if (values.asrPrevTextContextWords.trim()) decoding.prevTextContextWords = Number(values.asrPrevTextContextWords);
  if (values.asrHotwords.trim()) decoding.hotwords = splitList(values.asrHotwords);
  return Object.keys(decoding).length > 0 ? decoding : undefined;
}

/** The whole `asrProfile`. `null` when every field is blank — the PATCH semantics for "clear it". */
function toAsrProfileRequest(values: ModelFormValues): AiModelAsrProfile | null {
  const profile: AiModelAsrProfile = {};
  if (values.asrMaxDecodeWindowSec.trim()) profile.maxDecodeWindowSec = Number(values.asrMaxDecodeWindowSec);
  if (values.asrPartialWindowSec.trim()) profile.partialWindowSec = Number(values.asrPartialWindowSec);
  const decoding = toAsrProfileDecoding(values);
  if (decoding) profile.decoding = decoding;
  if (values.asrInitialPrompt.trim()) profile.initialPrompt = values.asrInitialPrompt.trim();
  return Object.keys(profile).length > 0 ? profile : null;
}

/** Optional empty fields are OMITTED so the wire payload stays minimal. */
function toRequest(values: ModelFormValues): CreateModelRequest {
  const asrProfile = values.taskType.trim() === ASR_TASK_TYPE ? toAsrProfileRequest(values) : null;
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
    ...(asrProfile ? { asrProfile } : {}),
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
    // Sent ALWAYS while the row is ASR (mirrors the fields above): a blanked
    // section clears the stored profile (`null`) rather than leaving a stale
    // one in place. Omitted entirely for a non-ASR row — the gateway 400s any
    // row whose taskType isn't AUTOMATIC_SPEECH_RECOGNITION.
    ...(values.taskType.trim() === ASR_TASK_TYPE ? { asrProfile: toAsrProfileRequest(values) } : {}),
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

/** `true` when a non-blank value falls outside `range` (or isn't a whole number for an integer range). */
function isOutOfRange(value: string, range: { min: number; max: number; integer?: boolean }): boolean {
  if (!value.trim()) return false;
  const num = Number(value);
  if (Number.isNaN(num)) return true;
  if (range.integer && !Number.isInteger(num)) return true;
  return num < range.min || num > range.max;
}

/**
 * A numeric field for the ASR decode profile (TASK-934): min/max from the SAME
 * range table the gateway DTO validates against (`AI_MODEL_ASR_PROFILE_*_RANGES`),
 * with the out-of-range error rendered BELOW the field (rule 11 §9) rather than
 * only discovered on submit.
 */
function RangedNumberField({
  id,
  label,
  value,
  onChange,
  range,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  range: { min: number; max: number; integer?: boolean };
  placeholder?: string;
}) {
  const invalid = isOutOfRange(value, range);
  return (
    <Field id={id} label={label}>
      <Input
        id={id}
        type="number"
        min={range.min}
        max={range.max}
        step={range.integer ? 1 : 'any'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
      />
      {invalid ? (
        <p id={`${id}-error`} className="text-destructive text-sm">
          Must be between {range.min} and {range.max}
          {range.integer ? ' (whole number)' : ''}.
        </p>
      ) : null}
    </Field>
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
  const hasAsrValidationError =
    values.taskType.trim() === ASR_TASK_TYPE &&
    (isOutOfRange(values.asrMaxDecodeWindowSec, AI_MODEL_ASR_PROFILE_WINDOW_RANGES.maxDecodeWindowSec) ||
      isOutOfRange(values.asrPartialWindowSec, AI_MODEL_ASR_PROFILE_WINDOW_RANGES.partialWindowSec) ||
      isOutOfRange(values.asrBeamSize, AI_MODEL_ASR_PROFILE_DECODING_RANGES.beamSize) ||
      isOutOfRange(values.asrTemperature, AI_MODEL_ASR_PROFILE_DECODING_RANGES.temperature) ||
      isOutOfRange(values.asrNoSpeechThreshold, AI_MODEL_ASR_PROFILE_DECODING_RANGES.noSpeechThreshold) ||
      isOutOfRange(values.asrCompressionRatioThreshold, AI_MODEL_ASR_PROFILE_DECODING_RANGES.compressionRatioThreshold) ||
      isOutOfRange(values.asrLogprobThreshold, AI_MODEL_ASR_PROFILE_DECODING_RANGES.logprobThreshold) ||
      isOutOfRange(values.asrNoRepeatNgramSize, AI_MODEL_ASR_PROFILE_DECODING_RANGES.noRepeatNgramSize) ||
      isOutOfRange(values.asrPrevTextContextWords, AI_MODEL_ASR_PROFILE_DECODING_RANGES.prevTextContextWords));

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
                <Button type="submit" form={formId} disabled={isPending || hasAsrValidationError}>
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
              {values.taskType.trim() === ASR_TASK_TYPE ? (
                <fieldset className="flex flex-col gap-4 rounded-md border p-3 sm:col-span-2">
                  <legend className="px-1 text-sm font-medium">ASR decode profile</legend>
                  <p className="text-muted-foreground text-xs">
                    Recommended decode geometry and thresholds for this fine-tune (TASK-934) — travels with the weights, not with
                    whichever agent binds them. Resolved agent → this profile → engine default; a value an agent sets always wins.
                  </p>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <RangedNumberField
                      id={`${uid}-asr-max-decode-window`}
                      label="Max decode window (s)"
                      value={values.asrMaxDecodeWindowSec}
                      onChange={(value) => set('asrMaxDecodeWindowSec', value)}
                      range={AI_MODEL_ASR_PROFILE_WINDOW_RANGES.maxDecodeWindowSec}
                      placeholder="7"
                    />
                    <RangedNumberField
                      id={`${uid}-asr-partial-window`}
                      label="Partial window (s)"
                      value={values.asrPartialWindowSec}
                      onChange={(value) => set('asrPartialWindowSec', value)}
                      range={AI_MODEL_ASR_PROFILE_WINDOW_RANGES.partialWindowSec}
                      placeholder="15"
                    />
                    <RangedNumberField
                      id={`${uid}-asr-beam-size`}
                      label="Beam size"
                      value={values.asrBeamSize}
                      onChange={(value) => set('asrBeamSize', value)}
                      range={AI_MODEL_ASR_PROFILE_DECODING_RANGES.beamSize}
                    />
                    <RangedNumberField
                      id={`${uid}-asr-temperature`}
                      label="Temperature"
                      value={values.asrTemperature}
                      onChange={(value) => set('asrTemperature', value)}
                      range={AI_MODEL_ASR_PROFILE_DECODING_RANGES.temperature}
                    />
                    <RangedNumberField
                      id={`${uid}-asr-no-speech-threshold`}
                      label="No-speech threshold"
                      value={values.asrNoSpeechThreshold}
                      onChange={(value) => set('asrNoSpeechThreshold', value)}
                      range={AI_MODEL_ASR_PROFILE_DECODING_RANGES.noSpeechThreshold}
                    />
                    <RangedNumberField
                      id={`${uid}-asr-compression-ratio-threshold`}
                      label="Compression ratio threshold"
                      value={values.asrCompressionRatioThreshold}
                      onChange={(value) => set('asrCompressionRatioThreshold', value)}
                      range={AI_MODEL_ASR_PROFILE_DECODING_RANGES.compressionRatioThreshold}
                    />
                    <RangedNumberField
                      id={`${uid}-asr-logprob-threshold`}
                      label="Logprob threshold"
                      value={values.asrLogprobThreshold}
                      onChange={(value) => set('asrLogprobThreshold', value)}
                      range={AI_MODEL_ASR_PROFILE_DECODING_RANGES.logprobThreshold}
                    />
                    <RangedNumberField
                      id={`${uid}-asr-no-repeat-ngram-size`}
                      label="No-repeat n-gram size"
                      value={values.asrNoRepeatNgramSize}
                      onChange={(value) => set('asrNoRepeatNgramSize', value)}
                      range={AI_MODEL_ASR_PROFILE_DECODING_RANGES.noRepeatNgramSize}
                    />
                    <RangedNumberField
                      id={`${uid}-asr-prev-text-context-words`}
                      label="Previous-text context words"
                      value={values.asrPrevTextContextWords}
                      onChange={(value) => set('asrPrevTextContextWords', value)}
                      range={AI_MODEL_ASR_PROFILE_DECODING_RANGES.prevTextContextWords}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                    <div className="flex flex-col">
                      <Label htmlFor={`${uid}-asr-condition-on-prev-tokens`}>Condition on previous tokens</Label>
                      <span className="text-muted-foreground text-xs">Feed the previous window&apos;s tokens to the decoder as context.</span>
                    </div>
                    <Switch
                      id={`${uid}-asr-condition-on-prev-tokens`}
                      checked={values.asrConditionOnPrevTokens}
                      onCheckedChange={(checked) => set('asrConditionOnPrevTokens', checked)}
                    />
                  </div>
                  <Field id={`${uid}-asr-hotwords`} label={`Hotwords (comma-separated, max ${AI_MODEL_ASR_PROFILE_HOTWORDS_MAX_ITEMS})`}>
                    <Input
                      id={`${uid}-asr-hotwords`}
                      value={values.asrHotwords}
                      onChange={(event) => set('asrHotwords', event.target.value)}
                      placeholder="sephotrioxone, imoxicillin"
                    />
                  </Field>
                  <Field id={`${uid}-asr-initial-prompt`} label="Initial prompt">
                    <Textarea
                      id={`${uid}-asr-initial-prompt`}
                      value={values.asrInitialPrompt}
                      onChange={(event) => set('asrInitialPrompt', event.target.value)}
                      rows={2}
                      maxLength={AI_MODEL_ASR_PROFILE_INITIAL_PROMPT_MAX_LENGTH}
                      placeholder="Clinical consultation between a clinician and a patient. English and Malayalam medical terminology."
                    />
                  </Field>
                </fieldset>
              ) : null}
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
