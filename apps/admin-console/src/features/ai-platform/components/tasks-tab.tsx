'use client';

import { useMemo, useState } from 'react';
import { IconSearch } from '@tabler/icons-react';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Separator } from '@arcaai/ui/components/shadcn/separator';
import { RequirePermission } from '@/shared/auth/require-permission';
import { AI_TASK_KEYS, taskKeyService } from '@/shared/catalog/ai-task-keys';
import { EffectiveHarnessPolicyCard } from '@/features/ai-task-defaults/components/effective-harness-policy-card';
import { TextModelsSection } from '@/features/ai-task-defaults/components/text-models-section';
import { useEffectiveRoutingPolicies } from '../api/hooks';
import { TaskRoutingCard } from './task-routing-card';
import type { ResolvedAiPlatformScope } from './use-ai-platform-scope';

/**
 * TASKS — the four-plus product tasks, each showing its elected default and its
 * ordered fallback chain.
 *
 * This tab answers "what serves X?", which is a different question from the
 * Providers tab's "what have we configured?". Keeping them apart is what makes
 * the consolidation an information architecture rather than the old screens in
 * a tab bar: an operator debugging a bad summary comes here; an operator
 * onboarding a vendor goes there.
 *
 * The registry is grouped by owning service so the SUPER_ADMIN-only families
 * (guardrail / nlp / harness / vlm) read as one block rather than being
 * interleaved with the tenant-owned `text.*` keys.
 *
 * ## Why the tenant's own text-model selection lives here
 *
 * `AiTaskDefault` is the surface where a TENANT picks the model for its own
 * `text.*` tasks, and it used to sit on `/ai-configuration` — a different
 * screen from the one showing what those tasks resolve to. Selecting a model
 * and seeing what it resolves to are the same question asked twice, so the
 * editor moved next to the answer.
 *
 * The import crosses a feature boundary, which rule 13 forbids. It is a MOVE,
 * not a new edge: `/ai-configuration` dropped these sections in the same
 * change, and the screen that hosted them (`tenant-ai-configuration-screen.tsx`)
 * already reached across into `tenant-stt-config` and `tenant-tts-config` for
 * the same reason. `features/ai-task-defaults` remains the owner of the editor;
 * this tab only places it.
 */
export function TasksTab({ scope }: { scope: ResolvedAiPlatformScope }) {
  const [filter, setFilter] = useState('');
  const results = useEffectiveRoutingPolicies(scope.tenantId, AI_TASK_KEYS, !scope.isLoading);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return AI_TASK_KEYS.map((taskKey, index) => ({ taskKey, result: results[index] })).filter(
      ({ taskKey }) => needle === '' || taskKey.toLowerCase().includes(needle),
    );
  }, [filter, results]);

  const groups = useMemo(() => {
    const byService = new Map<string, typeof rows>();
    for (const row of rows) {
      const service = taskKeyService(row.taskKey);
      byService.set(service, [...(byService.get(service) ?? []), row]);
    }
    return [...byService.entries()];
  }, [rows]);

  return (
    <div className="flex flex-col gap-6">
      <RequirePermission action="read" subject="AiTaskDefault">
        <section className="flex flex-col gap-3" aria-labelledby="tenant-text-selection">
          <div>
            <h2 id="tenant-text-selection" className="text-sm font-medium">
              Your text-generation selection
            </h2>
            <p className="text-muted-foreground text-xs">
              The models this tenant chooses for its own summarization tasks. Leave a key unset and it inherits the platform default; selection is
              fail-closed, so an unset key with no platform default cannot be served at all.
            </p>
          </div>
          <TextModelsSection />
          <EffectiveHarnessPolicyCard />
        </section>
        <Separator />
      </RequirePermission>

      <div className="flex max-w-sm flex-col gap-1.5">
        <Label htmlFor="task-filter">Filter tasks</Label>
        <div className="relative">
          <IconSearch aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input
            id="task-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="text.finalize"
            className="pl-8 font-mono"
          />
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">No task key matches “{filter}”.</p>
      ) : (
        groups.map(([service, serviceRows]) => (
          <section key={service} className="flex flex-col gap-3" aria-labelledby={`task-group-${service}`}>
            <h2 id={`task-group-${service}`} className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {service} ({serviceRows.length})
            </h2>
            <div className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {serviceRows.map(({ taskKey, result }) => (
                <TaskRoutingCard key={taskKey} taskKey={taskKey} data={result?.data} error={result?.error} isPending={result?.isPending ?? true} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
