'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useModel, useUpdateModel } from '../api/hooks';
import { editLockReason } from '../api/lifecycle';
import { ASR_TASK_TYPE, type AiModel, type UpdateModelRequest } from '../api/types';
import { AsrDefaultsFields, asrValuesFromProfile, hasAsrValidationError, toAsrProfileRequest, type AsrValues } from './asr-defaults-fields';
import { ModelDownloadPanel } from './model-download';
import { DEPLOYMENT_KIND_LABELS, SOURCE_LABELS, humanizeEnum, taskTypeToPipelineTag } from './model-meta';
import { ModelStatusSection } from './model-status-section';
import { Field } from './register-parts';

interface EditValues {
  name: string;
  description: string;
  tags: string;
  vramGiB: string;
  maxNumSeqs: string;
  enforceEager: boolean;
  asr: AsrValues;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toValues(model?: AiModel): EditValues {
  return {
    name: model?.name ?? '',
    description: model?.description ?? '',
    tags: model?.tags.join(', ') ?? '',
    vramGiB: model?.servingFacts?.vramGiB != null ? String(model.servingFacts.vramGiB) : '',
    maxNumSeqs: model?.servingFacts?.maxNumSeqs != null ? String(model.servingFacts.maxNumSeqs) : '',
    enforceEager: model?.servingFacts?.enforceEager ?? false,
    asr: asrValuesFromProfile(model?.asrProfile),
  };
}

function servingChanged(values: EditValues, baseline: EditValues): boolean {
  return values.vramGiB !== baseline.vramGiB || values.maxNumSeqs !== baseline.maxNumSeqs || values.enforceEager !== baseline.enforceEager;
}

/** Why the serving facts cannot be saved, or `null` — mirrors `ModelServingFactsRequest` (vramGiB > 0, maxNumSeqs a whole number >= 1). */
function vramError(values: EditValues, baseline: EditValues): string | null {
  if (!servingChanged(values, baseline)) return null;
  const vram = Number(values.vramGiB);
  if (!values.vramGiB.trim() || Number.isNaN(vram) || vram <= 0) return 'VRAM must be a number greater than 0.';
  return null;
}

function maxSeqsError(values: EditValues, baseline: EditValues): string | null {
  if (!servingChanged(values, baseline) || !values.maxNumSeqs.trim()) return null;
  const seqs = Number(values.maxNumSeqs);
  return Number.isInteger(seqs) && seqs >= 1 ? null : 'Concurrent sequences must be a whole number of at least 1.';
}

/** Only what changed — an edit never re-sends the fields it did not touch. */
function toPatch(values: EditValues, baseline: EditValues, isAsr: boolean): UpdateModelRequest {
  const patch: UpdateModelRequest = {};
  if (values.name.trim() !== baseline.name.trim()) patch.name = values.name.trim();
  // An empty string clears the nullable description (the DTO's documented semantics).
  if (values.description.trim() !== baseline.description.trim()) patch.description = values.description.trim();
  if (values.tags.trim() !== baseline.tags.trim()) patch.tags = splitList(values.tags);
  if (servingChanged(values, baseline)) {
    patch.serving = {
      vramGiB: Number(values.vramGiB),
      ...(values.maxNumSeqs.trim() ? { maxNumSeqs: Number(values.maxNumSeqs) } : {}),
      ...(values.enforceEager || baseline.enforceEager ? { enforceEager: values.enforceEager } : {}),
    };
  }
  // ASR-only: a blanked section clears the stored profile (`null`); omitted for a non-ASR row (the gateway 400s it).
  if (isAsr && JSON.stringify(values.asr) !== JSON.stringify(baseline.asr)) patch.asrProfile = toAsrProfileRequest(values.asr);
  return patch;
}

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/** Skeleton mirroring the form layout while the edited row loads (rule 10). */
function EditSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function IdentityRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="col-span-2 grid grid-cols-subgrid">
      <dt className="font-medium">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Everything the registration derived, shown but not editable — change it by re-registering. */
function IdentitySummary({ model }: { model: AiModel }) {
  const mono = (value: ReactNode) => <span className="font-mono">{value}</span>;
  return (
    <div role="group" aria-label="Identity and classification" className="flex flex-col gap-2 rounded-md border p-3">
      <h3 className="text-sm font-medium">Identity and classification</h3>
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <IdentityRow label="Slug">{mono(model.slug)}</IdentityRow>
        <IdentityRow label="Source">{SOURCE_LABELS[model.source] ?? model.source}</IdentityRow>
        <IdentityRow label="Source URI">{mono(model.sourceUri)}</IdentityRow>
        <IdentityRow label="Revision">{mono(model.sourceRevision ?? model.hfRevision ?? '—')}</IdentityRow>
        <IdentityRow label="Task">{taskTypeToPipelineTag(model.taskType)}</IdentityRow>
        <IdentityRow label="Library">{mono(model.libraryName)}</IdentityRow>
        <IdentityRow label="Format">{humanizeEnum(model.format)}</IdentityRow>
        <IdentityRow label="Served by">{mono(model.servedBy)}</IdentityRow>
        <IdentityRow label="Deployment">
          {DEPLOYMENT_KIND_LABELS[model.deploymentKind]}
          {model.wireModelId ? <> · {mono(model.wireModelId)}</> : null}
        </IdentityRow>
        <IdentityRow label="Bucket prefix">{model.bucketPrefix ? mono(model.bucketPrefix) : '—'}</IdentityRow>
        <IdentityRow label="Loaded from">{model.localPath ? mono(model.localPath) : '—'}</IdentityRow>
        <IdentityRow label="Licence">
          {mono(model.license ?? '—')} {model.gated ? <Badge variant="outline">Gated</Badge> : null}
        </IdentityRow>
        <IdentityRow label="Languages">{model.languages.length > 0 ? model.languages.join(', ') : '—'}</IdentityRow>
      </dl>
    </div>
  );
}

/** Wraps a tab's fields; only the active tab's form is mounted, so the footer's `form={formId}` always finds exactly one. */
function SaveForm({ id, onSubmit, locked, children }: { id: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; locked: boolean; children: ReactNode }) {
  return (
    <form id={id} onSubmit={onSubmit}>
      {/* A disabled fieldset disables every native control inside it. */}
      <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        {children}
      </fieldset>
    </form>
  );
}

type EditTab = 'details' | 'serving' | 'defaults';

/**
 * The EDIT-ONLY model drawer (TASK-1023): Name, Description and Tags are the only free fields on Details; identity and
 * classification are read-only (they were derived when the model was registered). Serving holds the engine sizing facts,
 * and "Advanced defaults" the ASR decode profile (ASR models only). Edits are saved with optimistic concurrency
 * (If-Match); a 412 surfaces the OCC alert, and the form is read-only while a download or unregister is in flight.
 */
export function ModelEditSheet({ open, onOpenChange, modelId }: { open: boolean; onOpenChange: (open: boolean) => void; modelId: string | null }) {
  const uid = useId();
  const formId = `${uid}-form`;
  const noticeId = `${uid}-notice`;
  const detail = useModel(modelId ?? '');
  const model = detail.data?.data ?? null;
  const etag = detail.data?.etag ?? '';
  const updateMutation = useUpdateModel();

  const [tab, setTab] = useState<EditTab>('details');
  const [values, setValues] = useState<EditValues>(() => toValues());
  const [baseline, setBaseline] = useState<EditValues>(() => toValues());
  const [seededFor, setSeededFor] = useState('closed');
  const [discarding, setDiscarding] = useState(false);

  // Seed during render (never in an effect). While the row is DOWNLOADING / UNREGISTERING the form is read-only and the
  // seed key follows each re-read, so the re-enabled form is seeded from the SETTLED row rather than a stale snapshot.
  const editLock = model ? editLockReason(model.lifecycle?.status) : null;
  const seedKey = !open ? 'closed' : model ? `row:${model.id}${editLock ? `:locked:${etag}` : ''}` : 'pending';
  if (seedKey !== seededFor) {
    const seeded = seedKey.startsWith('row:') && model ? toValues(model) : toValues();
    setSeededFor(seedKey);
    setValues(seeded);
    setBaseline(seeded);
  }

  const isAsr = model?.taskType === ASR_TASK_TYPE;
  const showForm = !detail.isPending && !detail.error && model !== null;
  const activeTab: EditTab = tab === 'defaults' && !isAsr ? 'details' : tab;
  const patch = toPatch(values, baseline, isAsr);
  const isDirty = Object.keys(patch).length > 0;
  const servingErr = vramError(values, baseline);
  const seqsErr = maxSeqsError(values, baseline);
  const invalid = values.name.trim() === '' || servingErr !== null || seqsErr !== null || (isAsr && hasAsrValidationError(values.asr));
  const isPending = updateMutation.isPending;
  const notice = editLock ?? (!isDirty ? 'No changes to save.' : null);

  function set<K extends keyof EditValues>(key: K, value: EditValues[K]) {
    // The fieldset disables native controls, but a Radix widget can still fire — a locked form ignores every change at the source.
    if (editLock) return;
    setValues((current) => ({ ...current, [key]: value }));
  }

  function setAsr<K extends keyof AsrValues>(key: K, value: AsrValues[K]) {
    if (editLock) return;
    setValues((current) => ({ ...current, asr: { ...current.asr, [key]: value } }));
  }

  function close() {
    setDiscarding(false);
    updateMutation.reset();
    setTab('details');
    onOpenChange(false);
  }

  /** Esc / overlay / Cancel — never discards unsaved edits without asking. */
  function handleOpenChange(next: boolean) {
    if (next) return onOpenChange(true);
    if (isPending) return;
    if (isDirty) return setDiscarding(true);
    close();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!model || editLock || !isDirty || invalid) return;
    updateMutation.mutate(
      { id: model.id, patch, etag },
      {
        onSuccess: () => {
          toast.success('Model updated');
          close();
        },
        // OCC conflicts render the inline alert instead.
        onError: (error) => {
          if (!isOccError(error)) toast.error(error.message);
        },
      },
    );
  }

  const tabs = (
    <TabsList variant="line" className="mt-1">
      <TabsTrigger value="details">Details</TabsTrigger>
      <TabsTrigger value="serving">Serving</TabsTrigger>
      {isAsr ? <TabsTrigger value="defaults">Advanced defaults</TabsTrigger> : null}
    </TabsList>
  );

  return (
    <>
      <Tabs value={activeTab} onValueChange={(next) => setTab(next as EditTab)} className="contents">
        <DetailDrawer
          closeBlockedReason={isPending ? 'Saving the model — wait for it to finish.' : undefined}
          open={open}
          onOpenChange={handleOpenChange}
          title="Edit model"
          meta={
            <>
              <span>Changes are saved with optimistic concurrency (If-Match).</span>
              {model ? (
                <>
                  <span className="font-mono">{model.id}</span>
                  <CopyButton value={model.id} label="Copy model id" />
                </>
              ) : null}
            </>
          }
          tabs={showForm ? tabs : undefined}
          footer={
            showForm ? (
              <div className="flex w-full flex-col gap-2">
                <OccConflictAlert error={updateMutation.error} onReload={() => { updateMutation.reset(); void detail.refetch(); }} />
                {notice ? (
                  <p id={noticeId} role="status" className="text-muted-foreground text-sm">
                    {notice}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
                    Cancel
                  </Button>
                  <Button type="submit" form={formId} disabled={isPending || invalid || notice !== null} aria-describedby={notice ? noticeId : undefined}>
                    {isPending ? <Spinner /> : null}
                    Save changes
                  </Button>
                </div>
              </div>
            ) : null
          }
        >
          {!open ? null : detail.isPending ? (
            <EditSkeleton />
          ) : !showForm ? (
            <ErrorState error={detail.error ?? new GatewayError(404, 'This model does not exist or is outside your access scope.')} onRetry={() => void detail.refetch()} />
          ) : (
            <>
              <TabsContent value="details" className="flex flex-col gap-4">
                <SaveForm id={formId} onSubmit={handleSubmit} locked={editLock !== null}>
                  <Field id={`${uid}-name`} label="Name" required>
                    <Input id={`${uid}-name`} value={values.name} onChange={(event) => set('name', event.target.value)} required />
                  </Field>
                  <Field id={`${uid}-description`} label="Description">
                    <Textarea id={`${uid}-description`} value={values.description} onChange={(event) => set('description', event.target.value)} rows={2} />
                  </Field>
                  <Field id={`${uid}-tags`} label="Tags (comma-separated)">
                    <Input id={`${uid}-tags`} value={values.tags} onChange={(event) => set('tags', event.target.value)} placeholder="stt, fallback" />
                  </Field>
                </SaveForm>
                <IdentitySummary model={model} />
                <ModelStatusSection model={model} />
                <ModelDownloadPanel model={model} />
              </TabsContent>
              <TabsContent value="serving">
                <SaveForm id={formId} onSubmit={handleSubmit} locked={editLock !== null}>
                  <p className="text-muted-foreground text-xs">
                    Engine sizing for a vLLM-served model. Saving merges these facts into the stored ones; a field left blank keeps its value.
                  </p>
                  {model.servingFacts?.derived ? (
                    <div>
                      <Badge variant="secondary" title="The platform estimated these facts; saving your own replaces them.">
                        Estimated
                      </Badge>
                    </div>
                  ) : null}
                  <Field id={`${uid}-vram`} label="VRAM (GiB)" hint="GPU memory one engine of this model claims.">
                    <Input
                      id={`${uid}-vram`}
                      type="number"
                      min={0}
                      step="any"
                      value={values.vramGiB}
                      onChange={(event) => set('vramGiB', event.target.value)}
                      aria-invalid={servingErr ? true : undefined}
                      aria-describedby={servingErr ? `${uid}-vram-error` : undefined}
                    />
                    {servingErr ? (
                      <p id={`${uid}-vram-error`} className="text-destructive text-sm">
                        {servingErr}
                      </p>
                    ) : null}
                  </Field>
                  <Field id={`${uid}-seqs`} label="Max concurrent sequences" hint="vLLM max_num_seqs. Leave blank for the engine default.">
                    <Input
                      id={`${uid}-seqs`}
                      type="number"
                      min={1}
                      step={1}
                      value={values.maxNumSeqs}
                      onChange={(event) => set('maxNumSeqs', event.target.value)}
                      aria-invalid={seqsErr ? true : undefined}
                      aria-describedby={seqsErr ? `${uid}-seqs-error` : undefined}
                    />
                    {seqsErr ? (
                      <p id={`${uid}-seqs-error`} className="text-destructive text-sm">
                        {seqsErr}
                      </p>
                    ) : null}
                  </Field>
                  <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                    <div className="flex flex-col">
                      <Label htmlFor={`${uid}-eager`}>Enforce eager</Label>
                      <span className="text-muted-foreground text-xs">Disable CUDA graphs: less VRAM, slower.</span>
                    </div>
                    <Switch id={`${uid}-eager`} checked={values.enforceEager} onCheckedChange={(checked) => set('enforceEager', checked)} />
                  </div>
                </SaveForm>
              </TabsContent>
              {isAsr ? (
                <TabsContent value="defaults">
                  <SaveForm id={formId} onSubmit={handleSubmit} locked={editLock !== null}>
                    <AsrDefaultsFields uid={uid} values={values.asr} onChange={setAsr} />
                  </SaveForm>
                </TabsContent>
              ) : null}
            </>
          )}
        </DetailDrawer>
      </Tabs>
      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title="Discard unsaved changes?"
        description="This drawer has edits that have not been saved. Closing it discards them."
        confirmLabel="Discard changes"
        destructive
        onConfirm={close}
      />
    </>
  );
}
