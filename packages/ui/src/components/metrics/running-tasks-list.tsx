'use client';

import type * as React from 'react';
import { formatDistanceToNow } from 'date-fns';

import { ItemList } from '@/components/collection/item-list';
import { Progress } from '@/components/shadcn/progress';
import type { StatusColorRole } from '@/components/shared/status-badge';
import type { AsyncStateProps, BaseSurfaceProps } from '@/lib/shared';
import { cn } from '@/lib/utils';

import { StatusDot } from './status-dot';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface RunningTask {
  id: string;
  name: string;
  status: TaskStatus;
  /** 0–100 — renders a `Progress` bar when present. */
  progress?: number;
  /** Rendered as relative time via `date-fns formatDistanceToNow`. */
  updatedAt?: Date | string | number;
}

export interface RunningTasksListProps extends BaseSurfaceProps, AsyncStateProps {
  tasks: RunningTask[];
  'aria-label'?: string;
}

const TASK_META: Record<TaskStatus, { role: StatusColorRole; label: string; pulse?: boolean }> = {
  queued: { role: 'neutral', label: 'Queued' },
  running: { role: 'info', label: 'Running', pulse: true },
  succeeded: { role: 'success', label: 'Succeeded' },
  failed: { role: 'destructive', label: 'Failed' },
  canceled: { role: 'warning', label: 'Canceled' },
};

function relativeTime(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * Recent-activity / running-tasks list — a preset over the
 * `ItemList` foundation. Each row is `StatusDot` + name + `font-mono` id +
 * optional `Progress` + relative timestamp. Loading/empty/error are delegated to
 * `ItemList`'s `AsyncStateProps` contract. Presentational: feed `tasks` from a job
 * hook (e.g. `useMonitoring`/`useAsyncJobs`).
 */
export function RunningTasksList({
  tasks,
  density = 'comfortable',
  className,
  isLoading,
  error,
  emptyState,
  errorState,
  loadingState,
  ...props
}: RunningTasksListProps) {
  const ariaLabel = props['aria-label'] ?? 'Running tasks';

  const renderRow = (task: RunningTask): React.ReactNode => {
    const meta = TASK_META[task.status] ?? TASK_META.queued;
    return (
      <>
        <StatusDot colorRole={meta.role} pulse={meta.pulse} aria-label={meta.label} />
        <span className="min-w-0 flex-1 truncate font-medium">{task.name}</span>
        <span data-slot="task-id" className="font-mono text-xs text-muted-foreground">
          {task.id}
        </span>
        {task.progress != null ? (
          // The shadcn Progress doesn't forward `value` to the Radix root, so expose the
          // value to AT explicitly (it otherwise reports as an indeterminate progressbar).
          <Progress
            value={task.progress}
            aria-label={`${task.name} progress`}
            aria-valuenow={task.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            className={cn('w-24', density === 'compact' && 'w-16')}
          />
        ) : null}
        {task.updatedAt != null ? (
          <time data-slot="task-updated" className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {relativeTime(task.updatedAt)}
          </time>
        ) : null}
      </>
    );
  };

  return (
    <ItemList
      items={tasks}
      getItemId={(t) => t.id}
      renderRow={renderRow}
      density={density}
      className={className}
      isLoading={isLoading}
      error={error}
      emptyState={emptyState}
      errorState={errorState}
      loadingState={loadingState}
      aria-label={ariaLabel}
    />
  );
}
