'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { GatewayError } from '@/shared/api';
import { BucketPathPicker } from '@/shared/bucket-path-picker/bucket-path-picker';
import { formatBytes } from '@/shared/format';
import { gatewayErrorCode } from '../api/errors';
import { useLastInventoryReport, useLocalPreview, useRegisterFromPath } from '../api/hooks';
import { PATH_EMPTY, PATH_INVALID, SERVED_BY_REQUIRED, type LocalModelPreview, type RegisterFromPathRequest } from '../api/types';
import { FORMAT_OPTIONS, HOPE_MODELS_BUCKET, HOPE_MODELS_MOUNT, LIBRARY_OPTIONS, MODEL_TASK_TYPE_OPTIONS, SERVED_BY_OPTIONS, humanizeEnum, taskTypeToPipelineTag } from './model-meta';
import { AUTO, AdvancedDisclosure, Field, ModelSummaryCard, SummarySkeleton } from './register-parts';

/** Where the services will read the selected path — the mount, never a value the admin types. */
export function mountedPath(path: string): string {
  return `${HOPE_MODELS_MOUNT}/${path.replace(/^\/+/, '')}`;
}

function PathError({ error }: { error: unknown }) {
  const status = error instanceof GatewayError ? error.status : undefined;
  const code = gatewayErrorCode(error);
  const message =
    code === PATH_INVALID || status === 400
      ? 'That path is not valid inside the model bucket.'
      : code === PATH_EMPTY || status === 404
        ? 'That path holds no model files. Pick a folder or file that contains the weights.'
        : error instanceof Error
          ? error.message
          : 'Could not read that path.';
  return (
    <p role="alert" className="text-destructive text-sm">
      {message}
    </p>
  );
}

function LocalSummary({ preview }: { preview: LocalModelPreview }) {
  const { suggested } = preview;
  return (
    <ModelSummaryCard
      title={
        <>
          <span>{suggested.name}</span>
          <Badge variant="outline">{preview.layout}</Badge>
        </>
      }
      rows={[
        { label: 'Task', value: suggested.taskType ? humanizeEnum(suggested.taskType) : '—' },
        { label: 'Library', value: <span className="font-mono">{suggested.libraryName ?? '—'}</span> },
        { label: 'Format', value: suggested.format ? humanizeEnum(suggested.format) : '—' },
        { label: 'Served by', value: suggested.servedBy ?? 'Not detected — choose one under Advanced' },
        { label: 'Size', value: `${formatBytes(preview.totalBytes)} · ${preview.files.length} ${preview.files.length === 1 ? 'file' : 'files'}` },
        { label: 'Loaded from', value: <span className="font-mono">{preview.localPath}</span> },
      ]}
    />
  );
}

/** Everything the Local path tab needs — hoisted into the sheet so its footer can submit. */
export function useLocalRegistration(open: boolean, initialPath: string, onRegistered: () => void) {
  const [path, setPath] = useState(initialPath);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [taskType, setTaskType] = useState(AUTO);
  const [libraryName, setLibraryName] = useState(AUTO);
  const [format, setFormat] = useState(AUTO);
  const [servedBy, setServedBy] = useState(AUTO);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [servedByRequired, setServedByRequired] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const mutation = useRegisterFromPath();
  const inventory = useLastInventoryReport();
  const preview = useLocalPreview(path, open);
  const previewData = preview.data;

  // Open Advanced during render when a NEW preview detected no serving workload.
  const seedKey = previewData ? previewData.bucketPrefix + (previewData.primaryObject ?? '') : null;
  if (seedKey !== seededFor) {
    setSeededFor(seedKey);
    if (previewData && !previewData.suggested.servedBy) setAdvancedOpen(true);
  }

  const canSubmit = previewData !== undefined && !preview.isFetching;
  const disabledReason = mutation.isPending
    ? null
    : path === ''
      ? 'Pick a folder or file in the model bucket.'
      : !canSubmit
        ? preview.error
          ? 'Resolve the path error above first.'
          : 'Reading the path…'
        : null;

  function selectPath(next: string) {
    setPath(next);
    setServedByRequired(false);
  }

  function submit() {
    if (!previewData || !canSubmit) return;
    const body: RegisterFromPathRequest = {
      path,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      ...(taskType !== AUTO ? { taskType } : {}),
      ...(libraryName !== AUTO ? { libraryName } : {}),
      ...(format !== AUTO ? { format } : {}),
      ...(servedBy !== AUTO ? { servedBy } : {}),
    };
    mutation.mutate(body, {
      onSuccess: (model) => {
        toast.success(`${model.name} registered from ${mountedPath(path)}`);
        onRegistered();
      },
      onError: (error) => {
        if (error instanceof GatewayError && error.status === 409) {
          toast.error(`The slug “${body.slug ?? previewData.suggested.slug}” is already taken — choose another under Advanced.`);
          setAdvancedOpen(true);
        } else if (gatewayErrorCode(error) === SERVED_BY_REQUIRED) {
          setServedByRequired(true);
          setAdvancedOpen(true);
        } else {
          toast.error(error.message);
        }
      },
    });
  }

  function reset() {
    mutation.reset();
    setPath('');
    setName('');
    setSlug('');
    setTaskType(AUTO);
    setLibraryName(AUTO);
    setFormat(AUTO);
    setServedBy(AUTO);
    setAdvancedOpen(false);
    setServedByRequired(false);
    setSeededFor(null);
  }

  return {
    path,
    selectPath,
    name,
    setName,
    slug,
    setSlug,
    taskType,
    setTaskType,
    libraryName,
    setLibraryName,
    format,
    setFormat,
    servedBy,
    setServedBy: (next: string) => {
      setServedBy(next);
      if (next !== AUTO) setServedByRequired(false);
    },
    advancedOpen,
    setAdvancedOpen,
    servedByRequired,
    suggestions: inventory.data?.unregistered ?? [],
    preview,
    previewData,
    isPending: mutation.isPending,
    disabledReason,
    submit,
    reset,
  };
}

export type LocalRegistration = ReturnType<typeof useLocalRegistration>;

function AutoSelect({ id, value, onValueChange, autoLabel, options, format }: { id: string; value: string; onValueChange: (next: string) => void; autoLabel: string; options: readonly string[]; format?: (option: string) => string }) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO}>{autoLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {format ? format(option) : option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function RegisterLocalPanel({ local, formId }: { local: LocalRegistration; formId: string }) {
  const uid = useId();
  return (
    <form
      id={formId}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        local.submit();
      }}
      className="flex flex-col gap-4"
    >
      {local.suggestions.length > 0 ? (
        <section aria-labelledby={`${uid}-suggestions`} className="flex flex-col gap-2">
          <h3 id={`${uid}-suggestions`} className="text-sm font-medium">
            In the bucket, not registered
          </h3>
          <ul className="flex flex-wrap gap-2">
            {local.suggestions.map((suggestion) => (
              <li key={suggestion.bucketPrefix}>
                <Button
                  type="button"
                  variant={local.path === suggestion.bucketPrefix ? 'secondary' : 'outline'}
                  size="sm"
                  className="font-mono text-xs"
                  aria-pressed={local.path === suggestion.bucketPrefix}
                  onClick={() => local.selectPath(suggestion.bucketPrefix)}
                >
                  {suggestion.slug ?? suggestion.bucketPrefix}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby={`${uid}-picker`} className="flex flex-col gap-2">
        <h3 id={`${uid}-picker`} className="text-sm font-medium">
          Model bucket
        </h3>
        <BucketPathPicker bucket={HOPE_MODELS_BUCKET} value={local.path} onChange={local.selectPath} />
      </section>

      <div aria-live="polite" className="flex flex-col gap-2">
        {local.path ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Selected: </span>
            <span className="font-mono break-all">{mountedPath(local.path)}</span>
          </p>
        ) : null}
        {local.path && (local.preview.isFetching && !local.previewData ? <SummarySkeleton label="Reading the selected path" /> : null)}
        {local.path && local.preview.error ? <PathError error={local.preview.error} /> : null}
        {local.path && local.previewData && !local.preview.error ? <LocalSummary preview={local.previewData} /> : null}
      </div>

      {local.previewData && !local.preview.error ? (
        <AdvancedDisclosure open={local.advancedOpen} onOpenChange={local.setAdvancedOpen}>
          <Field id={`${uid}-name`} label="Name" hint="Leave empty to use the suggested name.">
            <Input id={`${uid}-name`} value={local.name} onChange={(event) => local.setName(event.target.value)} placeholder={local.previewData.suggested.name} />
          </Field>
          <Field id={`${uid}-slug`} label="Slug" hint="Leave empty to use the suggested slug.">
            <Input id={`${uid}-slug`} value={local.slug} onChange={(event) => local.setSlug(event.target.value)} className="font-mono" placeholder={local.previewData.suggested.slug} />
          </Field>
          <Field id={`${uid}-task`} label="Task">
            <AutoSelect id={`${uid}-task`} value={local.taskType} onValueChange={local.setTaskType} autoLabel="Detect automatically" options={MODEL_TASK_TYPE_OPTIONS} format={taskTypeToPipelineTag} />
          </Field>
          <Field id={`${uid}-library`} label="Library">
            <AutoSelect id={`${uid}-library`} value={local.libraryName} onValueChange={local.setLibraryName} autoLabel="Detect automatically" options={LIBRARY_OPTIONS} />
          </Field>
          <Field id={`${uid}-format`} label="Format">
            <AutoSelect id={`${uid}-format`} value={local.format} onValueChange={local.setFormat} autoLabel="Detect automatically" options={FORMAT_OPTIONS} format={humanizeEnum} />
          </Field>
          <Field id={`${uid}-served-by`} label="Served by">
            <AutoSelect id={`${uid}-served-by`} value={local.servedBy} onValueChange={local.setServedBy} autoLabel="Choose for me" options={SERVED_BY_OPTIONS} />
            {local.servedByRequired && local.servedBy === AUTO ? (
              <p role="alert" className="text-destructive text-sm">
                The platform could not pick a service for this model. Choose which service it is served by, then register again.
              </p>
            ) : null}
          </Field>
        </AdvancedDisclosure>
      ) : null}
    </form>
  );
}
