/**
 * Cockpit (TASK-330 P3, WS4).
 *
 * The ambient-scribe cockpit: three coordinated panes — live capture + consent
 * (left), the running live summary with entity highlights (center), and
 * mid-visit context entry (right). The page owns the single live-summary SSE
 * subscription and passes its result down so capture and summary stay in sync.
 */
import { cn } from '@/lib/utils';
import { CapturePanel } from './capture-panel';
import { ContextPanel } from './context-panel';
import { LiveSummaryPanel } from './live-summary-panel';
import type { LiveSummaryStreamStatus, UseLiveSummaryStreamResult } from '../hooks/use-live-summary-stream';
import type { RecordingStateResponse } from '../types';

interface CockpitProps {
  consultationId: string;
  recording: boolean;
  liveSummary: UseLiveSummaryStreamResult;
  onRecordingStarted: (state: RecordingStateResponse) => void;
  onRecordingStopped: (state: RecordingStateResponse) => void;
}

export function Cockpit({ consultationId, recording, liveSummary, onRecordingStarted, onRecordingStopped }: CockpitProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="clinical-cockpit">
      <div className="flex items-center justify-end">
        <LiveEngineStatus status={liveSummary.status} lastUpdatedAt={liveSummary.lastUpdatedAt} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-h-[32rem] flex-col lg:min-h-[34rem]">
          <CapturePanel
            consultationId={consultationId}
            recording={recording}
            onRecordingStarted={onRecordingStarted}
            onRecordingStopped={onRecordingStopped}
          />
        </div>
        <div className="flex min-h-[32rem] flex-col lg:min-h-[34rem]">
          <LiveSummaryPanel
            event={liveSummary.event}
            status={liveSummary.status}
            error={liveSummary.error}
            lastUpdatedAt={liveSummary.lastUpdatedAt}
          />
        </div>
        <div className="flex min-h-[32rem] flex-col lg:min-h-[34rem]">
          <ContextPanel consultationId={consultationId} />
        </div>
      </div>
    </div>
  );
}

// Read-only health readout for the TASK-340 realtime documentation engine.
// Ops controls (kill-switch) live in the admin Harness console, not here.
const ENGINE_STATUS_META: Record<LiveSummaryStreamStatus, { label: string; dot: string; text: string; pulse: boolean }> = {
  idle: { label: 'Idle', dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', pulse: false },
  connecting: { label: 'Connecting…', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', pulse: true },
  open: { label: 'Live', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', pulse: true },
  closed: { label: 'Finalized', dot: 'bg-muted-foreground', text: 'text-muted-foreground', pulse: false },
  error: { label: 'Disconnected', dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', pulse: false },
};

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

function LiveEngineStatus({ status, lastUpdatedAt }: { status: LiveSummaryStreamStatus; lastUpdatedAt: string | null }) {
  const meta = ENGINE_STATUS_META[status];
  const updated = lastUpdatedAt ? formatUpdatedAt(lastUpdatedAt) : '';
  return (
    <div
      data-testid="live-engine-status"
      data-status={status}
      className="flex items-center gap-2 text-xs"
      title={`Live documentation engine: ${meta.label}`}
    >
      <span className="text-muted-foreground">Live engine</span>
      <span className={cn('inline-flex items-center gap-1.5 font-medium', meta.text)}>
        <span className="relative flex size-2">
          {meta.pulse && <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-75', meta.dot)} />}
          <span className={cn('relative inline-flex size-2 rounded-full', meta.dot)} />
        </span>
        {meta.label}
      </span>
      {updated && (
        <span className="text-muted-foreground" data-testid="live-engine-updated">
          · updated {updated}
        </span>
      )}
    </div>
  );
}
