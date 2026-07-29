'use client';

import { IconClipboardCheck } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useGateQueue } from '../api';

/** Gate queue: consultations awaiting clinician review with SLA/escalation state. */
export function GateQueuePanel() {
  const query = useGateQueue(true);

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-hidden>
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.error || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const queue = query.data;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary" className="tabular-nums">
          {queue.total} pending
        </Badge>
        <Badge variant={queue.slaBreachedCount > 0 ? 'destructive' : 'outline'} className="tabular-nums">
          {queue.slaBreachedCount} SLA breached
        </Badge>
        <Badge variant={queue.escalatedCount > 0 ? 'destructive' : 'outline'} className="tabular-nums">
          {queue.escalatedCount} escalated
        </Badge>
        <span className="text-muted-foreground font-mono">
          SLA {queue.gateSlaSeconds}s &middot; escalate {queue.gateEscalationSeconds}s &middot; {queue.policySource}
        </span>
      </div>
      {queue.items.length === 0 ? (
        <EmptyState icon={IconClipboardCheck} title="Gate queue is clear" description="No consultations are awaiting clinician review." />
      ) : (
        <div className="rounded-md border">
          <Table aria-label="Gate queue">
            <TableHeader>
              <TableRow>
                <TableHead className="font-mono text-xs">Consultation</TableHead>
                <TableHead className="font-mono text-xs">Status</TableHead>
                <TableHead className="font-mono text-xs">Pending</TableHead>
                <TableHead className="font-mono text-xs">Regen</TableHead>
                <TableHead className="font-mono text-xs">SLA</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queue.items.map((item) => (
                <TableRow key={item.consultationId}>
                  <TableCell className="font-mono text-xs">{item.consultationId}</TableCell>
                  <TableCell className="text-xs">{item.status}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{formatRelativeTime(item.pendingSince)}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {item.generateCount}/{item.regenCount}
                  </TableCell>
                  <TableCell>
                    {item.escalated ? (
                      <Badge variant="destructive" className="text-[10px]">
                        escalated
                      </Badge>
                    ) : item.slaBreached ? (
                      <Badge variant="destructive" className="text-[10px]">
                        breached
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        on track
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
