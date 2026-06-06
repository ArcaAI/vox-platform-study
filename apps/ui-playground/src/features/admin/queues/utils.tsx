import { AdminApiError } from '../api/admin-client';
import { Badge } from '@arcaai/ui/badge';
import { cn } from '@/lib/utils';
import { AlertCircle } from 'lucide-react';

// Shared presentational helpers for the OB-03 Queues & Jobs surface. Kept in
// one module so the queue / jobs / scheduler tabs render identically.

export function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong while loading data.';
}

export function InlineError({ error }: { error: unknown }) {
  return (
    <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-md border p-3 text-sm">
      <AlertCircle className="size-4 shrink-0" />
      <span>{errorMessage(error)}</span>
    </div>
  );
}

/** Epoch-millis timestamp (BullMQ job fields) → locale string. */
export function formatTimestamp(ms?: number | null): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

/** ISO datetime string (scheduler run fields) → locale string. */
export function formatIso(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export function shortId(id?: string | null): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 12)}\u2026` : id;
}

const JOB_STATUS_STYLES: Record<string, string> = {
  waiting: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  active: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-400',
  delayed: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  paused: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
  prioritized: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400',
};

export function JobStatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={cn('text-xs', JOB_STATUS_STYLES[status.toLowerCase()] ?? '')}>
      {status}
    </Badge>
  );
}

export function QueueStateBadge({ isPaused }: { isPaused: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-xs',
        isPaused ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
      )}
    >
      {isPaused ? 'Paused' : 'Active'}
    </Badge>
  );
}
