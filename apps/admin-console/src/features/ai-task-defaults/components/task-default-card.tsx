'use client';

import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useEffectiveTaskDefault, usePutTaskDefaultRow, useTaskDefaultRow, useTaskModelOptions } from '../api/hooks';
import type { AiTaskKey, EffectiveAiTaskDefault } from '../api/types';

/** `source` badge copy per the cascade tier (null = the service env bootstrap). */
const SOURCE_BADGES: Record<'tenant' | 'system' | 'none', { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  tenant: { label: 'tenant', variant: 'default' },
  system: { label: 'system', variant: 'secondary' },
  none: { label: 'service default', variant: 'outline' },
};

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/** Effective resolution line: model identity + the winning cascade tier. */
function EffectiveLine({ effective }: { effective: EffectiveAiTaskDefault }) {
  const badge = SOURCE_BADGES[effective.source ?? 'none'];
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Effective:</span>
      {effective.model ? (
        <>
          <span className="font-medium">{effective.model.name}</span>
          <span className="text-muted-foreground font-mono text-xs">{effective.model.slug}</span>
          {effective.model.provider ? (
            <Badge variant="outline" className="font-mono">
              {effective.model.provider}
            </Badge>
          ) : null}
        </>
      ) : (
        <span className="font-mono text-xs">{effective.modelSlug ?? 'service env default'}</span>
      )}
      <Badge variant={badge.variant}>{badge.label}</Badge>
    </div>
  );
}

function CardSkeleton() {
  return (
    <Card className="gap-3 p-4" aria-hidden>
      <Skeleton className="h-5 w-48 max-w-full" />
      <Skeleton className="h-4 w-64 max-w-full" />
      <Skeleton className="h-9 w-full" />
      <div className="flex justify-end">
        <Skeleton className="h-9 w-36" />
      </div>
    </Card>
  );
}

/**
 * One AI task key = one card (TASK-506 Phase 6): the resolved effective model
 * (with its cascade-source badge), a picker over the ENABLED registry options
 * for the key, and an OCC save of the scope's row (If-Match from the row read;
 * `"0"` creates it). `tenantId` scopes the row: the platform screen passes the
 * SYSTEM tenant id, the tenant screen omits it (CLS-pinned).
 */
export function TaskDefaultCard({
  taskKey,
  title,
  description,
  tenantId,
}: {
  taskKey: AiTaskKey;
  title: string;
  description?: ReactNode;
  tenantId?: string;
}) {
  const uid = useId();
  const effectiveQuery = useEffectiveTaskDefault(taskKey, tenantId);
  const rowQuery = useTaskDefaultRow(taskKey, tenantId);
  const optionsQuery = useTaskModelOptions(taskKey);
  const mutation = usePutTaskDefaultRow();
  const [draft, setDraft] = useState<string | null>(null);

  if (effectiveQuery.isPending || rowQuery.isPending || optionsQuery.isPending) return <CardSkeleton />;

  const firstError = effectiveQuery.error ?? rowQuery.error ?? optionsQuery.error;
  if (firstError || !effectiveQuery.data || !rowQuery.data || !optionsQuery.data) {
    return (
      <ErrorState
        error={firstError}
        onRetry={() => {
          void effectiveQuery.refetch();
          void rowQuery.refetch();
          void optionsQuery.refetch();
        }}
      />
    );
  }

  const row = rowQuery.data.data;
  const etag = rowQuery.data.etag;
  const saved = row.modelSlug ?? '';
  const selected = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  // A disabled/retired slug already on the row must stay visible in the picker.
  const options = optionsQuery.data;
  const orphanSlug = saved && !options.some((option) => option.slug === saved) ? saved : null;

  function handleSave() {
    if (!dirty || !selected) return;
    mutation.mutate(
      { taskKey, body: { modelSlug: selected }, etag, tenantId },
      {
        onSuccess: () => {
          toast.success(`${title} default saved`);
          setDraft(null);
        },
        onError: (error) => {
          if (!isOccError(error)) toast.error(error.message);
        },
      },
    );
  }

  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-col gap-1">
        <h2 id={`${uid}-title`} className="text-sm font-semibold">
          {title}
        </h2>
        {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
        <p className="text-muted-foreground font-mono text-xs" aria-hidden>
          {taskKey}
        </p>
      </div>
      <EffectiveLine effective={effectiveQuery.data} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-model`} className="text-muted-foreground text-xs font-medium">
          Default model
        </Label>
        <Select value={selected} onValueChange={setDraft}>
          <SelectTrigger id={`${uid}-model`} className="w-full" aria-label={`Default model for ${taskKey}`}>
            <SelectValue placeholder="not set — service env default applies" />
          </SelectTrigger>
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
        </Select>
      </div>
      <OccConflictAlert
        error={mutation.error}
        onReload={() => {
          // The draft selection stays in memory (reload-merge: no silent loss).
          mutation.reset();
          void rowQuery.refetch();
        }}
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {dirty ? <span className="text-muted-foreground text-sm">Unsaved change</span> : null}
        {/* aria-label keeps the visible text (WCAG 2.5.3) while disambiguating the per-card buttons. */}
        <Button onClick={handleSave} disabled={!dirty || !selected || mutation.isPending} aria-label={`Save ${taskKey} default · If-Match`}>
          {mutation.isPending ? <Spinner /> : null}
          Save &middot; If-Match
        </Button>
      </div>
    </Card>
  );
}
