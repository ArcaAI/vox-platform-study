'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconPlayerPlay } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useDnaSchedule, useRunDnaSchedule, useUpdateDnaSchedule } from '../api';
import type { DnaSchedule, DnaScheduleSkipped } from '../api';

export const DEFAULT_DNA_CRON = '0 2 * * 1';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Human hint for the common 5-field shapes (`m h * * dow` weekly, `m h * * *` daily).
 * Anything else is described as custom — the server stays the validator.
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return 'Not a 5-field cron expression';
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || dayOfMonth !== '*' || month !== '*') return 'Custom schedule';
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return 'Not a valid time';
  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (dayOfWeek === '*') return `Every day at ${time}`;
  if (/^[0-7]$/.test(dayOfWeek)) return `Every ${DAYS[Number(dayOfWeek) % 7]} at ${time}`;
  return 'Custom schedule';
}

export function skippedTotal(skipped: DnaScheduleSkipped): number {
  return skipped.noFeedback + skipped.optedOut + skipped.quota + skipped.belowFloor;
}

function SkippedBreakdown({ skipped }: { skipped: DnaScheduleSkipped }) {
  return (
    <span>
      no feedback {skipped.noFeedback} {'·'} opted out {skipped.optedOut} {'·'} quota {skipped.quota} {'·'} below floor {skipped.belowFloor}
    </span>
  );
}

/** Weekly feedback-gated regeneration settings for this tenant (+ "Run now"). */
export function ScheduleTab() {
  const schedule = useDnaSchedule();
  if (schedule.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (schedule.isError || !schedule.data) {
    return <ErrorState title={'Couldn’t load the regeneration schedule'} error={schedule.error} onRetry={() => void schedule.refetch()} />;
  }
  // Keyed by the loaded values so the form re-seeds after a save or a background refresh.
  return <ScheduleForm key={`${schedule.data.enabled}|${schedule.data.cron}|${schedule.data.minNewSamples}`} schedule={schedule.data} />;
}

function ScheduleForm({ schedule }: { schedule: DnaSchedule }) {
  const update = useUpdateDnaSchedule();
  const run = useRunDnaSchedule();
  const enabledId = useId();
  const cronId = useId();
  const minId = useId();
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [cron, setCron] = useState(schedule.cron || DEFAULT_DNA_CRON);
  const [minNewSamples, setMinNewSamples] = useState(String(schedule.minNewSamples));
  const [confirmRun, setConfirmRun] = useState(false);

  const minValue = Number(minNewSamples);
  const minInvalid = !Number.isInteger(minValue) || minValue < 1;
  const cronInvalid = cron.trim().split(/\s+/).length !== 5;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (minInvalid || cronInvalid) return;
    update.mutate(
      { enabled, cron: cron.trim(), minNewSamples: minValue },
      {
        onSuccess: () => toast.success('Schedule saved'),
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not save the schedule.'),
      },
    );
  }

  async function handleRun() {
    try {
      const result = await run.mutateAsync();
      toast.success(`Regeneration run: ${formatNumber(result.queued)} queued, ${formatNumber(skippedTotal(result.skipped))} skipped`);
      setConfirmRun(false);
    } catch (error) {
      toast.error(error instanceof GatewayError ? error.message : 'Could not start the regeneration run.');
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium">Weekly regeneration</h2>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
            <div className="flex items-center gap-3">
              <Switch id={enabledId} checked={enabled} onCheckedChange={setEnabled} aria-label="Regeneration enabled" />
              <Label htmlFor={enabledId}>Regeneration enabled</Label>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={cronId}>Cron expression *</Label>
              <Input
                id={cronId}
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                className="font-mono"
                aria-describedby={`${cronId}-hint`}
              />
              <p id={`${cronId}-hint`} className={cronInvalid ? 'text-destructive text-sm' : 'text-muted-foreground text-xs'}>
                {describeCron(cron)}
              </p>
              <p className="text-muted-foreground text-xs">
                Runs in the tenant time zone. Default: <span className="font-mono">{DEFAULT_DNA_CRON}</span> (every Monday at 02:00).
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={minId}>Minimum new samples *</Label>
              <Input
                id={minId}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={minNewSamples}
                onChange={(event) => setMinNewSamples(event.target.value)}
                aria-invalid={minInvalid || undefined}
              />
              {minInvalid ? (
                <p className="text-destructive text-sm">Enter a whole number of at least 1.</p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  A clinician is regenerated only with at least this much new feedback since the last report.
                </p>
              )}
            </div>
            <div>
              <Button type="submit" disabled={update.isPending || minInvalid || cronInvalid}>
                {update.isPending ? <Spinner /> : null}
                Save schedule
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium">Runs</h2>
          <CardAction>
            <Button variant="outline" onClick={() => setConfirmRun(true)}>
              <IconPlayerPlay aria-hidden />
              Run now
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Time zone</dt>
            <dd>{schedule.timeZone}</dd>
            <dt className="text-muted-foreground">Next run</dt>
            <dd>
              {schedule.nextRunAt ? `${new Date(schedule.nextRunAt).toLocaleString()} (${formatRelativeTime(schedule.nextRunAt)})` : 'Not scheduled'}
            </dd>
            <dt className="text-muted-foreground">Last run</dt>
            <dd>
              {schedule.lastRun ? (
                <span className="flex flex-col gap-1">
                  <span>
                    {formatRelativeTime(schedule.lastRun.at)} {'·'} {formatNumber(schedule.lastRun.queued)} queued
                  </span>
                  <span className="text-muted-foreground text-xs">
                    Skipped {formatNumber(skippedTotal(schedule.lastRun.skipped))}: <SkippedBreakdown skipped={schedule.lastRun.skipped} />
                  </span>
                </span>
              ) : (
                'Never run'
              )}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmRun}
        onOpenChange={setConfirmRun}
        title="Run regeneration now?"
        description="Queues a new DNA report for every clinician in this tenant with enough new feedback, using the current settings."
        confirmLabel="Run now"
        isPending={run.isPending}
        onConfirm={handleRun}
      />
    </div>
  );
}
