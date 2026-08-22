'use client';

import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { usePutTaskDefaultRow, useTaskDefaultRow, useTaskModelOptions } from '../api/hooks';
import type { AiTaskKey, TaskModelOption } from '../api/types';

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/** Options list rendered into a picker, keeping a disabled/orphan slug selectable. */
function ModelOptions({ options, orphanSlug }: { options: TaskModelOption[]; orphanSlug: string | null }) {
  return (
    <SelectContent>
      {orphanSlug ? (
        <SelectItem value={orphanSlug}>
          <span className="font-mono text-xs">{orphanSlug}</span>
          <span className="text-muted-foreground text-xs">(no longer selectable)</span>
        </SelectItem>
      ) : null}
      {options.map((option) => (
        <SelectItem key={option.id} value={option.slug}>
          <span className="font-medium">{option.name}</span>
          <span className="text-muted-foreground font-mono text-xs">{option.slug}</span>
          {option.provider ? <span className="text-muted-foreground text-xs">· {option.provider}</span> : null}
        </SelectItem>
      ))}
    </SelectContent>
  );
}

function ControlSkeleton() {
  return (
    <Card className="gap-3 p-4" aria-hidden>
      <Skeleton className="h-5 w-64 max-w-full" />
      <Skeleton className="h-4 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-9 w-44" />
      </div>
    </Card>
  );
}

/**
 * "Default text-generation provider" control (top of the text-generation tab).
 *
 * A convenience writer over the EXISTING per-key `PUT
 * admin/ai-task-defaults/row?taskKey=` endpoint: pick ONE model and apply it, in
 * a single action, to every text-generation task this tenant controls — the
 * primary live + final summaries — with an OPTIONAL matching fallback applied to
 * `text.live.fallback` + `text.finalize.fallback`.
 *
 * It reuses `usePutTaskDefaultRow` (the same OCC/If-Match path the per-key cards
 * below use) and issues the individual writes sequentially, each carrying its own
 * key's ETag. NO new task key, descriptor, or migration is introduced. The
 * per-key cards below remain the way to override a single route.
 *
 * The tenant-editable text-gen surface is exactly summarization: there is no
 * task key for grammar-fix today, and guardrail/nlp/harness selection is
 * platform-managed (surfaced read-only beneath this section).
 */
export function TextDefaultProviderControl() {
  const uid = useId();
  const liveRow = useTaskDefaultRow('text.live');
  const finalizeRow = useTaskDefaultRow('text.finalize');
  const liveFallbackRow = useTaskDefaultRow('text.live.fallback');
  const finalizeFallbackRow = useTaskDefaultRow('text.finalize.fallback');
  const primaryOptionsQuery = useTaskModelOptions('text.live');
  const fallbackOptionsQuery = useTaskModelOptions('text.live.fallback');
  const mutation = usePutTaskDefaultRow();

  const [primaryModel, setPrimaryModel] = useState('');
  const [fallbackModel, setFallbackModel] = useState('');

  const rowQueries = [liveRow, finalizeRow, liveFallbackRow, finalizeFallbackRow];
  const pending = rowQueries.some((q) => q.isPending) || primaryOptionsQuery.isPending || fallbackOptionsQuery.isPending;
  if (pending) return <ControlSkeleton />;

  const firstError = rowQueries.find((q) => q.error)?.error ?? primaryOptionsQuery.error ?? fallbackOptionsQuery.error;
  if (firstError || !liveRow.data || !finalizeRow.data || !liveFallbackRow.data || !finalizeFallbackRow.data || !primaryOptionsQuery.data || !fallbackOptionsQuery.data) {
    return (
      <ErrorState
        error={firstError}
        onRetry={() => {
          rowQueries.forEach((q) => void q.refetch());
          void primaryOptionsQuery.refetch();
          void fallbackOptionsQuery.refetch();
        }}
      />
    );
  }

  const primaryOptions = primaryOptionsQuery.data;
  const fallbackOptions = fallbackOptionsQuery.data;
  const primaryOrphan = primaryModel && !primaryOptions.some((o) => o.slug === primaryModel) ? primaryModel : null;
  const fallbackOrphan = fallbackModel && !fallbackOptions.some((o) => o.slug === fallbackModel) ? fallbackModel : null;

  async function applyDefault() {
    if (!primaryModel) return;
    // Each write carries its OWN key's ETag; writing one key never invalidates
    // another key's version, so these captured ETags stay valid across the loop.
    const writes: { taskKey: AiTaskKey; etag: string | null; modelSlug: string }[] = [
      { taskKey: 'text.live', etag: liveRow.data!.etag, modelSlug: primaryModel },
      { taskKey: 'text.finalize', etag: finalizeRow.data!.etag, modelSlug: primaryModel },
    ];
    if (fallbackModel) {
      writes.push({ taskKey: 'text.live.fallback', etag: liveFallbackRow.data!.etag, modelSlug: fallbackModel });
      writes.push({ taskKey: 'text.finalize.fallback', etag: finalizeFallbackRow.data!.etag, modelSlug: fallbackModel });
    }
    try {
      for (const write of writes) {
        await mutation.mutateAsync({ taskKey: write.taskKey, body: { modelSlug: write.modelSlug }, etag: write.etag });
      }
      toast.success(`Default applied to ${writes.length} summarization ${writes.length === 1 ? 'route' : 'routes'}`);
      setPrimaryModel('');
      setFallbackModel('');
    } catch (error) {
      if (isOccError(error)) {
        // A row changed under us — the cards below refetch via the mutation's
        // invalidation; the OCC alert offers an explicit reload too.
        toast.error('A summarization default changed after you loaded it. Review the cards below and apply again.');
      } else {
        toast.error(error instanceof Error ? error.message : 'Could not apply the default');
      }
    }
  }

  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-col gap-1">
        <h2 id={`${uid}-title`} className="text-base font-medium">
          Default text-generation provider
        </h2>
        <p className="text-muted-foreground text-sm">
          Pick one provider/model and apply it across every text-generation task this tenant controls &mdash; the live and final summaries &mdash; in a
          single action. There is no separate task key for grammar-fix today, so this default covers summarization. Guardrail, NLP and harness text
          generation is platform-managed (shown read-only below).
        </p>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-primary`} className="text-muted-foreground text-xs font-medium">
            Provider / model
          </Label>
          <Select value={primaryModel} onValueChange={setPrimaryModel}>
            <SelectTrigger id={`${uid}-primary`} className="w-full" aria-label="Default provider/model for text generation">
              <SelectValue placeholder="Select a provider/model" />
            </SelectTrigger>
            <ModelOptions options={primaryOptions} orphanSlug={primaryOrphan} />
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-fallback`} className="text-muted-foreground text-xs font-medium">
            Fallback provider / model <span className="font-normal">&mdash; optional</span>
          </Label>
          <Select value={fallbackModel} onValueChange={setFallbackModel}>
            <SelectTrigger id={`${uid}-fallback`} className="w-full" aria-label="Default fallback provider/model for text generation">
              <SelectValue placeholder="Optional — leave unset to skip the fallback" />
            </SelectTrigger>
            <ModelOptions options={fallbackOptions} orphanSlug={fallbackOrphan} />
          </Select>
        </div>
      </div>

      <OccConflictAlert
        error={mutation.error}
        onReload={() => {
          mutation.reset();
          rowQueries.forEach((q) => void q.refetch());
        }}
      />

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="text-muted-foreground text-xs">
          Applies to both summarization routes &mdash; the live and final summaries{fallbackModel ? ' and their fallbacks' : ''}. Saved per key with
          If-Match.
        </p>
        <Button onClick={() => void applyDefault()} disabled={!primaryModel || mutation.isPending} aria-label="Apply the default text-generation provider · If-Match">
          {mutation.isPending ? <Spinner /> : null}
          Apply default
        </Button>
      </div>
    </Card>
  );
}
