import { Badge } from '@arcaai/ui/components/shadcn/badge';
import type { CheckpointStatus, RestoreStatus, TenantCheckpoint } from '../api/types';

const CHECKPOINT_LABELS: Record<CheckpointStatus, string> = {
  PENDING: 'Pending',
  UPLOADING: 'Uploading',
  RUNNING: 'Running',
  READY: 'Ready',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

/** Human progress text for a running checkpoint, e.g. "export 3/12 tables". */
export function progressText(progress: TenantCheckpoint['progress']): string | null {
  if (!progress) return null;
  const phase = progress.phase.toLowerCase().replaceAll('_', ' ');
  return progress.tablesTotal > 0 ? `${phase} ${progress.tablesDone}/${progress.tablesTotal} tables` : phase;
}

export function CheckpointStatusBadge({ checkpoint }: { checkpoint: TenantCheckpoint }) {
  const { status } = checkpoint;
  if (status === 'READY') return <Badge>{CHECKPOINT_LABELS.READY}</Badge>;
  if (status === 'FAILED') return <Badge variant="destructive">{CHECKPOINT_LABELS.FAILED}</Badge>;
  if (status === 'CANCELLED') return <Badge variant="outline">{CHECKPOINT_LABELS.CANCELLED}</Badge>;
  const text = progressText(checkpoint.progress);
  return (
    <span className="flex items-center gap-2">
      <Badge variant="secondary">{CHECKPOINT_LABELS[status]}</Badge>
      {text ? <span className="text-muted-foreground text-xs">{text}</span> : null}
    </span>
  );
}

const RESTORE_LABELS: Record<RestoreStatus, string> = {
  PENDING: 'Pending',
  LOCKING: 'Locking tenant',
  SAFETY_CHECKPOINT: 'Safety checkpoint',
  VERIFYING: 'Verifying',
  RECONCILING: 'Restoring',
  POST_COMMIT: 'Finishing',
  COMPLETED: 'Completed',
  COMPLETED_WITH_WARNINGS: 'Completed with warnings',
  FAILED: 'Failed',
};

export function RestoreStatusBadge({ status }: { status: RestoreStatus }) {
  if (status === 'COMPLETED') return <Badge>{RESTORE_LABELS[status]}</Badge>;
  if (status === 'FAILED') return <Badge variant="destructive">{RESTORE_LABELS[status]}</Badge>;
  return <Badge variant="secondary">{RESTORE_LABELS[status]}</Badge>;
}
