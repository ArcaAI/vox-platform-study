'use client';

/**
 * The Test tab's status bar (TASK-1036 §10.2): status, elapsed time, tokens in and out, event
 * count and run id. Pinned to the bottom of the tab's one scroll container (`sticky`, not a second
 * scroll area). Status CHANGES are announced through a polite live region; the ticking clock is
 * not, so a screen reader is not read the time every second.
 */
import { Button } from '@arcaai/ui';
import type { RunViewStatus } from '@/shared/sandbox/api/run-fold';
import type { RunTokens } from '@/shared/sandbox/api/run-protocol';
import type { RunTraceStreamStatus } from '@/shared/sandbox/api/use-run-trace-stream';
import { formatDuration } from './lib/event-display';

const STATUS_LABEL: Record<RunViewStatus, string> = {
  IDLE: 'Not started',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELED: 'Cancelled',
  TIMED_OUT: 'Timed out',
};

export function runStatusLabel(status: RunViewStatus, starting: boolean): string {
  return starting && status === 'IDLE' ? 'Starting…' : STATUS_LABEL[status];
}

export interface RunStatusBarProps {
  status: RunViewStatus;
  starting: boolean;
  streamStatus: RunTraceStreamStatus;
  elapsedMs: number | null;
  tokens: RunTokens | null;
  eventCount: number;
  /** Events the view shows when time-travelling (else `null`). */
  shownCount: number | null;
  /** What the time-travelled view shows ("Viewing event #3"); `null` when live. */
  viewLabel?: string | null;
  /** Leaves time travel. Offered here, in the sticky bar, so it is reachable wherever the page is scrolled to. */
  onGoLive?: () => void;
  runId: string | null;
}

export function RunStatusBar(props: RunStatusBarProps) {
  const label = runStatusLabel(props.status, props.starting);
  const reconnecting = props.runId !== null && props.streamStatus === 'connecting' && props.eventCount > 0;
  return (
    <div
      data-slot="test-status-bar"
      className="bg-background text-muted-foreground sticky bottom-0 z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-3 py-1.5 text-xs"
    >
      <span className="text-foreground font-medium">{label}</span>
      <span className="sr-only" role="status" aria-live="polite">
        {`Run status: ${label}`}
      </span>
      {props.viewLabel ? (
        <span className="flex items-center gap-2">
          <span className="text-foreground">{props.viewLabel}</span>
          {props.onGoLive ? (
            <Button type="button" size="xs" variant="outline" onClick={props.onGoLive}>
              Back to live
            </Button>
          ) : null}
        </span>
      ) : null}
      {reconnecting ? <span>Reconnecting to the trace…</span> : null}
      {props.streamStatus === 'error' ? <span className="text-destructive">The trace connection was lost.</span> : null}
      <span className="tabular-nums">Elapsed {props.elapsedMs !== null ? formatDuration(props.elapsedMs) : '—'}</span>
      <span className="tabular-nums">Tokens {props.tokens ? `${props.tokens.in.toLocaleString('en-US')} in · ${props.tokens.out.toLocaleString('en-US')} out` : '—'}</span>
      <span className="tabular-nums">
        Events {props.shownCount !== null ? `${props.shownCount.toLocaleString('en-US')} of ${props.eventCount.toLocaleString('en-US')}` : props.eventCount.toLocaleString('en-US')}
      </span>
      {props.runId ? <code className="ml-auto font-mono">{props.runId}</code> : null}
    </div>
  );
}
