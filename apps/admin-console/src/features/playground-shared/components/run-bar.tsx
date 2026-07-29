'use client';

import { IconPlayerPlayFilled, IconPlayerStopFilled } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';

export type ConnectionState = 'idle' | 'connecting' | 'live' | 'closed' | 'error';

/** Badge variant + label per connection state (rule 11 §7: color is never the
 *  only signal — the label carries the meaning). */
const CONNECTION: Record<Exclude<ConnectionState, 'idle'>, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  connecting: { label: 'Connecting…', variant: 'secondary' },
  live: { label: 'Live', variant: 'default' },
  closed: { label: 'Closed', variant: 'outline' },
  error: { label: 'Error', variant: 'destructive' },
};

/**
 * Playground run bar: the single Run/Stop affordance plus the
 * connection + progress chips, standardizing the streaming-state displays that
 * each realtime page hand-rolled. Presentational — the page owns the SSE/WS
 * state and passes it down.
 */
export function RunBar({
  running,
  onRun,
  onStop,
  connection = 'idle',
  progressLabel,
  disabled = false,
  runLabel = 'Run',
  stopLabel = 'Stop',
}: {
  running: boolean;
  onRun: () => void;
  onStop: () => void;
  connection?: ConnectionState;
  /** Free-form progress text, e.g. "12s · 3 chunks" or "step 2/4". */
  progressLabel?: string;
  disabled?: boolean;
  runLabel?: string;
  stopLabel?: string;
}) {
  const chip = connection === 'idle' ? null : CONNECTION[connection];

  return (
    <div className="flex flex-wrap items-center gap-3">
      {running ? (
        <Button variant="destructive" onClick={onStop} disabled={disabled}>
          <IconPlayerStopFilled className="size-4" aria-hidden />
          {stopLabel}
        </Button>
      ) : (
        <Button onClick={onRun} disabled={disabled}>
          <IconPlayerPlayFilled className="size-4" aria-hidden />
          {runLabel}
        </Button>
      )}
      {chip ? (
        <Badge variant={chip.variant} className="gap-1.5">
          {connection === 'connecting' ? <Spinner className="size-3" /> : null}
          {chip.label}
        </Badge>
      ) : null}
      {progressLabel ? <span className="text-muted-foreground font-mono text-xs">{progressLabel}</span> : null}
    </div>
  );
}
