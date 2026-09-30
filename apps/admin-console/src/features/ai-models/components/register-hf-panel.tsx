'use client';

import { useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { GatewayError } from '@/shared/api';
import { formatBytes } from '@/shared/format';
import { gatewayErrorCode } from '../api/errors';
import { HF_REPO_ID_PATTERN, useHubPreview, useRegisterFromHub } from '../api/hooks';
import { HF_TOKEN_REQUIRED, SERVED_BY_REQUIRED, type HubPreview, type RegisterFromHubRequest } from '../api/types';
import { humanizeEnum, SERVED_BY_OPTIONS } from './model-meta';
import { AUTO, AdvancedDisclosure, Field, ModelSummaryCard, PREVIEW_DEBOUNCE_MS, SummarySkeleton, useDebouncedValue } from './register-parts';

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

function HubSummary({ preview }: { preview: HubPreview }) {
  return (
    <ModelSummaryCard
      title={
        <>
          <span className="font-mono">{preview.repoId}</span>
          {preview.gated ? <Badge variant="outline">Gated</Badge> : null}
        </>
      }
      rows={[
        { label: 'Task', value: preview.taskType ? humanizeEnum(preview.taskType.replaceAll('-', '_')) : '—' },
        { label: 'Library', value: <span className="font-mono">{preview.libraryName ?? '—'}</span> },
        { label: 'Format', value: preview.suggestedFormat ? humanizeEnum(preview.suggestedFormat) : '—' },
        { label: 'Served by', value: preview.suggestedServedBy ?? 'Chosen by the platform' },
        {
          label: 'Size',
          value: `${preview.totalBytes != null ? formatBytes(preview.totalBytes) : 'Unknown'} · ${preview.fileCount} ${preview.fileCount === 1 ? 'file' : 'files'}`,
        },
        { label: 'Licence', value: <span className="font-mono">{preview.license ?? '—'}</span> },
        { label: 'Pinned revision', value: <span className="font-mono">{preview.revision} ({preview.commitSha.slice(0, 8)})</span> },
      ]}
    />
  );
}

/** Everything the Hugging Face tab needs — hoisted into the sheet so its footer can submit. */
export function useHfRegistration(open: boolean, onRegistered: () => void) {
  const [repoId, setRepoId] = useState('');
  const [revision, setRevision] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [servedBy, setServedBy] = useState(AUTO);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [servedByRequired, setServedByRequired] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const mutation = useRegisterFromHub();

  const debouncedRepoId = useDebouncedValue(repoId.trim(), PREVIEW_DEBOUNCE_MS);
  const debouncedRevision = useDebouncedValue(revision.trim(), PREVIEW_DEBOUNCE_MS);
  const preview = useHubPreview(debouncedRepoId, debouncedRevision, open);
  const previewData = preview.data;
  const typedMatchesPreview = repoId.trim() === debouncedRepoId && revision.trim() === debouncedRevision;
  const previewing = HF_REPO_ID_PATTERN.test(repoId.trim()) && (!typedMatchesPreview || preview.isFetching);

  // Open Advanced during render (never in an effect) when a NEW preview says the platform cannot pick a workload.
  const seedKey = previewData ? `${previewData.repoId}@${previewData.commitSha}` : null;
  if (seedKey !== seededFor) {
    setSeededFor(seedKey);
    if (previewData && previewData.suggestedServedBy === null) setAdvancedOpen(true);
  }

  const canSubmit = previewData !== undefined && typedMatchesPreview;
  const disabledReason = mutation.isPending
    ? null
    : !HF_REPO_ID_PATTERN.test(repoId.trim())
      ? 'Enter a Hugging Face repo id like org/name.'
      : !canSubmit
        ? previewing
          ? 'Reading the repository…'
          : preview.error
            ? 'Resolve the repository error above first.'
            : 'Waiting for the repository details.'
        : null;

  function submit() {
    if (!previewData || !canSubmit) return;
    // Only what the admin changed: an untouched form registers with the repo id alone.
    const body: RegisterFromHubRequest = {
      repoId: previewData.repoId,
      ...(revision.trim() ? { revision: revision.trim() } : {}),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      ...(servedBy !== AUTO ? { servedBy } : {}),
    };
    mutation.mutate(body, {
      onSuccess: (result) => {
        toast.success(`${result.model.name} registered — downloading ${previewData.repoId} to the bucket`);
        onRegistered();
      },
      onError: (error) => {
        if (error instanceof GatewayError && error.status === 409) {
          toast.error(`The slug “${body.slug ?? previewData.suggestedSlug}” is already taken — choose another under Advanced.`);
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
    setRepoId('');
    setRevision('');
    setName('');
    setSlug('');
    setServedBy(AUTO);
    setAdvancedOpen(false);
    setServedByRequired(false);
    setSeededFor(null);
  }

  return {
    repoId,
    setRepoId,
    revision,
    setRevision,
    name,
    setName,
    slug,
    setSlug,
    servedBy,
    setServedBy: (next: string) => {
      setServedBy(next);
      if (next !== AUTO) setServedByRequired(false);
    },
    advancedOpen,
    setAdvancedOpen,
    servedByRequired,
    preview,
    previewData,
    previewing,
    typedMatchesPreview,
    isPending: mutation.isPending,
    disabledReason,
    submit,
    reset,
  };
}

export type HfRegistration = ReturnType<typeof useHfRegistration>;

export function RegisterHfPanel({ hf, formId }: { hf: HfRegistration; formId: string }) {
  const uid = useId();
  const servedByNeeded = hf.servedByRequired || hf.previewData?.suggestedServedBy === null;
  return (
    <form
      id={formId}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        hf.submit();
      }}
      className="flex flex-col gap-4"
    >
      <Field
        id={`${uid}-repo`}
        label="Repository id"
        hint={
          <>
            The Hub path, for example <span className="font-mono">openai/whisper-large-v3</span>.
          </>
        }
      >
        <Input
          id={`${uid}-repo`}
          value={hf.repoId}
          onChange={(event) => hf.setRepoId(event.target.value)}
          className="font-mono"
          placeholder="org/model-name"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <div aria-live="polite">
        {hf.previewing ? (
          <SummarySkeleton label="Loading Hugging Face preview" />
        ) : hf.preview.error && hf.typedMatchesPreview ? (
          <PreviewError error={hf.preview.error} />
        ) : hf.previewData && hf.typedMatchesPreview ? (
          <HubSummary preview={hf.previewData} />
        ) : null}
      </div>

      {hf.previewData && hf.typedMatchesPreview ? (
        <AdvancedDisclosure open={hf.advancedOpen} onOpenChange={hf.setAdvancedOpen}>
          <Field id={`${uid}-revision`} label="Revision" hint="Leave empty for the repository’s default branch.">
            <Input id={`${uid}-revision`} value={hf.revision} onChange={(event) => hf.setRevision(event.target.value)} className="font-mono" placeholder="main" autoComplete="off" spellCheck={false} />
          </Field>
          <Field id={`${uid}-name`} label="Name" hint="Leave empty to use the suggested name.">
            <Input id={`${uid}-name`} value={hf.name} onChange={(event) => hf.setName(event.target.value)} placeholder={hf.previewData.suggestedName} />
          </Field>
          <Field id={`${uid}-slug`} label="Slug" hint="Leave empty to use the suggested slug.">
            <Input id={`${uid}-slug`} value={hf.slug} onChange={(event) => hf.setSlug(event.target.value)} className="font-mono" placeholder={hf.previewData.suggestedSlug} />
          </Field>
          <Field id={`${uid}-served-by`} label="Served by">
            <Select value={hf.servedBy} onValueChange={hf.setServedBy}>
              <SelectTrigger id={`${uid}-served-by`} className="w-full" aria-invalid={servedByNeeded && hf.servedBy === AUTO}>
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
            {hf.servedByRequired && hf.servedBy === AUTO ? (
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
