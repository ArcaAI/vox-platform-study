'use client';

import { useRef, useState } from 'react';
import { IconPlayerPlayFilled, IconPlayerStopFilled } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { formatDateTime } from '@/shared/format';
import { SandboxBanner } from '@/shared/page/sandbox-banner';
import { useEventStream, type StreamStatus } from '@/shared/streams';
import { useStartSandboxRun } from '../api/hooks';
import type { SandboxRunLiveStatus, SandboxRunStatus } from '../api/types';
import { FixturePicker } from './fixture-picker';
import { SandboxBadge } from './sandbox-badge';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

function isTerminal(status: SandboxRunLiveStatus | undefined): boolean {
  return typeof status === 'string' && TERMINAL.has(status.toUpperCase());
}

/** Connection chip meta, keyed directly off `StreamStatus` — no `idle` entry (idle renders no
 *  chip at all). Rule 11 §7: colour is never the only signal, the label carries the meaning. */
const CONNECTION_META: Record<Exclude<StreamStatus, 'idle'>, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  connecting: { label: 'Connecting…', variant: 'secondary' },
  open: { label: 'Live', variant: 'default' },
  closed: { label: 'Closed', variant: 'outline' },
  error: { label: 'Error', variant: 'destructive' },
};

interface SandboxRunEventEnvelope {
  type: string;
  payload: {
    runId: string;
    workflowDefinitionId: string;
    status: SandboxRunLiveStatus;
    stages: Record<string, unknown>[];
    startedAt: string | null;
    endedAt: string | null;
  };
}

/**
 * Contract C (INTERFACES.md §5) — fixture picker + Run button + live progress. Self-contained;
 * mounts inside the Workflow Studio inspector's Run tab as a narrow (~360px) rail, not a
 * full-width page. Moved from `features/workbench/components/{workbench-screen,run-panel}.tsx`
 * (TASK-893) — the standalone definition picker is gone (`definitionId` now arrives as a prop:
 * the Studio already has the definition open; see `../api/types.ts`'s file banner) and the
 * fixture id / run id are local state rather than the old screen's own `?fixtureId=`/local-state
 * split, since a mounted rail is not a shareable URL the way the retired standalone page was.
 *
 * A sandbox run executes the SERVER's stored graph, not the editor buffer — `blockedReason`
 * (passed by the caller, typically derived from `SaveState`) withholds Run with a stated reason
 * instead of silently testing a stale graph. Feedback within 100ms (rule 11 §5): the Run button
 * shows a `Spinner` the instant the mutation is pending, and a terminal `toast.success`/
 * `toast.error` fires once the stream reports COMPLETED/FAILED/etc. SSE connects DIRECTLY to the
 * gateway with a ticket-authenticated `useEventStream` (rule 13 — never a JWT in a URL).
 */
export function SandboxRunPanel({
  definitionId,
  blockedReason,
  onRunIdChange,
}: {
  definitionId: string | null;
  blockedReason?: string | null;
  onRunIdChange?: (runId: string | null) => void;
}) {
  const startRun = useStartSandboxRun();
  const [fixtureId, setFixtureId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<SandboxRunStatus | null>(null);
  // A ref, not state: the terminal toast is a side effect of an incoming stream EVENT, not a
  // value React needs to re-render on — setting state synchronously inside an effect that
  // watches `status` would trigger a cascading render (react-hooks/set-state-in-effect).
  const toastedTerminalRef = useRef<string | null>(null);

  const streamPath = definitionId && runId ? `admin/workflow-definitions/${definitionId}/sandbox-runs/${runId}/stream` : null;
  const streamScope = runId ? `workflow_run:${runId}` : null;

  const stream = useEventStream({
    path: streamPath,
    scope: streamScope,
    eventNames: ['workflow.sandbox_run.progress', 'workflow.sandbox_run.completed'],
    // The gateway's own stream is a poll-BRIDGE (no push producer exists on the interpreter
    // yet) that resyncs from the CURRENT status on every reconnect — never a replaying log — so
    // auto-reconnect here is safe, unlike `use-task-stream.ts`'s documented replay hazard.
    onEvent: (_type, data) => {
      try {
        const envelope = JSON.parse(data) as SandboxRunEventEnvelope;
        const next = envelope.payload;
        setStatus({
          runId: next.runId,
          workflowDefinitionId: next.workflowDefinitionId,
          status: next.status,
          stages: next.stages,
          startedAt: next.startedAt,
          endedAt: next.endedAt,
        });
        if (isTerminal(next.status) && toastedTerminalRef.current !== next.status) {
          toastedTerminalRef.current = next.status;
          if (next.status === 'COMPLETED') {
            toast.success('Sandbox run completed.');
          } else {
            toast.error(`Sandbox run ${next.status.toLowerCase()}.`);
          }
        }
      } catch {
        // Malformed frame — ignore this tick, the next poll snapshot will correct it.
      }
    },
    enabled: !!streamPath && !!streamScope,
  });

  const effectiveBlockedReason = blockedReason ?? (!definitionId ? 'Save this workflow to run it in the sandbox.' : null);

  function handleRun() {
    if (!definitionId) {
      toast.error('Choose a workflow definition first.');
      return;
    }
    setStatus(null);
    toastedTerminalRef.current = null;
    startRun.mutate(
      { definitionId, body: fixtureId ? { fixtureId } : {} },
      {
        onSuccess: (run) => {
          setRunId(run.runId);
          onRunIdChange?.(run.runId);
        },
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not start the sandbox run.'),
      },
    );
  }

  function handleStop() {
    stream.close();
    setRunId(null);
    onRunIdChange?.(null);
  }

  const running = !!runId && !isTerminal(status?.status);
  const disabled = startRun.isPending || !!effectiveBlockedReason;
  const progressLabel = status ? `${status.status}${status.startedAt ? ` · started ${formatDateTime(status.startedAt)}` : ''}` : undefined;
  const connectionChip = runId && stream.status !== 'idle' ? CONNECTION_META[stream.status] : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SandboxBanner />
      <FixturePicker workflowDefinitionId={definitionId} value={fixtureId} onChange={setFixtureId} />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button type="button" variant="destructive" size="sm" onClick={handleStop}>
              <IconPlayerStopFilled className="size-4" aria-hidden />
              Stop
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={handleRun} disabled={disabled}>
              {startRun.isPending ? <Spinner className="size-4" /> : <IconPlayerPlayFilled className="size-4" aria-hidden />}
              Run in sandbox
            </Button>
          )}
          <SandboxBadge />
        </div>
        {effectiveBlockedReason ? <p className="text-muted-foreground text-xs">{effectiveBlockedReason}</p> : null}
        {connectionChip || status ? (
          <div className="flex flex-wrap items-center gap-2">
            {connectionChip ? (
              <Badge variant={connectionChip.variant} className="gap-1.5">
                {stream.status === 'connecting' ? <Spinner className="size-3" /> : null}
                {connectionChip.label}
              </Badge>
            ) : null}
            {status ? <Badge variant={isTerminal(status.status) && status.status !== 'COMPLETED' ? 'destructive' : 'outline'}>{status.status}</Badge> : null}
          </div>
        ) : null}
        {progressLabel ? <span className="text-muted-foreground font-mono text-xs">{progressLabel}</span> : null}
        {stream.error ? <p className="text-destructive text-sm">{stream.error}</p> : null}
      </div>
    </div>
  );
}
