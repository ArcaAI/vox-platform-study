'use client';

import { useId } from 'react';
import { SMR_FALLBACK_TASK_KEYS, SMR_PRIMARY_TASK_KEYS } from '../api/types';
import { SmrDefaultProviderControl } from './smr-default-provider-control';
import { TaskDefaultCard } from './task-default-card';

/** Per-key card copy for the primary summarization selections. */
const PRIMARY_META: Record<(typeof SMR_PRIMARY_TASK_KEYS)[number], { title: string; description: string }> = {
  'smr.live': {
    title: 'Live summary model',
    description: 'Provider/model that generates the streaming, in-consultation summary for this tenant.',
  },
  'smr.finalize': {
    title: 'Final summary model',
    description: 'Provider/model that produces the finalized post-consultation summary for this tenant.',
  },
};

/** Per-key card copy for the OPTIONAL fallback selections. */
const FALLBACK_META: Record<(typeof SMR_FALLBACK_TASK_KEYS)[number], { title: string; description: string }> = {
  'smr.live.fallback': {
    title: 'Live summary fallback model',
    description: 'Used when the primary live-summary provider fails. Optional — leave unset for no fallback.',
  },
  'smr.finalize.fallback': {
    title: 'Final summary fallback model',
    description: 'Used when the primary final-summary provider fails. Optional — leave unset for no fallback.',
  },
};

/**
 * Tenant-editable "SMR models" section (TASK-588 / TASK-592, /ai-configuration).
 *
 * A one-action `SmrDefaultProviderControl` at the top applies a single
 * provider/model across the tenant-editable text-gen keys, above four per-key
 * `TaskDefaultCard`s grouped Primary / Fallback. `tenantId` is OMITTED on
 * every card, so each OCC save (`PUT admin/ai-task-defaults/row?taskKey=`) is
 * CLS-pinned to the caller's working tenant — never the SYSTEM platform rows.
 *
 * SMR selection left `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` for this ticket, so this
 * is a real tenant write surface (the section mounts under the "Acting on
 * «Tenant»" banner, since it mutates tenant data). Fallback is opt-in: an empty
 * fallback row means no fallback provider runs.
 */
export function SmrModelsSection() {
  const uid = useId();
  return (
    <div className="flex flex-col gap-6">
      {/* TASK-592: one-action default across the tenant-editable text-gen (summarization) keys. */}
      <SmrDefaultProviderControl />

      <section aria-labelledby={`${uid}-primary`} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={`${uid}-primary`} className="text-base font-semibold">
            Primary models
          </h2>
          <p className="text-muted-foreground text-sm">
            The provider/model this tenant uses for summarization. Changes are scoped to this tenant and saved with optimistic concurrency (If-Match).
          </p>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {SMR_PRIMARY_TASK_KEYS.map((key) => (
            <TaskDefaultCard key={key} taskKey={key} title={PRIMARY_META[key].title} description={PRIMARY_META[key].description} />
          ))}
        </div>
      </section>

      <section aria-labelledby={`${uid}-fallback`} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={`${uid}-fallback`} className="text-base font-semibold">
            Fallback models <span className="text-muted-foreground text-sm font-normal">(optional)</span>
          </h2>
          <p className="text-muted-foreground text-sm">
            Used when the primary provider fails. Leave a fallback unset to disable it &mdash; an empty fallback means no fallback provider runs.
          </p>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {SMR_FALLBACK_TASK_KEYS.map((key) => (
            <TaskDefaultCard key={key} taskKey={key} title={FALLBACK_META[key].title} description={FALLBACK_META[key].description} />
          ))}
        </div>
      </section>
    </div>
  );
}
