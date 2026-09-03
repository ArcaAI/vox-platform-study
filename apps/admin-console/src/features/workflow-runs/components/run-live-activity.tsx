'use client';

import { IconActivity, IconTool } from '@tabler/icons-react';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { formatDateTime, formatRelativeTime } from '@/shared/format';
import type { StreamStatus } from '@/shared/streams';
import { WORKFLOW_NODE_COMPLETED, WORKFLOW_NODE_FAILED, WORKFLOW_NODE_STARTED, type RunLiveEvent } from '../api/live-events';
import { humanizeNodeType } from '../lib/graph-layout';

const STREAM_STATUS_META: Record<StreamStatus, { label: string; role: StatusColorRole }> = {
  idle: { label: 'Idle', role: 'neutral' },
  connecting: { label: 'Connecting', role: 'info' },
  open: { label: 'Live', role: 'success' },
  error: { label: 'Offline — polling', role: 'destructive' },
  closed: { label: 'Closed', role: 'neutral' },
};

function eventLabel(event: RunLiveEvent): string {
  switch (event.type) {
    case WORKFLOW_NODE_STARTED:
      return `${event.payload.nodeType ? humanizeNodeType(event.payload.nodeType) : (event.payload.nodeId ?? 'node')} started`;
    case WORKFLOW_NODE_COMPLETED:
      return `${event.payload.nodeType ? humanizeNodeType(event.payload.nodeType) : (event.payload.nodeId ?? 'node')} completed`;
    case WORKFLOW_NODE_FAILED:
      return `${event.payload.nodeType ? humanizeNodeType(event.payload.nodeType) : (event.payload.nodeId ?? 'node')} failed${event.payload.reason ? ` — ${event.payload.reason}` : ''}`;
    default:
      return event.type;
  }
}

/**
 * The live control-event feed (lane C, step 6 "agent tool-call printing" /
 * general activity affordance). Prints exactly what the interpreter's push transport
 * sent — node started/completed/failed, in arrival order — never a fabricated
 * tool-call argument or result (neither is on the wire; see `WorkflowNodeEventPayload`'s
 * own doc comment). Mirrors `JobStreamPanel`'s event-log shape (frame 35 precedent).
 */
export function RunLiveActivity({ status, events }: { status: StreamStatus; events: RunLiveEvent[] }) {
  if (status === 'idle') return null;
  const meta = STREAM_STATUS_META[status];
  const recent = events.slice(-8).reverse();

  return (
    <section aria-label="Live run activity" className="flex flex-col gap-1.5 rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <IconActivity aria-hidden className="text-muted-foreground size-4" />
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Live activity</h3>
        <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />
      </div>
      {recent.length === 0 ? (
        <p className="text-muted-foreground text-xs">No control events received yet on this connection.</p>
      ) : (
        <ol aria-label="Recent run events, newest first" className="flex max-h-32 flex-col gap-1 overflow-y-auto">
          {recent.map((event, index) => (
            <li key={`${event.type}-${event.occurredAt}-${index}`} className="flex items-center gap-1.5 text-xs">
              <IconTool aria-hidden className="text-muted-foreground size-3 shrink-0" />
              <span className="truncate">{eventLabel(event)}</span>
              <span className="text-muted-foreground ml-auto shrink-0 font-mono" title={formatDateTime(event.occurredAt)}>
                {formatRelativeTime(event.occurredAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
