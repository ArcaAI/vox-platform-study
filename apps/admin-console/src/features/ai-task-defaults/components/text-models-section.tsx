'use client';

import { useId } from 'react';
import { TEXT_FALLBACK_TASK_KEYS, TEXT_PRIMARY_TASK_KEYS, TEXT_TEST_TASK_KEYS } from '../api/types';
import { TextDefaultProviderControl } from './text-default-provider-control';
import { TaskDefaultCard } from './task-default-card';

/** Per-key card copy for the primary summarization selections. */
const PRIMARY_META: Record<(typeof TEXT_PRIMARY_TASK_KEYS)[number], { title: string; description: string }> = {
  'text.live': {
    title: 'Live summary model',
    description: 'Provider/model that generates the streaming, in-consultation summary for this tenant.',
  },
  'text.finalize': {
    title: 'Final summary model',
    description: 'Provider/model that produces the finalized post-consultation summary for this tenant.',
  },
};

/** Per-key card copy for the prompt-template test bench. */
const TEST_META: Record<(typeof TEXT_TEST_TASK_KEYS)[number], { title: string; description: string }> = {
  'text.test': {
    title: 'Prompt test-bench model',
    description:
      'Provider/model used when this tenant tests a prompt template without picking one explicitly. Resolution is fail-closed: leave it unset and the Test action returns an error.',
  },
};

/** Per-key card copy for the OPTIONAL fallback selections. */
const FALLBACK_META: Record<(typeof TEXT_FALLBACK_TASK_KEYS)[number], { title: string; description: string }> = {
  'text.live.fallback': {
    title: 'Live summary fallback model',
    description: 'Used when the primary live-summary provider fails. Optional — leave unset for no fallback.',
  },
  'text.finalize.fallback': {
    title: 'Final summary fallback model',
    description: 'Used when the primary final-summary provider fails. Optional — leave unset for no fallback.',
  },
};

/**
 * Tenant-editable "Text models" section (/ai-configuration).
 *
 * A one-action `TextDefaultProviderControl` at the top applies a single
 * provider/model across the tenant-editable text-gen keys, above four per-key
 * `TaskDefaultCard`s grouped Primary / Fallback. `tenantId` is OMITTED on
 * every card, so each OCC save (`PUT admin/ai-task-defaults/row?taskKey=`) is
 * CLS-pinned to the caller's working tenant — never the SYSTEM platform rows.
 *
 * Text-generation selection left `SUPER_ADMIN_ONLY_TASK_PREFIXES` for this ticket, so this
 * is a real tenant write surface (the section mounts under the "Acting on
 * «Tenant»" banner, since it mutates tenant data). Fallback is opt-in: an empty
 * fallback row means no fallback provider runs.
 */
export function TextModelsSection() {
  const uid = useId();
  return (
    <div className="flex flex-col gap-6">
      {/* One-action default across the tenant-editable text-gen (summarization) keys. */}
      <TextDefaultProviderControl />

      <section aria-labelledby={`${uid}-primary`} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={`${uid}-primary`} className="text-base font-medium">
            Primary models
          </h2>
          <p className="text-muted-foreground text-sm">
            The provider/model this tenant uses for summarization. Changes are scoped to this tenant and saved with optimistic concurrency (If-Match).
          </p>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {TEXT_PRIMARY_TASK_KEYS.map((key) => (
            <TaskDefaultCard key={key} taskKey={key} title={PRIMARY_META[key].title} description={PRIMARY_META[key].description} />
          ))}
        </div>
      </section>

      <section aria-labelledby={`${uid}-test`} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={`${uid}-test`} className="text-base font-medium">
            Prompt test bench
          </h2>
          <p className="text-muted-foreground text-sm">
            Used by the Test action on a prompt template when no provider/model is chosen for the run. This selection is required &mdash; testing a
            prompt never falls back to the summarization routing.
          </p>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {TEXT_TEST_TASK_KEYS.map((key) => (
            <TaskDefaultCard key={key} taskKey={key} title={TEST_META[key].title} description={TEST_META[key].description} />
          ))}
        </div>
      </section>

      <section aria-labelledby={`${uid}-fallback`} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={`${uid}-fallback`} className="text-base font-medium">
            Fallback models <span className="text-muted-foreground text-sm font-normal">(optional)</span>
          </h2>
          <p className="text-muted-foreground text-sm">
            Used when the primary provider fails. Leave a fallback unset to disable it &mdash; an empty fallback means no fallback provider runs.
          </p>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {TEXT_FALLBACK_TASK_KEYS.map((key) => (
            <TaskDefaultCard key={key} taskKey={key} title={FALLBACK_META[key].title} description={FALLBACK_META[key].description} />
          ))}
        </div>
      </section>
    </div>
  );
}
