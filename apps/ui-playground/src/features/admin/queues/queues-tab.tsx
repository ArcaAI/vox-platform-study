import { useState } from 'react';
import { toast } from 'sonner';
import { useCleanQueue, usePauseQueue, useQueues, useResumeQueue, CLEANABLE_STATUSES, type CleanableStatus, type QueueStats } from './api/queues';
import { QueueJobsPanel } from './queue-jobs-panel';
import { InlineError, QueueStateBadge, errorMessage } from './utils';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent } from '@arcaai/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { cn } from '@/lib/utils';
import { Eraser, Inbox, ListChecks, Pause, Play, RefreshCw, X } from 'lucide-react';

const COUNT_COLUMNS = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'active', label: 'Active' },
  { key: 'delayed', label: 'Delayed' },
  { key: 'failed', label: 'Failed' },
  { key: 'completed', label: 'Completed' },
] as const;

const DEFAULT_GRACE_MS = 86_400_000; // 24h

export function QueuesTab() {
  const { data: queues, isLoading, isError, error, isFetching, refetch } = useQueues({ refetchInterval: 15_000 });
  const pause = usePauseQueue();
  const resume = useResumeQueue();
  const clean = useCleanQueue();

  const [selected, setSelected] = useState('');
  const [cleanTarget, setCleanTarget] = useState('');
  const [cleanStatus, setCleanStatus] = useState<CleanableStatus>('completed');
  const [graceDraft, setGraceDraft] = useState(String(DEFAULT_GRACE_MS));

  const togglePause = (q: QueueStats) => {
    const action = q.isPaused ? resume : pause;
    action.mutate(q.name, {
      onSuccess: () => toast.success(`${q.isPaused ? 'Resumed' : 'Paused'} "${q.name}"`),
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  const openClean = (name: string) => {
    setCleanTarget(name);
    setCleanStatus('completed');
    setGraceDraft(String(DEFAULT_GRACE_MS));
  };

  const confirmClean = () => {
    const grace = Number(graceDraft);
    if (!Number.isFinite(grace) || grace < 0) {
      toast.error('Grace period must be a non-negative number of milliseconds.');
      return;
    }
    clean.mutate(
      { queueName: cleanTarget, status: cleanStatus, gracePeriodMs: grace },
      {
        onSuccess: (res) => {
          toast.success(`Cleaned ${res.count} ${cleanStatus} job(s) from "${cleanTarget}"`);
          setCleanTarget('');
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={cn('mr-1.5 size-3.5', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-3/4" />
        </div>
      ) : isError ? (
        <InlineError error={error} />
      ) : !queues || queues.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <Inbox className="text-muted-foreground size-8" />
            <p className="text-muted-foreground text-sm">No queues registered.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Workers</TableHead>
                {COUNT_COLUMNS.map((c) => (
                  <TableHead key={c.key} className="text-right">
                    {c.label}
                  </TableHead>
                ))}
                <TableHead className="w-40 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queues.map((q) => (
                <TableRow
                  key={q.name}
                  data-state={selected === q.name ? 'selected' : undefined}
                  className="cursor-pointer"
                  onClick={() => setSelected((prev) => (prev === q.name ? '' : q.name))}
                >
                  <TableCell className="font-medium">{q.name}</TableCell>
                  <TableCell>
                    <QueueStateBadge isPaused={q.isPaused} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{q.workerCount}</TableCell>
                  {COUNT_COLUMNS.map((c) => (
                    <TableCell key={c.key} className="text-right tabular-nums">
                      {q.counts[c.key]}
                    </TableCell>
                  ))}
                  <TableCell>
                    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="size-7" title={q.isPaused ? 'Resume' : 'Pause'} onClick={() => togglePause(q)}>
                        {q.isPaused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7" title="Clean finished jobs" onClick={() => openClean(q.name)}>
                        <Eraser className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        title="View jobs"
                        onClick={() => setSelected((prev) => (prev === q.name ? '' : q.name))}
                      >
                        <ListChecks className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {selected && (
        <Card>
          <CardContent className="pt-6">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium">
                Jobs in <span className="font-mono">{selected}</span>
              </h3>
              <Button variant="ghost" size="sm" onClick={() => setSelected('')}>
                <X className="mr-1 size-3.5" />
                Close
              </Button>
            </div>
            <QueueJobsPanel key={selected} queueName={selected} />
          </CardContent>
        </Card>
      )}

      {/* Clean queue — destructive: removes finished jobs */}
      <Dialog open={!!cleanTarget} onOpenChange={(open) => !open && setCleanTarget('')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clean &quot;{cleanTarget}&quot;</DialogTitle>
            <DialogDescription>
              Permanently remove finished jobs older than the grace period. This is destructive and cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="clean-status">Status to clean</Label>
              <Select value={cleanStatus} onValueChange={(v: string) => setCleanStatus(v as CleanableStatus)}>
                <SelectTrigger id="clean-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLEANABLE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="clean-grace">Grace period (milliseconds)</Label>
              <Input id="clean-grace" type="number" min={0} value={graceDraft} onChange={(e) => setGraceDraft(e.target.value)} />
              <p className="text-muted-foreground text-xs">Only jobs finished more than this many ms ago are removed (default 24h).</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCleanTarget('')} disabled={clean.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmClean} disabled={clean.isPending}>
              Clean
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
