'use client';

import { IconChevronLeft, IconChevronRight, IconRepeat } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';

export interface LoopIterationState {
  current: number;
  total: number | null;
}

/**
 * The `◀ 3/12 ▶` per-iteration drill-down for `agentic.loop` nodes (TASK-849 lane C, step 6).
 *
 * HONEST GAP, recorded by the ticket and not rediscovered here: nothing EMITS
 * `workflow.loop.iteration` today. `_envelope_for` in
 * `apps/harness/.../interpreter/activities.py` already knows how to shape that
 * event type, but `workflow.py`'s stage walk never constructs a `RunEventSpec`
 * with it — the hook belongs in `interpreter.loop_state_checkpoint`, deferred by
 * lane A. The durable rollup this screen otherwise reads (`RunNodeRollup`) has no
 * per-iteration breakdown either: `attemptCount`/`attemptSeqs` are RETRY
 * groupings, not loop iterations (see `attempt-group.tsx`'s own doc comment).
 *
 * So `iterations` is `null` for every run today, and this component renders the
 * full affordance in a DISABLED state with the reason stated, rather than hiding
 * it — the UI is ready the moment a future lane wires up the checkpoint hook. It
 * must never invent a step count to fill the gap.
 */
export function LoopIterationDrilldown({ iterations, onStep }: { iterations: LoopIterationState | null; onStep?: (direction: -1 | 1) => void }) {
  const available = iterations !== null && iterations.total !== null;
  const current = iterations?.current ?? 0;
  const total = iterations?.total ?? 0;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <IconRepeat aria-hidden className="size-4" />
        Loop iteration
      </div>
      <div className="flex items-center gap-2" role="group" aria-label="Loop iteration navigation">
        <Button type="button" variant="outline" size="icon-sm" disabled={!available || current <= 1} aria-label="Previous iteration" onClick={() => onStep?.(-1)}>
          <IconChevronLeft aria-hidden />
        </Button>
        <span className="min-w-16 text-center font-mono text-sm tabular-nums" aria-live="polite">
          {available ? `${current}/${total}` : '— / —'}
        </span>
        <Button type="button" variant="outline" size="icon-sm" disabled={!available || current >= total} aria-label="Next iteration" onClick={() => onStep?.(1)}>
          <IconChevronRight aria-hidden />
        </Button>
      </div>
      {!available ? (
        <p className="text-muted-foreground text-xs">
          Iteration data isn&rsquo;t emitted yet &mdash; the interpreter has no per-iteration checkpoint hook wired up. This is a recorded gap
          (TASK-849), not a bug in this view.
        </p>
      ) : null}
    </div>
  );
}
