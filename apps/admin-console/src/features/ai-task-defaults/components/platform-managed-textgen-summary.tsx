'use client';

import { useId } from 'react';
import { IconExternalLink } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ErrorState } from '@/shared/state/error-state';
import { useEffectiveTaskDefaults } from '../api/hooks';
import { READ_ONLY_TASK_KEYS } from '../api/types';
import type { EffectiveAiTaskDefault } from '../api/types';

/** Rule 10: skeleton shaped like the loaded list (one row per locked task key). */
function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      <Skeleton className="h-8 w-full" />
      {READ_ONLY_TASK_KEYS.map((key) => (
        <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-4">
          <Skeleton className="h-4 w-32 max-w-full" />
          <Skeleton className="h-4 w-48 max-w-full" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function EffectiveRow({ effective }: { effective: EffectiveAiTaskDefault }) {
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
      <td className="py-2 align-top">
        <Badge variant="secondary">global admin</Badge>
      </td>
    </tr>
  );
}

/**
 * Read-only summary of the platform-locked text-generation selections
 * (TASK-592). Guardrail / NLP / harness model selection is a GLOBAL_ADMIN-only
 * write, so "default for all text generation" is honest only if the tenant can
 * SEE which model serves those tasks without being able to change them here.
 *
 * One `GET admin/ai-task-defaults` round-trip (shared, cached with the Effective
 * tab). No pickers, no save controls — a plain-href deep link to the read-only
 * Effective models view (rule 13: one authoritative editor, this is not it).
 */
export function PlatformManagedTextGenSummary() {
  const uid = useId();
  const query = useEffectiveTaskDefaults();

  if (query.isPending) return <ListSkeleton />;
  if (query.error || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const byKey = new Map(query.data.map((row) => [row.taskKey, row]));

  return (
    <section aria-labelledby={`${uid}-title`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={`${uid}-title`} className="text-base font-semibold">
          Platform-managed text generation ({READ_ONLY_TASK_KEYS.length})
        </h2>
        <p className="text-muted-foreground text-sm">
          Text generation for guardrail, NLP and harness is decided by global administrators and can&apos;t be changed here. This tenant&apos;s default
          above covers the summarization routes only. Read-only.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-2xl border-collapse text-left">
          <caption className="sr-only">Platform-managed text-generation model per task key (read-only)</caption>
          <thead>
            <tr className="border-border text-muted-foreground border-b text-xs">
              <th scope="col" className="py-2 pr-4 font-medium">
                Task key
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Effective model
              </th>
              <th scope="col" className="py-2 font-medium">
                Controlled by
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
      <div className="flex justify-end">
        {/* Plain href (rule 13 isolation) — the Effective models view is tenant-accessible; /ai-task-defaults is global-admin only. */}
        <Button variant="outline" size="sm" asChild>
          <a href="/ai-configuration">
            <IconExternalLink aria-hidden />
            View all effective models
          </a>
        </Button>
      </div>
    </section>
  );
}
