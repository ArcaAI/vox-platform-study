import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '../components';
import {
  usePauseScheduler,
  useResumeScheduler,
  useSchedulers,
  useToggleScheduler,
  useUpdateSchedulerCron,
  type SchedulerInfo,
} from './api/schedulers';
import { InlineError, errorMessage, formatIso } from './utils';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent } from '@arcaai/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { cn } from '@/lib/utils';
import { Inbox, Pause, Pencil, Play, RefreshCw } from 'lucide-react';

/** A 5- or 6-field cron expression (very light client check; server validates fully). */
function looksLikeCron(value: string): boolean {
  const parts = value.trim().split(/\s+/);
  return parts.length === 5 || parts.length === 6;
}

function schedule(s: SchedulerInfo): string {
  if (s.cronExpression) return s.cronExpression;
  if (s.intervalMs != null) return `every ${s.intervalMs} ms`;
  return '—';
}

export function SchedulersTab() {
  const { data: schedulers, isLoading, isError, error, isFetching, refetch } = useSchedulers({ refetchInterval: 15_000 });
  const pause = usePauseScheduler();
  const resume = useResumeScheduler();
  const updateCron = useUpdateSchedulerCron();
  const toggle = useToggleScheduler();

  const [cronTarget, setCronTarget] = useState<SchedulerInfo | null>(null);
  const [cronDraft, setCronDraft] = useState('');
  const [toggleTarget, setToggleTarget] = useState<SchedulerInfo | null>(null);

  const togglePause = (s: SchedulerInfo) => {
    const action = s.running ? pause : resume;
    action.mutate(s.name, {
      onSuccess: () => toast.success(`${s.running ? 'Paused' : 'Resumed'} "${s.name}"`),
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  const openCron = (s: SchedulerInfo) => {
    setCronTarget(s);
    setCronDraft(s.cronExpression ?? '');
  };

  const saveCron = () => {
    if (!cronTarget) return;
    const next = cronDraft.trim();
    if (!looksLikeCron(next)) {
      toast.error('Enter a valid 5- or 6-field cron expression (e.g. "0 2 * * *").');
      return;
    }
    updateCron.mutate(
      { name: cronTarget.name, cronExpression: next },
      {
        onSuccess: () => {
          toast.success(`Updated cron for "${cronTarget.name}"`);
          setCronTarget(null);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  const confirmToggle = () => {
    if (!toggleTarget) return;
    const next = !toggleTarget.running;
    toggle.mutate(
      { name: toggleTarget.name, enabled: next },
      {
        onSuccess: () => toast.success(`${next ? 'Enabled' : 'Disabled'} "${toggleTarget.name}"`),
        onError: (e) => toast.error(errorMessage(e)),
        onSettled: () => setToggleTarget(null),
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
        </div>
      ) : isError ? (
        <InlineError error={error} />
      ) : !schedulers || schedulers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <Inbox className="text-muted-foreground size-8" />
            <p className="text-muted-foreground text-sm">No schedulers registered.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scheduler</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead className="w-48 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedulers.map((s) => {
                const isDynamic = s.source === 'dynamic';
                return (
                  <TableRow key={s.name}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px] uppercase',
                          isDynamic ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400' : 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
                        )}
                      >
                        {s.source}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{schedule(s)}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-xs',
                          s.running ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
                        )}
                      >
                        {s.running ? 'Running' : 'Stopped'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatIso(s.lastExecution)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatIso(s.nextExecution)}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="icon" className="size-7" title={s.running ? 'Pause' : 'Resume'} onClick={() => togglePause(s)}>
                          {s.running ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                        </Button>
                        {isDynamic ? (
                          <>
                            <Button variant="ghost" size="icon" className="size-7" title="Edit cron" onClick={() => openCron(s)}>
                              <Pencil className="size-3.5" />
                            </Button>
                            <Switch
                              checked={s.running}
                              disabled={toggle.isPending}
                              onCheckedChange={() => setToggleTarget(s)}
                              aria-label="Enable scheduler"
                            />
                          </>
                        ) : (
                          <span className="text-muted-foreground text-xs">static</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Edit cron — dynamic schedulers only */}
      <Dialog open={cronTarget !== null} onOpenChange={(open) => !open && setCronTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit cron for &quot;{cronTarget?.name}&quot;</DialogTitle>
            <DialogDescription>Enter a 5- or 6-field cron expression. The change is validated and persisted server-side.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-2">
            <Label htmlFor="cron-expr">Cron expression</Label>
            <Input
              id="cron-expr"
              value={cronDraft}
              onChange={(e) => setCronDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveCron()}
              placeholder="0 2 * * *"
              className="font-mono"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCronTarget(null)} disabled={updateCron.isPending}>
              Cancel
            </Button>
            <Button onClick={saveCron} disabled={updateCron.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Enable/disable toggle — destructive kill-switch */}
      <ConfirmDialog
        open={toggleTarget !== null}
        onOpenChange={(open) => !open && setToggleTarget(null)}
        title={toggleTarget?.running ? 'Disable scheduler?' : 'Enable scheduler?'}
        description={
          toggleTarget?.running
            ? `Disable "${toggleTarget?.name}". It will stop running on its schedule until re-enabled.`
            : `Enable "${toggleTarget?.name}" so it resumes running on its schedule.`
        }
        confirmLabel={toggleTarget?.running ? 'Disable' : 'Enable'}
        variant={toggleTarget?.running ? 'destructive' : 'default'}
        isLoading={toggle.isPending}
        onConfirm={confirmToggle}
      />
    </div>
  );
}
