'use client';

import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { cx } from '@/shared/cx';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatBytes } from '@/shared/format';
import { gatewayErrorCode } from '../api/errors';
import { HF_REPO_ID_PATTERN, useHubPreview, useRegisterFromHub } from '../api/hooks';
import { HF_TOKEN_REQUIRED, type AiModelFormat, type HubPreview, type RegisterFromHubRequest } from '../api/types';
import { FORMAT_OPTIONS, MODEL_TASK_TYPE_OPTIONS, SERVED_BY_OPTIONS, humanizeEnum, taskTypeToPipelineTag } from './model-meta';

/** How long typing must pause before the Hub is asked (the preview is a network round-trip to huggingface.co). */
export const PREVIEW_DEBOUNCE_MS = 300;

/** Radix SelectItem forbids the empty string; sentinel for "let the gateway decide". */
const AUTO = 'auto';

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** The Hub may hand back a kebab-case `pipeline_tag`; the registry speaks the SCREAMING_SNAKE enum. */
function normalizeTaskType(taskType: string | null): string {
  return taskType ? taskType.trim().replaceAll('-', '_').toUpperCase() : '';
}

interface FormValues {
  name: string;
  slug: string;
  taskType: string;
  format: string;
  servedBy: string;
  computeType: string;
}

const EMPTY: FormValues = { name: '', slug: '', taskType: '', format: AUTO, servedBy: AUTO, computeType: '' };

function fromPreview(preview: HubPreview): FormValues {
  return {
    name: preview.suggestedName,
    slug: preview.suggestedSlug,
    taskType: normalizeTaskType(preview.taskType),
    format: preview.suggestedFormat ?? AUTO,
    servedBy: AUTO,
    computeType: '',
  };
}

function Field({ id, label, required, className, children }: { id: string; label: string; required?: boolean; className?: string; children: ReactNode }) {
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

function PreviewSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border p-3" aria-label="Loading Hugging Face preview">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

function PreviewError({ error }: { error: unknown }) {
  const status = error instanceof GatewayError ? error.status : undefined;
  if (status === 422 && (gatewayErrorCode(error) === HF_TOKEN_REQUIRED || /token/i.test((error as Error).message))) {
    return (
      <p role="alert" className="text-destructive text-sm">
        This repository is gated or private and the platform has no Hugging Face token.{' '}
        <Link href="/ai-providers" className="text-foreground underline underline-offset-4">
          Configure the Hugging Face token in AI providers
        </Link>
        , then try again.
      </p>
    );
  }
  if (status === 404) {
    return (
      <p role="alert" className="text-destructive text-sm">
        No Hugging Face repository with that id (or revision) exists.
      </p>
    );
  }
  return (
    <p role="alert" className="text-destructive text-sm">
      {error instanceof Error ? error.message : 'Could not read the Hugging Face repository.'}
    </p>
  );
}

function PreviewCard({ preview }: { preview: HubPreview }) {
  return (
    <div role="group" className="flex flex-col gap-2 rounded-md border p-3" aria-label="Hugging Face preview">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{preview.repoId}</span>
        {preview.gated ? <Badge variant="outline">Gated</Badge> : null}
      </div>
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="font-medium">Size</dt>
        <dd>
          {preview.totalBytes != null ? formatBytes(preview.totalBytes) : 'Unknown'} · {preview.fileCount} {preview.fileCount === 1 ? 'file' : 'files'}
        </dd>
        <dt className="font-medium">Revision</dt>
        <dd className="font-mono">
          {preview.revision} ({preview.commitSha.slice(0, 8)})
        </dd>
        <dt className="font-medium">Licence</dt>
        <dd className="font-mono">{preview.license ?? '—'}</dd>
        <dt className="font-medium">Library</dt>
        <dd className="font-mono">{preview.libraryName ?? '—'}</dd>
        <dt className="font-medium">Languages</dt>
        <dd>{preview.languages.length > 0 ? preview.languages.join(', ') : '—'}</dd>
        {preview.baseModel ? (
          <>
            <dt className="font-medium">Base model</dt>
            <dd className="font-mono">{preview.baseModel}</dd>
          </>
        ) : null}
      </dl>
      {preview.gated ? <p className="text-muted-foreground text-xs">Gated repository — the platform Hugging Face token must have been granted access.</p> : null}
    </div>
  );
}

/**
 * "Register from Hugging Face" (TASK-1019 OD-1): paste a repo id, read the Hub
 * card, adjust the prefilled identity, and register — the gateway creates the
 * catalogue row and starts publishing the weights to the bucket in one call, so
 * the new row lands on the grid already DOWNLOADING.
 */
export function RegisterFromHubSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const uid = useId();
  const formId = `${uid}-form`;
  const [repoId, setRepoId] = useState('');
  const [revision, setRevision] = useState('');
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const mutation = useRegisterFromHub();

  const debouncedRepoId = useDebouncedValue(repoId.trim(), PREVIEW_DEBOUNCE_MS);
  const debouncedRevision = useDebouncedValue(revision.trim(), PREVIEW_DEBOUNCE_MS);
  const preview = useHubPreview(debouncedRepoId, debouncedRevision, open);
  const previewData = preview.data;
  // The typed value is ahead of the debounced one for a moment — the preview on screen must not outlive it.
  const typedIdMatchesPreview = repoId.trim() === debouncedRepoId && revision.trim() === debouncedRevision;
  const previewing = HF_REPO_ID_PATTERN.test(repoId.trim()) && (!typedIdMatchesPreview || preview.isFetching);

  // Prefill during render (never in an effect) when a NEW preview arrives; edits to the same preview are kept.
  const seedKey = previewData ? `${previewData.repoId}@${previewData.commitSha}` : null;
  if (seedKey !== seededFor) {
    setSeededFor(seedKey);
    if (previewData) setValues(fromPreview(previewData));
  }

  const isPending = mutation.isPending;
  const taskTypeOptions: readonly string[] =
    values.taskType && !(MODEL_TASK_TYPE_OPTIONS as readonly string[]).includes(values.taskType) ? [values.taskType, ...MODEL_TASK_TYPE_OPTIONS] : MODEL_TASK_TYPE_OPTIONS;
  const canSubmit = previewData !== undefined && typedIdMatchesPreview && values.name.trim() !== '' && values.slug.trim() !== '';
  const disabledReason = isPending
    ? null
    : !HF_REPO_ID_PATTERN.test(repoId.trim())
      ? 'Enter a Hugging Face repo id like org/name.'
      : !canSubmit
        ? previewing
          ? 'Reading the repository…'
          : preview.error
            ? 'Resolve the repository error above first.'
            : 'Name and slug are required.'
        : null;

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function close() {
    mutation.reset();
    setRepoId('');
    setRevision('');
    setValues(EMPTY);
    setSeededFor(null);
    onOpenChange(false);
  }

  function handleOpenChange(next: boolean) {
    if (next) return onOpenChange(true);
    if (isPending) return;
    close();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!previewData || !canSubmit) return;
    const body: RegisterFromHubRequest = {
      repoId: previewData.repoId,
      // Only what the admin typed: an empty revision means the repo's default branch.
      revision: debouncedRevision || undefined,
      slug: values.slug.trim(),
      name: values.name.trim(),
      ...(values.taskType ? { taskType: values.taskType } : {}),
      ...(values.format !== AUTO ? { format: values.format as AiModelFormat } : {}),
      ...(values.servedBy !== AUTO ? { servedBy: values.servedBy } : {}),
      ...(values.computeType.trim() ? { computeType: values.computeType.trim() } : {}),
    };
    mutation.mutate(body, {
      onSuccess: (result) => {
        toast.success(`${result.model.name} registered — downloading ${previewData.repoId} to the bucket`);
        close();
      },
      onError: (error) => {
        const conflict = error instanceof GatewayError && error.status === 409;
        toast.error(conflict ? `The slug “${body.slug}” is already taken — choose another.` : error.message);
      },
    });
  }

  const reasonId = `${uid}-reason`;

  return (
    <DetailDrawer
      open={open}
      onOpenChange={handleOpenChange}
      closeBlockedReason={isPending ? 'Registering the model — wait for it to finish.' : undefined}
      size="md"
      title="Register from Hugging Face"
      meta={<span>Creates the catalogue row and downloads the weights into the model bucket.</span>}
      footer={
        <div className="flex w-full flex-col gap-2">
          {disabledReason ? (
            <p id={reasonId} className="text-muted-foreground text-xs">
              {disabledReason}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" form={formId} disabled={isPending || disabledReason !== null} aria-describedby={disabledReason ? reasonId : undefined}>
              {isPending ? <Spinner /> : null}
              Register and download
            </Button>
          </div>
        </div>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="grid auto-rows-min grid-cols-1 content-start gap-4 sm:grid-cols-2">
        <Field id={`${uid}-repo`} label="Repository id" required className="sm:col-span-2">
          <Input
            id={`${uid}-repo`}
            value={repoId}
            onChange={(event) => setRepoId(event.target.value)}
            className="font-mono"
            placeholder="org/model-name"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${uid}-repo-hint`}
          />
          <p id={`${uid}-repo-hint`} className="text-muted-foreground text-xs">
            The Hub path, for example <span className="font-mono">openai/whisper-large-v3-turbo</span>.
          </p>
        </Field>
        <Field id={`${uid}-revision`} label="Revision" className="sm:col-span-2">
          <Input
            id={`${uid}-revision`}
            value={revision}
            onChange={(event) => setRevision(event.target.value)}
            className="font-mono"
            placeholder="main"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <div className="sm:col-span-2" aria-live="polite">
          {previewing ? <PreviewSkeleton /> : preview.error && typedIdMatchesPreview ? <PreviewError error={preview.error} /> : previewData && typedIdMatchesPreview ? <PreviewCard preview={previewData} /> : null}
        </div>

        {previewData && typedIdMatchesPreview ? (
          <>
            <Field id={`${uid}-name`} label="Name" required className="sm:col-span-2">
              <Input id={`${uid}-name`} value={values.name} onChange={(event) => set('name', event.target.value)} required />
            </Field>
            <Field id={`${uid}-slug`} label="Slug" required className="sm:col-span-2">
              <Input id={`${uid}-slug`} value={values.slug} onChange={(event) => set('slug', event.target.value)} required className="font-mono" />
            </Field>
            <Field id={`${uid}-task`} label="Task (Hugging Face pipeline tag)" className="sm:col-span-2">
              <Select value={values.taskType || undefined} onValueChange={(next) => set('taskType', next)}>
                <SelectTrigger id={`${uid}-task`} className="w-full font-mono">
                  <SelectValue placeholder="Not detected — choose a task" />
                </SelectTrigger>
                <SelectContent>
                  {taskTypeOptions.map((taskType) => (
                    <SelectItem key={taskType} value={taskType} className="font-mono">
                      {taskTypeToPipelineTag(taskType)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id={`${uid}-format`} label="Format">
              <Select value={values.format} onValueChange={(next) => set('format', next)}>
                <SelectTrigger id={`${uid}-format`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>Detect automatically</SelectItem>
                  {FORMAT_OPTIONS.map((format) => (
                    <SelectItem key={format} value={format}>
                      {humanizeEnum(format)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id={`${uid}-served-by`} label="Served by">
              <Select value={values.servedBy} onValueChange={(next) => set('servedBy', next)}>
                <SelectTrigger id={`${uid}-served-by`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>Choose for me</SelectItem>
                  {SERVED_BY_OPTIONS.map((workload) => (
                    <SelectItem key={workload} value={workload}>
                      {workload}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id={`${uid}-compute`} label="Compute type" className="sm:col-span-2">
              <Input
                id={`${uid}-compute`}
                value={values.computeType}
                onChange={(event) => set('computeType', event.target.value)}
                className="font-mono"
                placeholder="f16, int8, …"
              />
            </Field>
          </>
        ) : null}
      </form>
    </DetailDrawer>
  );
}
