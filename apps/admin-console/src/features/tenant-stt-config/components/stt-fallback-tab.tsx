'use client';

import { Fragment, useId } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ErrorState } from '@/shared/state/error-state';
import { useSttEffective, useSttFallbackCandidates, useSttRow, usePutSttRow, type EffectiveSttConfig } from '../api';
import { SttFallbackForm } from './stt-fallback-form';

/** Compact key/value summary of the resolved effective STT fallback spec. */
function EffectiveResolveCard({ effective }: { effective: EffectiveSttConfig }) {
  const uid = useId();
  const summary: { label: string; value: string }[] = [
    { label: 'fallback pipeline', value: effective.fallbackPipelineId ?? '—' },
    { label: 'auto-switch', value: effective.autoSwitchEnabled ? 'on' : 'off' },
    { label: 'failure threshold', value: String(effective.consecutiveFailureThreshold) },
  ];
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${uid}-title`} className="text-sm font-semibold">
          Effective STT fallback
        </h2>
        <Badge variant="secondary">tenant over SYSTEM default</Badge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        {summary.map((row) => (
          <Fragment key={row.label}>
            <dt className="text-muted-foreground font-mono text-xs">{row.label}</dt>
            <dd className="min-w-0 truncate font-mono text-xs">{row.value}</dd>
          </Fragment>
        ))}
      </dl>
    </Card>
  );
}

function FallbackTabSkeleton() {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" aria-hidden>
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}

/**
 * Speech (STT fallback) tab body — effective resolve card + the OCC
 * fallback-row editor. Extracted from the retired `/stt-config` screen so the
 * `/ai-configuration` hub can compose it as its "Speech" tab. The
 * BYO STT credentials formerly living beside it are now edited only in the
 * hub's Providers tab (the unified provider plane) — the one authoritative
 * credential editor (rule 13).
 */
export function SttFallbackTab() {
  const uid = useId();
  const effectiveQuery = useSttEffective();
  const rowQuery = useSttRow();
  const candidatesQuery = useSttFallbackCandidates();
  const mutation = usePutSttRow();

  if (effectiveQuery.isPending || rowQuery.isPending || candidatesQuery.isPending) return <FallbackTabSkeleton />;
  if (effectiveQuery.error || !effectiveQuery.data) {
    return <ErrorState error={effectiveQuery.error} onRetry={() => void effectiveQuery.refetch()} />;
  }
  if (rowQuery.error || !rowQuery.data) {
    return <ErrorState error={rowQuery.error} onRetry={() => void rowQuery.refetch()} />;
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <EffectiveResolveCard effective={effectiveQuery.data} />
      <section aria-labelledby={`${uid}-editor`} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={`${uid}-editor`} className="text-base font-semibold">
            Tenant STT fallback editor
          </h2>
          <p className="text-muted-foreground text-sm">
            Sparse write over the row &mdash; <span className="font-mono text-xs">PUT /admin/stt-config/row</span> with If-Match; drift returns 412
            with reload-merge.
          </p>
        </div>
        <SttFallbackForm
          row={rowQuery.data.data}
          candidates={candidatesQuery.data ?? []}
          mutation={mutation}
          onReloadLatest={() => void rowQuery.refetch()}
        />
      </section>
    </div>
  );
}
