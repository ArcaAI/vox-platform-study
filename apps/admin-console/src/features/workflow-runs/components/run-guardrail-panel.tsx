'use client';

import { useEffect, useMemo, useState } from 'react';
import { IconChevronDown, IconShieldHalf } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { foldRunEvents, type RunView } from '@/shared/sandbox/api/run-fold';
import { useRunTraceStream } from '@/shared/sandbox/api/use-run-trace-stream';
import { RunGuardrailSummary } from '@/shared/sandbox/components/run-guardrail-summary';

function GuardrailActivity({ runId, onView }: { runId: string; onView?: (view: RunView) => void }) {
  const trace = useRunTraceStream(runId);
  const view = useMemo(() => foldRunEvents(trace.events, undefined, runId), [trace.events, runId]);
  useEffect(() => {
    onView?.(view);
  }, [view, onView]);

  if (trace.status === 'error') {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-destructive">{trace.error ?? 'The guardrail trace could not be read.'}</span>
        <Button type="button" size="sm" variant="outline" onClick={trace.reconnect}>
          Retry
        </Button>
      </div>
    );
  }
  if (trace.events.length === 0 && (trace.status === 'connecting' || trace.status === 'idle')) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  return <RunGuardrailSummary view={view} />;
}

/**
 * TASK-1050 W3b — a run's guardrail activity on the run-trace screen: the paused state (a guardrail
 * hold parks the run at its node, README §9.8.1), every `guardrail.notice`, and each node's inbound /
 * outbound screens with their action (incl. `WARN` / `IGNORE`) and per-check verdicts.
 *
 * Source: the protocol-v2 ADMIN trace (`useRunTraceStream`, 24 h retention), because the legacy run
 * stream this screen follows derives none of the guardrail events. It is opened ON DEMAND so a screen
 * that is only being looked at keeps its one connection. `onView` lifts the fold so the canvas can badge
 * the nodes.
 */
export function RunGuardrailPanel({ runId, onView }: { runId: string; onView?: (view: RunView | null) => void }) {
  const [open, setOpen] = useState(false);
  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) onView?.(null);
  }
  return (
    <section aria-label="Guardrail activity" className="flex flex-col gap-2 rounded-md border px-3 py-2">
      <Button type="button" variant="ghost" size="sm" className="self-start" aria-expanded={open} onClick={toggle}>
        <IconShieldHalf aria-hidden />
        {open ? 'Hide guardrail activity' : 'Show guardrail activity'}
        <IconChevronDown aria-hidden className={open ? 'rotate-180' : undefined} />
      </Button>
      {open ? <GuardrailActivity runId={runId} onView={onView} /> : null}
    </section>
  );
}
