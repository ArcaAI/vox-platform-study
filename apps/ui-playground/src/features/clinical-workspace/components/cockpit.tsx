/**
 * Cockpit (TASK-330 P3, WS4).
 *
 * The ambient-scribe cockpit: three coordinated panes — live capture + consent
 * (left), the running live summary with entity highlights (center), and
 * mid-visit context entry (right). The page owns the single live-summary SSE
 * subscription and passes its result down so capture and summary stay in sync.
 */
import { CapturePanel } from './capture-panel';
import { ContextPanel } from './context-panel';
import { LiveSummaryPanel } from './live-summary-panel';
import type { UseLiveSummaryStreamResult } from '../hooks/use-live-summary-stream';
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
    <div className="grid gap-4 lg:grid-cols-3" data-testid="clinical-cockpit">
      <div className="flex min-h-[32rem] flex-col lg:min-h-[34rem]">
        <CapturePanel
          consultationId={consultationId}
          recording={recording}
          onRecordingStarted={onRecordingStarted}
          onRecordingStopped={onRecordingStopped}
        />
      </div>
      <div className="flex min-h-[32rem] flex-col lg:min-h-[34rem]">
        <LiveSummaryPanel event={liveSummary.event} status={liveSummary.status} error={liveSummary.error} lastUpdatedAt={liveSummary.lastUpdatedAt} />
      </div>
      <div className="flex min-h-[32rem] flex-col lg:min-h-[34rem]">
        <ContextPanel consultationId={consultationId} />
      </div>
    </div>
  );
}
