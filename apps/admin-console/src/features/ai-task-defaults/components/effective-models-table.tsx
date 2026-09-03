'use client';

import { useId } from 'react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ErrorState } from '@/shared/state/error-state';
import { useEffectiveTaskDefaults } from '../api/hooks';
import { READ_ONLY_TASK_KEYS } from '../api/types';
import type { EffectiveAiTaskDefault } from '../api/types';

/** `source` badge copy per the cascade tier (null = the service env bootstrap). */
const SOURCE_BADGES: Record<'tenant' | 'system' | 'none', { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  tenant: { label: 'tenant', variant: 'default' },
  system: { label: 'system', variant: 'secondary' },
  none: { label: 'service default', variant: 'outline' },
};

/** One resolved row: task key → the model that actually serves it + who decided. */
function EffectiveRow({ effective }: { effective: EffectiveAiTaskDefault }) {
  const badge = SOURCE_BADGES[effective.source ?? 'none'];
  return (
    <tr className="border-border/60 border-b last:border-b-0">
      <th scope="row" className="py-2 pr-4 text-left align-top font-mono text-xs font-normal">
        {effective.taskKey}
      </th>
      <td className="py-2 pr-4 align-top text-sm">
        {effective.model ? (
          <span className="flex flex-wrap items-baseline gap-2">
            <span className="font-medium">{effective.model.name}</span>
            <span className="text-muted-foreground font-mono text-xs">{effective.model.slug}</span>
          </span>
        ) : (
          <span className="text-muted-foreground font-mono text-xs">{effective.modelSlug ?? 'service env default'}</span>
        )}
      </td>
      <td className="py-2 pr-4 align-top">
        {effective.model?.provider ? (
          <Badge variant="outline" className="font-mono">
            {effective.model.provider}
          </Badge>
        ) : (
          <span className="text-muted-foreground text-xs">&mdash;</span>
        )}
      </td>
      <td className="py-2 align-top">
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </td>
    </tr>
  );
}

/** Rule 10: skeleton shaped like the loaded table (one row per known task key). */
function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      <Skeleton className="h-8 w-full" />
      {READ_ONLY_TASK_KEYS.map((key) => (
        <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto_auto] items-center gap-4">
          <Skeleton className="h-4 w-32 max-w-full" />
          <Skeleton className="h-4 w-56 max-w-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * The read-only effective-models table (tenant visibility).
 *
 * ONE `GET admin/ai-task-defaults` round-trip returns the resolved default for
 * every task key. This surface is deliberately READ-ONLY today: a tenant
 * admin sees which model serves each of these tasks and which cascade tier
 * decided it — visibility, not (yet) an edit control here. Text-generation
 * selection is tenant-editable and lives in the "Text models" section, so it
 * is excluded from this table.
 *
 * Governance note (2026-08-16): nlp/harness selection is
 * still a SUPER_ADMIN-only write. guardrail selection is now tenant-admin
 * configurable at the API layer (subject to the platform-approved-list
 * floor), but this table has no edit control for it yet — see
 * `ai-task-defaults-platform-screen.tsx` for the SYSTEM-row (platform
 * default) editor.
 */
export function EffectiveModelsTable() {
  const uid = useId();
  const query = useEffectiveTaskDefaults();

  if (query.isPending) return <TableSkeleton />;
  if (query.error || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const byKey = new Map(query.data.map((row) => [row.taskKey, row]));

  return (
    <section aria-labelledby={`${uid}-title`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={`${uid}-title`} className="text-base font-medium">
          Effective models ({READ_ONLY_TASK_KEYS.length})
        </h2>
        <p className="text-muted-foreground text-sm">
          The model that actually serves each guardrail, NLP and harness task for this tenant, and which tier decided it. NLP and harness selection
          is managed by super administrators; guardrail selection is now tenant-configurable via the API (this view is not yet an editor for it).
          Summarization models are configured above, in the &ldquo;Models&rdquo; tab.
        </p>
      </div>
      {/* tabIndex + role/aria-label: a horizontally-scrollable container must be
          keyboard-reachable on its own (axe scrollable-region-focusable / WCAG 2.1.1). */}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Effective models">
        <table className="w-full min-w-2xl border-collapse text-left">
          <caption className="sr-only">Effective AI model per task key, with the cascade tier that resolved it</caption>
          <thead>
            <tr className="border-border text-muted-foreground border-b text-xs">
              <th scope="col" className="py-2 pr-4 font-medium">
                Task key
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Model
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Provider
              </th>
              <th scope="col" className="py-2 font-medium">
                Resolved by
              </th>
            </tr>
          </thead>
          <tbody>
            {READ_ONLY_TASK_KEYS.map((key) => {
              const row = byKey.get(key);
              return (
                <EffectiveRow
                  key={key}
                  effective={row ?? { tenantId: '', taskKey: key, modelSlug: null, source: null, configJson: null, model: null }}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
