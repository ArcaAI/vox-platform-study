'use client';

import { useCallback, useMemo, useState } from 'react';
import { IconBolt, IconPlayerStop, IconSend } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { formatRelativeTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useEventStream } from '@/shared/streams';
import { trajectoryStreamPath, trajectoryStreamScope, useCancelWorkflow, useSteps } from '../api';
import type { TrajectorySession, TrajectoryStep, TrajectoryStepStatus } from '../api';
import { SignalDialog } from './signal-dialog';
import { StepStats } from './step-stats';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  OK: 'secondary',
  STARTED: 'outline',
  SKIPPED: 'outline',
  ERROR: 'destructive',
  TIMEOUT: 'destructive',
};

function statusVariant(status: TrajectoryStepStatus): 'default' | 'secondary' | 'outline' | 'destructive' {
  return STATUS_VARIANT[status] ?? 'outline';
}

function StepRow({ step }: { step: TrajectoryStep }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground w-8 shrink-0 font-mono text-xs tabular-nums">#{step.seq}</span>
        <Badge variant="outline" className="font-mono text-[10px]">
          {step.stepType}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{step.name}</span>
        <Badge variant={statusVariant(step.status)} className="shrink-0 text-[10px]">
          {step.status}
        </Badge>
        {step.durationMs !== null ? (
          <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">{step.durationMs} ms</span>
        ) : null}
      </div>
      {step.errorCode ? <p className="text-destructive text-xs">error: {step.errorCode}</p> : null}
      {step.stats ? <StepStats stats={step.stats} /> : null}
    </li>
  );
}

/**
 * Ordered step timeline for one session (GET :sessionId/steps, keyset "seq
 * asc"), with a live toggle that merges SSE steps
 * (GET consultations/:id/trajectory/stream) as they arrive. HARNESS_DOC
 * sessions (sessionId == Temporal workflowId) expose cancel + signal wired to
 * the harness-admin workflow-ops.
 */
export function TrajectoryTimeline({ session }: { session: TrajectorySession }) {
  const stepsQuery = useSteps(session.sessionId, session.runId);
  const cancel = useCancelWorkflow();
  const [live, setLive] = useState(false);
  const [liveSteps, setLiveSteps] = useState<TrajectoryStep[]>([]);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [signalOpen, setSignalOpen] = useState(false);

  const isWorkflow = session.sessionKind === 'HARNESS_DOC';
  const canStream = !!session.consultationId;

  const handleEvent = useCallback((_type: string, data: string) => {
    try {
      const step = JSON.parse(data) as TrajectoryStep;
      if (typeof step?.seq !== 'number') return;
      setLiveSteps((current) => [...current, step]);
    } catch {
      // Heartbeats / non-step frames are ignored.
    }
  }, []);

  const stream = useEventStream({
    path: live && canStream ? trajectoryStreamPath(session.consultationId as string) : null,
    scope: live && canStream ? trajectoryStreamScope(session.consultationId as string) : null,
    onEvent: handleEvent,
    enabled: live && canStream,
  });

  const steps = useMemo(() => {
    const base = stepsQuery.data?.pages.flatMap((page) => page.items) ?? [];
    const merged = new Map<string, TrajectoryStep>();
    for (const step of [...base, ...liveSteps]) merged.set(`${step.runId}#${step.seq}`, step);
    return [...merged.values()].sort((a, b) => a.seq - b.seq);
  }, [stepsQuery.data, liveSteps]);

  function handleCancelConfirmed() {
    cancel.mutate(
      { workflowId: session.sessionId, reason: 'Cancelled from AI Operations' },
      {
        onSuccess: (result) => {
          toast.success(result.requested ? `Cancel requested for ${session.sessionId}` : `Workflow ${session.sessionId} already closed`);
          setConfirmingCancel(false);
        },
        onError: (error) => {
          toast.error(error instanceof GatewayError ? error.message : 'Could not cancel the workflow.');
          setConfirmingCancel(false);
        },
      },
    );
  }

  return (
    <Card className="flex min-h-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <Badge variant="secondary" className="text-[10px]">
              {session.sessionKind}
            </Badge>
            <span className="min-w-0 truncate font-mono text-sm">{session.sessionId}</span>
          </h2>
          <p className="text-muted-foreground text-xs">
            {session.stepCount} steps &middot; last {formatRelativeTime(session.lastStepAt)}
            {session.consultationId ? (
              <>
                {' '}
                &middot; consultation <span className="font-mono">{session.consultationId}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canStream ? (
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={live} onCheckedChange={setLive} aria-label="Live updates" />
              <span className="flex items-center gap-1">
                <IconBolt aria-hidden className="size-3.5" />
                Live
                {live ? <span className="text-muted-foreground">({stream.status})</span> : null}
              </span>
            </label>
          ) : null}
          {isWorkflow ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setSignalOpen(true)}>
                <IconSend aria-hidden />
                Signal
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setConfirmingCancel(true)} disabled={cancel.isPending}>
                {cancel.isPending ? <Spinner /> : <IconPlayerStop aria-hidden />}
                Cancel run
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {stepsQuery.isPending ? (
        <div className="flex flex-col gap-2" aria-hidden>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : stepsQuery.error ? (
        <ErrorState error={stepsQuery.error} onRetry={() => void stepsQuery.refetch()} />
      ) : steps.length === 0 ? (
        <p className="text-muted-foreground text-sm">No steps recorded for this session yet.</p>
      ) : (
        <>
          <ol aria-label={`Trajectory steps for ${session.sessionId}`} className="flex flex-col gap-2">
            {steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </ol>
          {stepsQuery.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="self-center"
              onClick={() => void stepsQuery.fetchNextPage()}
              disabled={stepsQuery.isFetchingNextPage}
            >
              {stepsQuery.isFetchingNextPage ? <Spinner /> : null}
              Load more steps
            </Button>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={confirmingCancel}
        onOpenChange={setConfirmingCancel}
        title="Cancel this workflow?"
        description={`Gracefully cancels the harness workflow ${session.sessionId}. In-flight activities finish; no new work starts.`}
        confirmLabel="Cancel run"
        destructive
        onConfirm={handleCancelConfirmed}
        isPending={cancel.isPending}
      />
      <SignalDialog workflowId={signalOpen ? session.sessionId : null} open={signalOpen} onOpenChange={setSignalOpen} />
    </Card>
  );
}
