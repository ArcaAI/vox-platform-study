'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { GatewayError } from '@/shared/api';
import { formatDateTime } from '@/shared/format';
import { useEventStream, type StreamStatus } from '@/shared/streams';
import { RunBar, type ConnectionState } from '@/features/playground-shared/components/run-bar';
import { useStartSandboxRun } from '../api/hooks';
import type { SandboxRunLiveStatus, SandboxRunStatus } from '../api/types';
import { SandboxBadge } from './sandbox-badge';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

function isTerminal(status: SandboxRunLiveStatus | undefined): boolean {
  return typeof status === 'string' && TERMINAL.has(status.toUpperCase());
}

/** `StreamStatus` (idle|connecting|open|error|closed) -> `ConnectionState` (idle|connecting|live|closed|error). */
function toConnectionState(streamStatus: StreamStatus): ConnectionState {
  if (streamStatus === 'open') return 'live';
  return streamStatus;
}

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
 * The run/progress panel (TASK-721 Task 7): starting a run is a TanStack mutation through the
 * BFF; live progress is `useEventStream` (ticket-authenticated, direct-to-gateway — rule 13
 * §Auth). Feedback within 100ms (rule 11 §5): the Run button shows a `Spinner` immediately, and
 * a terminal `toast.success`/`toast.error` fires once the stream reports COMPLETED/FAILED/etc.
 */
export function RunPanel({
  definitionId,
  fixtureId,
  onRunIdChange,
}: {
  definitionId: string | null;
  fixtureId: string | null;
  onRunIdChange?: (runId: string | null) => void;
}) {
  const startRun = useStartSandboxRun();
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
  const progressLabel = status ? `${status.status}${status.startedAt ? ` · started ${formatDateTime(status.startedAt)}` : ''}` : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <RunBar
          running={running}
          onRun={handleRun}
          onStop={handleStop}
          connection={runId ? toConnectionState(stream.status) : 'idle'}
          progressLabel={progressLabel}
          disabled={startRun.isPending || !definitionId}
          runLabel="Run in sandbox"
        />
        <SandboxBadge />
        {status ? <Badge variant={isTerminal(status.status) && status.status !== 'COMPLETED' ? 'destructive' : 'outline'}>{status.status}</Badge> : null}
      </div>
      {stream.error ? <p className="text-destructive text-sm">{stream.error}</p> : null}
    </div>
  );
}
